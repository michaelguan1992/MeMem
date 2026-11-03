'use strict';

import {
  DISPLAY_EDGE,
  TEXT,
  THUMB_EDGE,
  checkOriginalSize,
  controlsFor,
  currentWall,
  derivativesOf,
  displayNameOf,
  doneOf,
  draftFor,
  entryBody,
  entryContent,
  failureMessage,
  fitEdges,
  groupRelated,
  hexOf,
  isMissingWords,
  linkBody,
  loadAllRelated,
  mediaPath,
  messageOf,
  needsLink,
  occurredAtOf,
  pendingNotice,
  pendingOf,
  photoForm,
  photoOutcome,
  prefillFrom,
  requestPlan,
  statusClassOf,
  takenAtOf,
  thumbPath,
} from './capture-logic.ts';
import type {
  Clock,
  CreatedEntry,
  Derivatives,
  Draft,
  EntryBody,
  MediaEnvelope,
  Phase,
  Prefill,
  RelatedGroup,
  RelatedItem,
  RelatedPage,
  RequestPlan,
  Size,
  UploadResult,
} from './capture-logic.ts';

/**
 * Browser script for the /capture page, served as /capture.js (no inline script is allowed by the page policy).
 * scripts/build-client.mjs bundles this file with ./capture-logic.ts and ./exif.ts into src/generated/capture-script.ts.
 * Every value from the server or from a photo is written with textContent. The script never uses innerHTML,
 * insertAdjacentHTML, document.write or eval. This file holds the DOM work; the logic it calls is in capture-logic.ts.
 */

const JPEG_QUALITY = 0.85;

interface QueueItem {
  file: File;
  url: string;
  done: boolean;
  mediaId: string | null;
  message: string;
  row: HTMLLIElement;
  status: HTMLSpanElement;
}

interface CaptureState {
  busy: boolean;
  memoryId: string | null;
  /** The entry's client-chosen ID and the request content it was minted for. */
  draft: Draft | null;
  exifOffset: string | null;
  queue: QueueItem[];
  prefillRun: number;
}

interface CaptureElements {
  form: HTMLFormElement;
  textInput: HTMLTextAreaElement;
  whenInput: HTMLInputElement;
  photosInput: HTMLInputElement;
  photoList: HTMLUListElement;
  relatedFieldset: HTMLFieldSetElement;
  relatedList: HTMLDivElement;
  saveButton: HTMLButtonElement;
  statusLine: HTMLParagraphElement;
  savedPhotos: HTMLDivElement;
}

/** Everything one page instance reads or writes: its element references, the CSRF token and its state. */
interface CapturePage {
  els: CaptureElements;
  csrf: string;
  state: CaptureState;
}

const browserClock: Clock = {
  now: () => new Date(),
  offsetAt: (instant) => -instant.getTimezoneOffset(),
  localInstant: (year, monthIndex, day, hour, minute) => new Date(year, monthIndex, day, hour, minute),
};

const newId = (): string => crypto.randomUUID();

function startCapturePage(): void {
  const form = document.getElementById('capture-form') as HTMLFormElement | null;
  const csrfMeta = document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]');
  if (!form || !csrfMeta) return;
  // memoryId is set once the entry exists, so a retry of failed photos never creates a second entry.
  // draft holds the entry's client-chosen ID. A retry with the same content resends it, so the server replays the entry;
  // changed content gets a new ID, because the server refuses to replay an ID with different content.
  const page: CapturePage = {
    els: findElements(form),
    csrf: csrfTokenOf(csrfMeta),
    state: { busy: false, memoryId: null, draft: null, exifOffset: null, queue: [], prefillRun: 0 },
  };
  page.els.photosInput.addEventListener('change', () => { onPhotosChanged(page); });
  page.els.form.addEventListener('submit', (event) => { onSubmit(page, event); });
  page.els.whenInput.value = currentWall(browserClock);
  applyLocks(page);
  loadRelated(page)
    .then((items) => { renderRelated(page, items); })
    .catch((error: unknown) => { page.els.relatedList.textContent = TEXT.relatedFailed + messageOf(error); });
}

