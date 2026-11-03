'use strict';

import {
  TEXT,
  browserClock,
  controlsFor,
  currentWall,
  dictationErrorMessage,
  dictationLanguageFor,
  displayNameOf,
  doneOf,
  draftFor,
  entryBody,
  entryContent,
  failureMessage,
  groupRelated,
  insertTranscript,
  isMissingWords,
  joinTranscripts,
  loadAllRelated,
  messageOf,
  occurredAtOf,
  pendingNotice,
  pendingOf,
  prefillFrom,
  requestPlan,
  splitResults,
  statusClassOf,
  thumbPath,
} from './capture-logic.ts';
import type {
  CreatedEntry,
  DictationLanguage,
  Draft,
  EntryBody,
  Phase,
  Prefill,
  RelatedGroup,
  RelatedItem,
  RelatedPage,
  RequestPlan,
  SpeechResultLike,
} from './capture-logic.ts';
import { uploadPhotoFile } from './photo-upload.ts';

/**
 * Browser script for the /capture page, served as /capture.js (no inline script is allowed by the page policy).
 * scripts/build-client.mjs bundles this file with ./capture-logic.ts, ./exif.ts and ./photo-upload.ts into
 * src/generated/capture-script.ts. Every value from the server or from a photo is written with textContent. The script
 * never uses innerHTML, insertAdjacentHTML, document.write or eval. This file holds the page's DOM work; the photo
 * pipeline is in photo-upload.ts, and the logic both call is in capture-logic.ts.
 */

// The dictation language's localStorage key. Storage can be blocked, so every access to it is guarded.
const DICTATE_LANGUAGE_KEY = 'memem-dictate-lang';

interface QueueItem {
  file: File;
  url: string;
  done: boolean;
  mediaId: string | null;
  message: string;
  row: HTMLLIElement;
  status: HTMLSpanElement;
}

/** The parts of the browser's speech recognition that the page uses. The page reads the results it is given, and nothing else. */
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { resultIndex: number; results: ArrayLike<SpeechResultLike> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
type SpeechConstructor = new () => SpeechRecognitionLike;

/**
 * The language select, typed by the members the page uses. HTMLSelectElement cannot be the target of a cast from an
 * element in this TypeScript's DOM library, so it is not used.
 */
interface LanguageSelect extends HTMLElement {
  value: string;
  disabled: boolean;
}

interface CaptureState {
  busy: boolean;
  memoryId: string | null;
  /** The entry's client-chosen ID and the request content it was minted for. */
  draft: Draft | null;
  exifOffset: string | null;
  queue: QueueItem[];
  prefillRun: number;
  /** The dictation that is running, or null when the page is not listening. */
  recognition: SpeechRecognitionLike | null;
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
  dictateBox: HTMLDivElement;
  dictateButton: HTMLButtonElement;
  dictateLang: LanguageSelect;
  dictateStatus: HTMLParagraphElement;
}

/** Everything one page instance reads or writes: its element references, the CSRF token and its state. */
interface CapturePage {
  els: CaptureElements;
  csrf: string;
  state: CaptureState;
}

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
    state: { busy: false, memoryId: null, draft: null, exifOffset: null, queue: [], prefillRun: 0, recognition: null },
  };
  page.els.photosInput.addEventListener('change', () => { onPhotosChanged(page); });
  page.els.form.addEventListener('submit', (event) => { onSubmit(page, event); });
  page.els.whenInput.value = currentWall(browserClock);
  applyLocks(page);
  setupDictation(page);
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
    dictateBox: document.getElementById('dictate') as HTMLDivElement,
    dictateButton: document.getElementById('dictate-button') as HTMLButtonElement,
    dictateLang: document.getElementById('dictate-lang') as LanguageSelect,
    dictateStatus: document.getElementById('dictate-status') as HTMLParagraphElement,
  };
}

function showStatus(page: CapturePage, message: string, isError: boolean): void {
  writeStatus(page.els.statusLine, message, isError);
}

