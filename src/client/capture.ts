'use strict';

import { readJpegTakenAt } from './exif.ts';

/**
 * Browser script for the /capture page, served as /capture.js (no inline script is allowed by the page policy).
 * scripts/build-client.mjs bundles this file and ./exif.ts with esbuild into src/generated/capture-script.ts.
 * Every value from the server or from a photo is written with textContent. The script never uses innerHTML,
 * insertAdjacentHTML, document.write or eval.
 */

const DISPLAY_EDGE = 1600;
const THUMB_EDGE = 400;
const JPEG_QUALITY = 0.85;
const MAX_ORIGINAL_BYTES = 25 * 1024 * 1024;
const MAX_DISPLAY_BYTES = 5 * 1024 * 1024;
const MAX_THUMB_BYTES = 1024 * 1024;
const WALL_TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2})?$/;

type Phase = 'waiting' | 'working' | 'saved' | 'failed';

// The parts of the server's JSON that this page reads or sends back.
interface MediaRecord {
  id: string;
  memoryId: string | null;
  version: number;
  caption: string | null;
}

interface MediaEnvelope {
  media: MediaRecord;
}

interface UploadResult extends MediaEnvelope {
  duplicate: boolean;
}

interface CreatedEntry {
  memory: { id: string };
}

interface RelatedItem {
  id: string;
  kind: 'person' | 'place';
  text: string;
}

interface RelatedPage {
  items: RelatedItem[];
  nextAfterId: string | null;
}

interface EntryBody {
  text: string;
  occurredAt?: string;
  relatedIds?: string[];
}

interface Derivatives {
  width: number;
  height: number;
  display: Blob | null;
  thumb: Blob | null;
}

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
  exifOffset: string | null;
  queue: QueueItem[];
  prefillRun: number;
}

function pad2(value: number): string {
  return (value < 10 ? '0' : '') + value;
}

function nowWall(): string {
  const now = new Date();
  return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate())
    + 'T' + pad2(now.getHours()) + ':' + pad2(now.getMinutes());
}

function offsetText(minutes: number): string {
  const size = Math.abs(minutes);
  return (minutes < 0 ? '-' : '+') + pad2(Math.floor(size / 60)) + ':' + pad2(size % 60);
}

// Browser offset in minutes east of UTC for a local wall-clock time such as 2025-05-01T14:30.
function browserOffset(wall: string): number {
  const parts = wall.split(/[-T:]/);
  const local = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), Number(parts[3]), Number(parts[4]));
  return -local.getTimezoneOffset();
}

function hexOf(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let text = '';
  for (let i = 0; i < bytes.length; i++) text += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  return text;
}

function looksLikeJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Something went wrong. What you typed is still here; try again.';
}

// The `message` field of a JSON error body, when the body has one.
function errorMessageOf(data: unknown): unknown {
  return typeof data === 'object' && data !== null && 'message' in data ? data.message : undefined;
}

// Capture time of one JPEG as an ISO string with offset, or null. The second pass gives readJpegTakenAt the
// browser's offset for that date, which it uses only when the photo carries no OffsetTimeOriginal.
function takenAtOf(bytes: Uint8Array): string | null {
  const guess = readJpegTakenAt(bytes, -new Date().getTimezoneOffset());
  return guess === null ? null : readJpegTakenAt(bytes, browserOffset(guess.slice(0, 16)));
}

// The photo's own offset, or null. readJpegTakenAt returns its fallback only when the photo has no
// OffsetTimeOriginal, so two different fallbacks give the same string exactly when the offset is the photo's own.
function ownOffsetOf(bytes: Uint8Array): string | null {
  const asZero = readJpegTakenAt(bytes, 0);
  const asSixty = readJpegTakenAt(bytes, 60);
  return asZero !== null && asZero === asSixty ? asZero.slice(19) : null;
}

function setItem(item: QueueItem, phase: Phase, text: string): void {
  item.row.dataset.state = phase;
  item.status.textContent = text;
}

function encodeJpeg(bitmap: ImageBitmap, edge: number): Promise<Blob | null> {
  const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d');
  if (!context) return Promise.resolve(null);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise<Blob | null>((resolve) => { canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY); });
}