function csrfTokenOf(meta: HTMLMetaElement): string {
  return meta.getAttribute('content') || '';
}

function findElements(form: HTMLFormElement): CaptureElements {
  return {
    form,
    textInput: document.getElementById('entry-text') as HTMLTextAreaElement,
    whenInput: document.getElementById('entry-when') as HTMLInputElement,
    photosInput: document.getElementById('entry-photos') as HTMLInputElement,
    photoList: document.getElementById('photo-list') as HTMLUListElement,
    relatedFieldset: document.getElementById('related') as HTMLFieldSetElement,
    relatedList: document.getElementById('related-list') as HTMLDivElement,
    saveButton: document.getElementById('save-button') as HTMLButtonElement,
    statusLine: document.getElementById('status') as HTMLParagraphElement,
    savedPhotos: document.getElementById('saved-photos') as HTMLDivElement,
  };
}

function showStatus(page: CapturePage, message: string, isError: boolean): void {
  page.els.statusLine.textContent = message;
  page.els.statusLine.className = statusClassOf(isError);
}

function setItem(item: QueueItem, phase: Phase, text: string): void {
  item.row.dataset.state = phase;
  item.status.textContent = text;
}

// The time comes from the first JPEG that has an EXIF time; otherwise the field shows the current local time.
function prefillTime(page: CapturePage, files: File[]): Promise<void> {
  const run = ++page.state.prefillRun;
  return prefillFrom(files, browserClock, (found) => { applyPrefill(page, run, found); });
}

function applyPrefill(page: CapturePage, run: number, found: Prefill): void {
  if (run !== page.state.prefillRun) return; // a newer photo selection has replaced this one
  page.els.whenInput.value = found.wall || currentWall(browserClock);
  page.state.exifOffset = found.offset;
}

function onPhotosChanged(page: CapturePage): void {
  const files = Array.from(page.els.photosInput.files ?? []);
  clearPhotos(page);
  files.forEach((file) => { addPhoto(page, file); });
  prefillTime(page, files).catch(() => {
    page.els.whenInput.value = currentWall(browserClock);
    page.state.exifOffset = null;
  });
}

function clearPhotos(page: CapturePage): void {
  page.state.queue.forEach((item) => { URL.revokeObjectURL(item.url); });
  page.state.queue = [];
  page.els.photoList.textContent = '';
}

function addPhoto(page: CapturePage, file: File): void {
  const item: QueueItem = {
    file,
    url: URL.createObjectURL(file),
    done: false,
    mediaId: null,
    message: '',
    row: document.createElement('li'),
    status: document.createElement('span'),
  };
  const preview = document.createElement('img');
  preview.alt = '';
  preview.src = item.url;
  preview.addEventListener('error', () => { preview.alt = TEXT.noPreview; });
  const text = document.createElement('div');
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = displayNameOf(file);
  item.status.className = 'status';
  text.appendChild(name);
  text.appendChild(item.status);
  item.row.className = 'photo';
  item.row.appendChild(preview);
  item.row.appendChild(text);
  page.els.photoList.appendChild(item.row);
  setItem(item, 'waiting', TEXT.waiting);
  page.state.queue.push(item);
}

function applyLocks(page: CapturePage): void {
  const { els, state } = page;
  const locks = controlsFor(state.busy, state.memoryId);
  els.textInput.disabled = locks.entryLocked;
  els.whenInput.disabled = locks.entryLocked;
  els.relatedFieldset.disabled = locks.entryLocked;
  els.photosInput.disabled = locks.entryLocked;
  els.saveButton.disabled = locks.saveDisabled;
  els.saveButton.textContent = locks.saveLabel;
}

function setBusy(page: CapturePage, flag: boolean): void {
  page.state.busy = flag;
  applyLocks(page);
}