/** Writes a status line's text, styled as an error when `isError` is set. */
function writeStatus(line: HTMLElement, message: string, isError: boolean): void {
  line.textContent = message;
  line.className = statusClassOf(isError);
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
  els.dictateButton.disabled = locks.entryLocked;
  els.dictateLang.disabled = locks.entryLocked;
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

// The photo pipeline runs in photo-upload.ts. This page supplies its API client and shows each step on the photo's row.
async function uploadPhoto(page: CapturePage, item: QueueItem): Promise<void> {
  const uploaded = await uploadPhotoFile(item.file, page.state.memoryId, {
    api: <T>(method: string, path: string, body?: FormData | object) => api<T>(page, method, path, body),
    onPhase: (phase, text) => { setItem(item, phase, text); },
  });
  item.mediaId = uploaded.media.id;
  item.done = true;
  item.message = uploaded.message;
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
  stopDictation(page); // no speech may land in the entry once it is being saved
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

// Dictation writes the browser's final speech into the entry at the caret. The controls appear only where the browser has
// speech recognition, and a running dictation stops when a save starts.

/** The standard speech recognition constructor, or the WebKit one, or null when the browser has neither. */
function speechConstructor(): SpeechConstructor | null {
  const speechWindow = window as unknown as { SpeechRecognition?: SpeechConstructor; webkitSpeechRecognition?: SpeechConstructor };
  return (speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition) ?? null;
}

/** Shows and wires the dictation controls when the browser can dictate. The language select starts from the stored choice. */
function setupDictation(page: CapturePage): void {
  const speech = speechConstructor();
  if (speech === null) return;
  const { els } = page;
  els.dictateBox.hidden = false;
  els.dictateLang.value = dictationLanguageFor(readStoredLanguage(), navigator.language);
  els.dictateButton.addEventListener('click', () => { onDictateClicked(page, speech); });
  els.dictateLang.addEventListener('change', () => { onLanguageChanged(page); });
}

function readStoredLanguage(): string | null {
  try {
    return localStorage.getItem(DICTATE_LANGUAGE_KEY);
  } catch {
    return null; // storage is blocked, so the browser's language gives the default
  }
}

function rememberLanguage(language: string): void {
  try {
    localStorage.setItem(DICTATE_LANGUAGE_KEY, language);
  } catch {
    // storage is blocked, so the choice applies to this page only
  }
}

function onLanguageChanged(page: CapturePage): void {
  rememberLanguage(page.els.dictateLang.value);
  // A running recognition keeps the language it started with, so it is stopped and the next Dictate uses the new one.
  stopDictation(page);
}

function onDictateClicked(page: CapturePage, speech: SpeechConstructor): void {
  if (page.state.recognition !== null) stopDictation(page);
  else startDictation(page, speech);
}

function startDictation(page: CapturePage, speech: SpeechConstructor): void {
  const lang = page.els.dictateLang.value as DictationLanguage;
  const recognition = new speech();
  recognition.lang = lang;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.onresult = (event) => { onDictationResult(page, lang, event); };
  recognition.onerror = (event) => { onDictationError(page, event.error); };
  recognition.onend = () => { onDictationEnd(page); };
  page.state.recognition = recognition;
  setDictateButton(page, true);
  writeStatus(page.els.dictateStatus, TEXT.dictateListening, false);
  recognition.start();
}

function stopDictation(page: CapturePage): void {
  if (page.state.recognition !== null) page.state.recognition.stop();
}

/** Final text goes into the entry unless the entry is locked. The status line shows the interim text, or Listening. */
function onDictationResult(page: CapturePage, lang: DictationLanguage, event: { resultIndex: number; results: ArrayLike<SpeechResultLike> }): void {
  const heard = splitResults(event.results, event.resultIndex);
  if (!isLocked(page)) insertDictated(page, lang, heard.finals);
  writeStatus(page.els.dictateStatus, heard.interim === '' ? TEXT.dictateListening : heard.interim, false);
}

function isLocked(page: CapturePage): boolean {
  return controlsFor(page.state.busy, page.state.memoryId).entryLocked;
}

/** The transcript goes in at the caret, replacing any selection. The input event tells the page that the entry changed. */
function insertDictated(page: CapturePage, lang: DictationLanguage, finals: string[]): void {
  const { textInput } = page.els;
  const next = insertTranscript(textInput.value, textInput.selectionStart, textInput.selectionEnd, joinTranscripts(finals, lang), lang);
  if (next.text === textInput.value) return;
  textInput.value = next.text;
  textInput.setSelectionRange(next.caret, next.caret);
  textInput.dispatchEvent(new Event('input', { bubbles: true }));
}

function onDictationError(page: CapturePage, code: string): void {
  const message = dictationErrorMessage(code);
  if (message !== null) writeStatus(page.els.dictateStatus, message, true);
}

/** The end event follows every stop, error and silence. An error message stays on the line; anything else is cleared. */
function onDictationEnd(page: CapturePage): void {
  page.state.recognition = null;
  setDictateButton(page, false);
  if (!page.els.dictateStatus.classList.contains('error')) writeStatus(page.els.dictateStatus, '', false);
}

function setDictateButton(page: CapturePage, listening: boolean): void {
  const { dictateButton } = page.els;
  dictateButton.textContent = listening ? TEXT.dictateStop : TEXT.dictate;
  dictateButton.setAttribute('aria-pressed', String(listening));
}

startCapturePage();