// Display and thumbnail JPEGs with the decoded size, or null when this browser cannot decode the photo.
async function derivatives(file: File): Promise<Derivatives | null> {
  if (typeof createImageBitmap !== 'function') return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return null;
  }
  try {
    const display = await encodeJpeg(bitmap, DISPLAY_EDGE);
    const thumb = await encodeJpeg(bitmap, THUMB_EDGE);
    return {
      width: bitmap.width,
      height: bitmap.height,
      display: display !== null && display.size <= MAX_DISPLAY_BYTES ? display : null,
      thumb: thumb !== null && thumb.size <= MAX_THUMB_BYTES ? thumb : null,
    };
  } catch {
    return null;
  } finally {
    if (typeof bitmap.close === 'function') bitmap.close();
  }
}

function startCapturePage(): void {
  const form = document.getElementById('capture-form') as HTMLFormElement | null;
  const csrfMeta = document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]');
  if (!form || !csrfMeta) return;
  const csrf = csrfMeta.getAttribute('content') || '';
  const textInput = document.getElementById('entry-text') as HTMLTextAreaElement;
  const whenInput = document.getElementById('entry-when') as HTMLInputElement;
  const photosInput = document.getElementById('entry-photos') as HTMLInputElement;
  const photoList = document.getElementById('photo-list') as HTMLUListElement;
  const relatedFieldset = document.getElementById('related') as HTMLFieldSetElement;
  const relatedList = document.getElementById('related-list') as HTMLDivElement;
  const saveButton = document.getElementById('save-button') as HTMLButtonElement;
  const statusLine = document.getElementById('status') as HTMLParagraphElement;
  const savedPhotos = document.getElementById('saved-photos') as HTMLDivElement;

  // memoryId is set once the entry exists, so a retry of failed photos never creates a second entry.
  const state: CaptureState = { busy: false, memoryId: null, exifOffset: null, queue: [], prefillRun: 0 };

  function showStatus(message: string, isError: boolean): void {
    statusLine.textContent = message;
    statusLine.className = isError ? 'error' : '';
  }

  // The time comes from the first JPEG that has an EXIF time; otherwise the field shows the current local time.
  async function prefillTime(files: File[]): Promise<void> {
    const run = ++state.prefillRun;
    let wall: string | null = null;
    let offset: string | null = null;
    for (let i = 0; i < files.length; i++) {
      const head = new Uint8Array(await files[i].slice(0, 3).arrayBuffer());
      if (!looksLikeJpeg(head)) continue;
      const bytes = new Uint8Array(await files[i].arrayBuffer());
      const taken = takenAtOf(bytes);
      if (taken !== null) {
        wall = taken.slice(0, 16);
        offset = ownOffsetOf(bytes);
      }
      break;
    }
    if (run !== state.prefillRun) return; // a newer photo selection has replaced this one
    whenInput.value = wall || nowWall();
    state.exifOffset = offset;
  }

  function clearPhotos(): void {
    state.queue.forEach((item) => { URL.revokeObjectURL(item.url); });
    state.queue = [];
    photoList.textContent = '';
  }

  function addPhoto(file: File): void {
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
    preview.addEventListener('error', () => { preview.alt = 'No preview'; });
    const text = document.createElement('div');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = file.name || 'Photo';
    item.status.className = 'status';
    text.appendChild(name);
    text.appendChild(item.status);
    item.row.className = 'photo';
    item.row.appendChild(preview);
    item.row.appendChild(text);
    photoList.appendChild(item.row);
    setItem(item, 'waiting', 'Waiting');
    state.queue.push(item);
  }

  photosInput.addEventListener('change', () => {
    const files = Array.from(photosInput.files ?? []);
    clearPhotos();
    files.forEach((file) => { addPhoto(file); });
    prefillTime(files).catch(() => {
      whenInput.value = nowWall();
      state.exifOffset = null;
    });
  });

  function applyLocks(): void {
    const entryLocked = state.busy || state.memoryId !== null;
    textInput.disabled = entryLocked;
    whenInput.disabled = entryLocked;
    relatedFieldset.disabled = entryLocked;
    photosInput.disabled = entryLocked;
    saveButton.disabled = state.busy;
    saveButton.textContent = state.busy ? 'Saving…' : state.memoryId !== null ? 'Retry photos' : 'Save entry';
  }

  function setBusy(flag: boolean): void {
    state.busy = flag;
    applyLocks();
  }

  // Same-origin JSON or multipart request. Non-GET requests carry the CSRF token from the page.
  async function api<T>(method: string, path: string, body?: FormData | object): Promise<T> {
    const headers: Record<string, string> = {};
    const init: RequestInit = { method, credentials: 'same-origin', headers };
    if (method !== 'GET') headers['X-CSRF-Token'] = csrf;
    if (body instanceof FormData) {
      init.body = body;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await fetch(path, init);
    } catch {
      throw new Error('Could not reach MeMem. Check the connection; what you typed is still here.');
    }
    let data: unknown = null;
    try { data = await response.json(); } catch { data = null; }
    if (response.status === 401) throw new Error('Your session has ended. Reload the page and sign in again.');
    if (!response.ok) throw new Error(String(errorMessageOf(data) || 'Request failed (HTTP ' + response.status + ').'));
    return data as T;
  }

  // Follows every page of /api/related; each page is filtered on the server, so pages can hold fewer items.
  async function loadRelated(): Promise<RelatedItem[]> {
    let items: RelatedItem[] = [];
    let after: string | null = null;
    for (let page = 0; page < 1000; page++) {
      const query = after === null ? '' : '?afterId=' + encodeURIComponent(after);
      const data: RelatedPage = await api<RelatedPage>('GET', '/api/related' + query);
      items = items.concat(data.items);
      if (!data.nextAfterId || data.nextAfterId === after) break;
      after = data.nextAfterId;
    }
    return items;
  }

  function renderRelated(items: RelatedItem[]): void {
    relatedList.textContent = '';
    const groups: ReadonlyArray<readonly [RelatedItem['kind'], string]> = [['person', 'People'], ['place', 'Places']];
    let shown = 0;
    groups.forEach(([kind, heading]) => {
      const matches = items.filter((item) => item.kind === kind);
      if (matches.length === 0) return;
      shown += matches.length;
      const title = document.createElement('p');
      title.className = 'group-title';
      title.textContent = heading;
      relatedList.appendChild(title);
      matches.forEach((item) => {
        const label = document.createElement('label');
        label.className = 'choice';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.value = item.id;
        const text = document.createElement('span');
        text.textContent = item.text;
        label.appendChild(box);
        label.appendChild(text);
        relatedList.appendChild(label);
      });
    });
    if (shown === 0) relatedList.textContent = 'No people or places saved yet.';
  }

  function checkedIds(): string[] {
    return Array.from(relatedList.querySelectorAll<HTMLInputElement>('input[type=checkbox]:checked'), (box) => box.value);
  }

  // undefined when the field is empty, null when it is not a local time, otherwise an ISO time with offset.
  // The offset is the photo's own when the first JPEG had one; otherwise the browser's offset for that date.
  function occurredAtValue(): string | null | undefined {
    const wall = whenInput.value;
    if (!wall) return undefined;
    if (!WALL_TIME.test(wall)) return null;
    const zone = state.exifOffset || offsetText(browserOffset(wall));
    return (wall.length === 16 ? wall + ':00' : wall) + zone;
  }

  async function uploadPhoto(item: QueueItem): Promise<void> {
    const file = item.file;
    if (file.size > MAX_ORIGINAL_BYTES) throw new Error('This photo is larger than 25 MB.');
    setItem(item, 'working', 'Reading photo');
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const sha256 = hexOf(await crypto.subtle.digest('SHA-256', buffer));
    const taken = takenAtOf(bytes);
    setItem(item, 'working', 'Making preview');
    const derived = await derivatives(file);
    const body = new FormData();
    body.append('original', file, file.name || 'photo.jpg');
    body.append('sha256', sha256);
    if (taken !== null) body.append('takenAt', taken);
    if (derived !== null) {
      body.append('width', String(derived.width));
      body.append('height', String(derived.height));
      if (derived.display !== null) body.append('display', derived.display, 'display.jpg');
      if (derived.thumb !== null) body.append('thumb', derived.thumb, 'thumb.jpg');
    }
    // String() gives the same text that FormData.append would send for a null memory id.
    body.append('memoryId', String(state.memoryId));
    setItem(item, 'working', 'Uploading');
    const result = await api<UploadResult>('POST', '/api/media', body);
    let media = result.media;
    if (result.duplicate && media.memoryId === null) {
      setItem(item, 'working', 'Linking to this entry');
      // Both fields are required on every PATCH; the photo's current caption is sent back unchanged.
      const linked = await api<MediaEnvelope>('PATCH', '/api/media/' + encodeURIComponent(media.id), {
        expectedVersion: media.version,
        memoryId: state.memoryId,
        caption: media.caption,
      });
      media = linked.media;
    }
    item.mediaId = media.id;
    item.done = true;
    if (media.memoryId !== state.memoryId) {
      item.message = 'Already saved to another entry';
    } else if (result.duplicate) {
      item.message = 'Saved (this photo was already in MeMem)';
    } else if (derived === null || derived.display === null) {
      item.message = 'Saved without a preview';
    } else {
      item.message = 'Saved';
    }
    setItem(item, 'saved', item.message);
  }

  function finishSave(): void {
    const saved = state.queue.filter((item) => item.done);
    clearPhotos();
    state.memoryId = null;
    state.exifOffset = null;
    textInput.value = '';
    photosInput.value = '';
    whenInput.value = nowWall();
    relatedList.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach((box) => { box.checked = false; });
    savedPhotos.textContent = '';
    saved.forEach((item) => {
      const figure = document.createElement('figure');
      const thumb = document.createElement('img');
      thumb.width = 96;
      thumb.height = 96;
      thumb.alt = 'Saved photo';
      thumb.src = '/api/media/' + encodeURIComponent(String(item.mediaId)) + '/thumb';
      thumb.addEventListener('error', () => { thumb.alt = 'Saved; no preview'; });
      const caption = document.createElement('figcaption');
      caption.textContent = item.message;
      figure.appendChild(thumb);
      figure.appendChild(caption);
      savedPhotos.appendChild(figure);
    });
    showStatus('Saved.', false);
  }

  async function save(): Promise<void> {
    const text = textInput.value.trim();
    if (state.memoryId === null && text === '') {
      showStatus('Write a few words about the moment first.', true);
      textInput.focus();
      return;
    }
    setBusy(true);
    savedPhotos.textContent = '';
    showStatus('Saving…', false);
    try {
      if (state.memoryId === null) {
        const occurredAt = occurredAtValue();
        if (occurredAt === null) throw new Error('Choose a valid date and time.');
        const body: EntryBody = { text };
        if (occurredAt !== undefined) body.occurredAt = occurredAt;
        const related = checkedIds();
        if (related.length > 0) body.relatedIds = related;
        const created = await api<CreatedEntry>('POST', '/api/entries', body);
        state.memoryId = created.memory.id;
      }
      for (let i = 0; i < state.queue.length; i++) {
        const item = state.queue[i];
        if (item.done) continue;
        try {
          await uploadPhoto(item);
        } catch (error) {
          setItem(item, 'failed', messageOf(error));
        }
      }
      const pending = state.queue.filter((item) => !item.done);
      if (pending.length > 0) {
        showStatus('The entry is saved, but ' + pending.length + ' photo(s) did not upload. Press Retry photos to try them again.', true);
      } else {
        finishSave();
      }
    } catch (error) {
      showStatus(messageOf(error), true);
    } finally {
      setBusy(false);
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!state.busy) save();
  });

  whenInput.value = nowWall();
  applyLocks();
  loadRelated()
    .then(renderRelated)
    .catch((error: unknown) => { relatedList.textContent = 'Could not load people and places. ' + messageOf(error); });
}

startCapturePage();