// Same-origin JSON or multipart request. Non-GET requests carry the CSRF token from the page.
async function api<T>(page: CapturePage, method: string, path: string, body?: FormData | object): Promise<T> {
  const plan: RequestPlan = requestPlan(method, page.csrf, body);
  let response: Response;
  try {
    response = await fetch(path, plan);
  } catch {
    throw new Error(TEXT.unreachable);
  }
  let data: unknown = null;
  try { data = await response.json(); } catch { data = null; }
  return successOrThrow<T>(response.status, data);
}

function successOrThrow<T>(status: number, data: unknown): T {
  const problem = failureMessage(status, data);
  if (problem !== null) throw new Error(problem);
  return data as T;
}

function loadRelated(page: CapturePage): Promise<RelatedItem[]> {
  return loadAllRelated((path) => api<RelatedPage>(page, 'GET', path));
}

function renderRelated(page: CapturePage, items: RelatedItem[]): void {
  const list = page.els.relatedList;
  list.textContent = '';
  const groups = groupRelated(items);
  if (groups.length === 0) {
    list.textContent = TEXT.noPeopleOrPlaces;
    return;
  }
  groups.forEach((group) => { appendGroup(list, group); });
}

function appendGroup(list: HTMLDivElement, group: RelatedGroup): void {
  const title = document.createElement('p');
  title.className = 'group-title';
  title.textContent = group.heading;
  list.appendChild(title);
  group.items.forEach((item) => { appendChoice(list, item); });
}

function appendChoice(list: HTMLDivElement, item: RelatedItem): void {
  const label = document.createElement('label');
  label.className = 'choice';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.value = item.id;
  const text = document.createElement('span');
  text.textContent = item.text;
  label.appendChild(box);
  label.appendChild(text);
  list.appendChild(label);
}

function checkedIds(page: CapturePage): string[] {
  return Array.from(page.els.relatedList.querySelectorAll<HTMLInputElement>('input[type=checkbox]:checked'), (box) => box.value);
}

// Display and thumbnail JPEGs with the decoded size, or null when this browser cannot decode the photo.
// A browser without createImageBitmap throws at the call, and such a photo gets no previews.
async function derivatives(file: File): Promise<Derivatives | null> {
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const display = await encodeJpeg(bitmap, fitEdges(bitmap.width, bitmap.height, DISPLAY_EDGE));
    const thumb = await encodeJpeg(bitmap, fitEdges(bitmap.width, bitmap.height, THUMB_EDGE));
    return derivativesOf(bitmap.width, bitmap.height, display, thumb);
  } catch {
    return null;
  } finally {
    if (bitmap !== null) closeBitmap(bitmap);
  }
}

// A JPEG of the bitmap at the given size, or null when this browser gives no 2D context.
function encodeJpeg(bitmap: ImageBitmap, size: Size): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (!context) return Promise.resolve(null);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise<Blob | null>((resolve) => { canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY); });
}

function closeBitmap(bitmap: ImageBitmap): void {
  if (typeof bitmap.close === 'function') bitmap.close();
}

async function uploadPhoto(page: CapturePage, item: QueueItem): Promise<void> {
  checkOriginalSize(item.file.size);
  setItem(item, 'working', TEXT.reading);
  const buffer = await item.file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const sha256 = hexOf(await crypto.subtle.digest('SHA-256', buffer));
  const taken = takenAtOf(bytes, browserClock);
  setItem(item, 'working', TEXT.previewing);
  const derived = await derivatives(item.file);
  const body = photoForm(item.file, sha256, taken, derived, page.state.memoryId);
  setItem(item, 'working', TEXT.uploading);
  const result = await api<UploadResult>(page, 'POST', '/api/media', body);
  let media = result.media;
  if (needsLink(result)) {
    setItem(item, 'working', TEXT.linking);
    // Both fields are required on every PATCH; the photo's current caption is sent back unchanged.
    const linked = await api<MediaEnvelope>(page, 'PATCH', mediaPath(result.media.id), linkBody(result.media, page.state.memoryId));
    media = linked.media;
  }
  item.mediaId = media.id;
  item.done = true;
  item.message = photoOutcome({ duplicate: result.duplicate, mediaMemoryId: media.memoryId, entryMemoryId: page.state.memoryId, derived });
  setItem(item, 'saved', item.message);
}

function finishSave(page: CapturePage): void {
  const saved = doneOf(page.state.queue);
  clearPhotos(page);
  resetEntry(page);
  page.els.savedPhotos.textContent = '';
  saved.forEach((item) => { appendSavedPhoto(page.els.savedPhotos, item); });
  showStatus(page, TEXT.saved, false);
}

// Clears the entry fields for the next entry. The photos are cleared by the caller.
function resetEntry(page: CapturePage): void {
  const { els, state } = page;
  state.memoryId = null;
  state.draft = null;
  state.exifOffset = null;
  els.textInput.value = '';
  els.photosInput.value = '';
  els.whenInput.value = currentWall(browserClock);
  els.relatedList.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach((box) => { box.checked = false; });
}

function appendSavedPhoto(container: HTMLDivElement, item: QueueItem): void {
  const figure = document.createElement('figure');
  const thumb = document.createElement('img');
  thumb.width = 96;
  thumb.height = 96;
  thumb.alt = TEXT.savedPhotoAlt;
  thumb.src = thumbPath(item.mediaId);
  thumb.addEventListener('error', () => { thumb.alt = TEXT.savedNoPreviewAlt; });
  const caption = document.createElement('figcaption');
  caption.textContent = item.message;
  figure.appendChild(thumb);
  figure.appendChild(caption);
  container.appendChild(figure);
}

// Empty text with no entry yet is refused before anything is sent. Returns true when it was refused.
function refuseMissingWords(page: CapturePage, text: string): boolean {
  if (!isMissingWords(page.state.memoryId, text)) return false;
  showStatus(page, TEXT.needWords, true);
  page.els.textInput.focus();
  return true;
}

// The POST /api/entries body for this save. It sets the draft, which stays the same while the content is unchanged.
function prepareEntry(page: CapturePage, text: string): EntryBody {
  const occurredAt = occurredAtOf(page.els.whenInput.value, page.state.exifOffset, browserClock);
  const content = entryContent(text, occurredAt, checkedIds(page));
  const draft = draftFor(page.state.draft, content, newId);
  page.state.draft = draft;
  return entryBody(draft, content);
}

// Uploads each photo that is not saved yet, in order. A photo that fails is marked failed, and the rest still upload.
async function uploadPending(page: CapturePage): Promise<void> {
  for (const item of pendingOf(page.state.queue)) {
    try {
      await uploadPhoto(page, item);
    } catch (error) {
      setItem(item, 'failed', messageOf(error));
    }
  }
}

// After the photo pass: the status names the photos still waiting, or the save is finished.
function reportPending(page: CapturePage): void {
  const notice = pendingNotice(pendingOf(page.state.queue).length);
  if (notice === null) finishSave(page);
  else showStatus(page, notice, true);
}

async function save(page: CapturePage, text: string): Promise<void> {
  setBusy(page, true);
  page.els.savedPhotos.textContent = '';
  showStatus(page, TEXT.saving, false);
  try {
    // memoryId is set once the entry exists, so a retry of failed photos never creates a second entry.
    if (page.state.memoryId === null) {
      const created = await api<CreatedEntry>(page, 'POST', '/api/entries', prepareEntry(page, text));
      page.state.memoryId = created.memory.id;
    }
    await uploadPending(page);
    reportPending(page);
  } catch (error) {
    showStatus(page, messageOf(error), true);
  } finally {
    setBusy(page, false);
  }
}

function onSubmit(page: CapturePage, event: Event): void {
  event.preventDefault();
  if (page.state.busy) return;
  const text = page.els.textInput.value.trim();
  if (refuseMissingWords(page, text)) return;
  save(page, text);
}

startCapturePage();
