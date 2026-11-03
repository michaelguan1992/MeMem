'use strict';

import {
  TEXT,
  browserClock,
  displayNameOf,
  failureMessage,
  groupRelated,
  loadAllRelated,
  mediaPath,
  messageOf,
  requestPlan,
  statusClassOf,
  thumbPath,
} from './capture-logic.ts';
import type { Phase, RelatedGroup, RelatedItem, RelatedPage, RequestPlan } from './capture-logic.ts';
import { uploadPhotoFile } from './photo-upload.ts';
import {
  HISTORY_TEXT,
  attachBody,
  displayPath,
  editBody,
  editFailureMessage,
  editedOccurredAt,
  entryPath,
  linkedNames,
  linksToSave,
  loadAllEntries,
  loadAllPhotos,
  loadAllUnlinked,
  photoDeleteBody,
  photoFailureMessage,
  replaceEntry,
  sortEntries,
  takenDateLabel,
  unlinkBody,
  wallOfStored,
  whenLabel,
} from './history-logic.ts';
import type { EditBody, EntryEnvelope, EntryItem, EntryPage, MediaPage, PhotoItem } from './history-logic.ts';

/**
 * Browser script for the /capture/history page, served as /capture-history.js (no inline script is allowed by the page
 * policy). scripts/build-client.mjs bundles this file with ./history-logic.ts, ./capture-logic.ts and ./photo-upload.ts into
 * src/generated/history-script.ts. Every value from the server is written with textContent. The script never uses
 * innerHTML, insertAdjacentHTML, document.write or eval. This file holds the DOM work; the logic it calls is in the logic
 * modules, and uploads go through the photo pipeline in photo-upload.ts.
 */

const EDIT_TEXT_ID = 'entry-edit-text';
const EDIT_WHEN_ID = 'entry-edit-when';
const EDIT_PHOTOS_ID = 'entry-edit-photos';
// An entry's photos are asked for once its row is this close to the screen, so a long list does not ask for every entry at once.
const NEAR_SCREEN = '200px';

/** What the page shows: the entries in list order, the people and places, and the entry being edited. */
interface HistoryState {
  entries: EntryItem[];
  related: RelatedItem[];
  /** The entry being edited, or null. Only one entry is edited at a time. */
  editingId: string | null;
  /** Each entry's photo strip. A photo change replaces the strip, so a strip that is out of date is never shown. */
  strips: Map<string, HTMLDivElement>;
  /** The strips whose photos have been asked for. Each is asked for once; a replaced strip is a new element, so it is asked again. */
  asked: WeakSet<HTMLDivElement>;
  /** The Photos area of the open editor, or null when no entry is being edited. */
  photos: PhotoPanel | null;
  /** The photos with a change in flight. Their buttons stay disabled, also in a list that loads while the change runs. */
  busy: Set<string>;
  /** The number of the latest load of the Unlinked photos section. Only that load is shown. */
  unlinkedTurn: number;
}

/** The Photos area of the open editor: its lists, and the number of each list's latest load. */
interface PhotoPanel {
  entryId: string;
  /** One row for each file of the latest selection. */
  uploads: HTMLUListElement;
  /** The photos on the entry. */
  linked: HTMLDivElement;
  toggle: HTMLButtonElement;
  /** Where the outcome of each photo change made in this area is shown. */
  status: HTMLParagraphElement;
  /** The unlinked photos that can be attached to the entry. Hidden until the toggle opens it. */
  pick: HTMLDivElement;
  linkedTurn: number;
  pickTurn: number;
}

/** Everything one page instance reads or writes: its elements, the CSRF token and its state. */
interface HistoryPage {
  list: HTMLOListElement;
  status: HTMLParagraphElement;
  /** The box of the Unlinked photos section, and the status line that reports the photo changes made in that section. */
  unlinked: HTMLDivElement;
  unlinkedStatus: HTMLParagraphElement;
  csrf: string;
  state: HistoryState;
  /** Loads a row's photos when the row comes near the screen. Null in a browser without IntersectionObserver, where they load at once. */
  viewer: IntersectionObserver | null;
}

/** The parts of the open editor that a save reads or changes. */
interface Editor {
  form: HTMLFormElement;
  fields: HTMLFieldSetElement;
  text: HTMLTextAreaElement;
  when: HTMLInputElement;
  save: HTMLButtonElement;
  cancel: HTMLButtonElement;
}

/** A response: its HTTP status and its parsed JSON body, or null when the body is not JSON. */
interface Reply {
  status: number;
  data: unknown;
}

/** One chosen file and the row that shows its progress. */
interface UploadRow {
  file: File;
  row: HTMLLIElement;
  status: HTMLSpanElement;
}

function startHistoryPage(): void {
  const list = document.getElementById('entry-list') as HTMLOListElement | null;
  const status = document.getElementById('status') as HTMLParagraphElement | null;
  const unlinked = document.getElementById('unlinked-list') as HTMLDivElement | null;
  const unlinkedStatus = document.getElementById('unlinked-status') as HTMLParagraphElement | null;
  const csrfMeta = document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]');
  if (!list || !status || !unlinked || !unlinkedStatus || !csrfMeta) return;
  const page: HistoryPage = {
    list,
    status,
    unlinked,
    unlinkedStatus,
    csrf: csrfMeta.getAttribute('content') || '',
    state: { entries: [], related: [], editingId: null, strips: new Map(), asked: new WeakSet(), photos: null, busy: new Set(), unlinkedTurn: 0 },
    viewer: null,
  };
  page.viewer = watchStrips(page);
  setStatus(page, HISTORY_TEXT.loading, false);
  messageBox(unlinked, HISTORY_TEXT.loadingPhotos);
  loadUnlinked(page);
  Promise.all([
    loadAllEntries((path) => getJson<EntryPage>(page, path)),
    loadAllRelated((path) => getJson<RelatedPage>(page, path)),
  ])
    .then(([entries, related]) => { showLoaded(page, entries, related); })
    .catch((error: unknown) => { setStatus(page, HISTORY_TEXT.loadFailed + messageOf(error), true); });
}

function showLoaded(page: HistoryPage, entries: EntryItem[], related: RelatedItem[]): void {
  page.state.entries = sortEntries(entries);
  page.state.related = related;
  renderList(page);
  setStatus(page, entries.length === 0 ? HISTORY_TEXT.none : '', false);
}

function setStatus(page: HistoryPage, message: string, isError: boolean): void {
  page.status.textContent = message;
  page.status.className = statusClassOf(isError);
}

// The status line of an area, such as the Photos area or the Unlinked photos section. Each area reports its own photo changes.
function statusLine(): HTMLParagraphElement {
  const line = document.createElement('p');
  line.className = 'status-line';
  line.setAttribute('role', 'status');
  line.setAttribute('aria-live', 'polite');
  return line;
}

// Writes an area's status text. An error takes the same error class as the page's status line.
function writeLine(line: HTMLElement, message: string, isError: boolean): void {
  line.textContent = message;
  line.className = ('status-line ' + statusClassOf(isError)).trim();
}

// Same-origin request. Writes carry the page's CSRF token. A request that never gets a response has the unreachable text.
async function send(page: HistoryPage, method: string, path: string, body?: FormData | object): Promise<Reply> {
  const plan: RequestPlan = requestPlan(method, page.csrf, body);
  let response: Response;
  try {
    response = await fetch(path, plan);
  } catch {
    throw new Error(TEXT.unreachable);
  }
  let data: unknown = null;
  try { data = await response.json(); } catch { data = null; }
  return { status: response.status, data };
}

// The JSON of a successful GET. Any other reply throws the text to show for it.
async function getJson<T>(page: HistoryPage, path: string): Promise<T> {
  const reply = await send(page, 'GET', path);
  const problem = failureMessage(reply.status, reply.data);
  if (problem !== null) throw new Error(problem);
  return reply.data as T;
}

// A photo change or an upload. A refused one throws the text to show, so every photo request is handled the same way.
async function photoRequest<T>(page: HistoryPage, method: string, path: string, body?: FormData | object): Promise<T> {
  const reply = await send(page, method, path, body);
  const problem = photoFailureMessage(reply.status, reply.data);
  if (problem !== null) throw new Error(problem);
  return reply.data as T;
}

function renderList(page: HistoryPage): void {
  // The editor sets this again when an entry is being edited, so a list with no editor has no Photos area to load into.
  page.state.photos = null;
  // Every row is new, so the watcher forgets the old ones. Otherwise it would keep them, and the detached rows, alive.
  page.viewer?.disconnect();
  page.list.textContent = '';
  page.state.entries.forEach((entry) => { page.list.appendChild(entryItem(page, entry)); });
}

function entryItem(page: HistoryPage, entry: EntryItem): HTMLLIElement {
  return page.state.editingId === entry.id ? editorItem(page, entry) : viewItem(page, entry);
}

function textElement<K extends 'p' | 'span'>(tag: K, className: string, text: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

function buttonElement(label: string, className: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  return button;
}

function viewItem(page: HistoryPage, entry: EntryItem): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'entry';
  item.dataset.id = entry.id;
  item.appendChild(textElement('p', 'when', whenLabel(entry.occurredAt, browserClock)));
  item.appendChild(textElement('p', 'body', entry.text));
  const names = linkedNames(entry, page.state.related);
  if (names.length > 0) item.appendChild(textElement('p', 'linked', HISTORY_TEXT.linkedWith + names.join(', ')));
  item.appendChild(photoStripFor(page, entry.id));
  const edit = buttonElement(HISTORY_TEXT.edit, 'edit');
  // Only one entry is edited at a time, so the other entries' Edit buttons wait for the open editor.
  edit.disabled = page.state.editingId !== null;
  edit.addEventListener('click', () => { startEdit(page, entry.id); });
  item.appendChild(edit);
  watchPhotos(page, item, entry.id);
  return item;
}

function editorItem(page: HistoryPage, entry: EntryItem): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'entry editing';
  item.dataset.id = entry.id;
  const form = document.createElement('form');
  form.className = 'editor';
  form.noValidate = true;

  const fields = document.createElement('fieldset');
  fields.className = 'editor-fields';
  const text = document.createElement('textarea');
  text.id = EDIT_TEXT_ID;
  text.name = 'text';
  text.rows = 6;
  text.value = entry.text;
  const when = document.createElement('input');
  when.id = EDIT_WHEN_ID;
  when.name = 'occurredAt';
  when.type = 'datetime-local';
  when.value = wallOfStored(entry.occurredAt, browserClock);
  fields.appendChild(labelled(HISTORY_TEXT.entryText, text));
  fields.appendChild(labelled(HISTORY_TEXT.when, when));
  fields.appendChild(photosFieldset(page, entry.id));
  fields.appendChild(relatedFieldset(page, entry));

  const actions = document.createElement('div');
  actions.className = 'editor-actions';
  const save = buttonElement(HISTORY_TEXT.saveChanges, 'primary');
  save.type = 'submit';
  const cancel = buttonElement(HISTORY_TEXT.cancel, 'secondary');
  actions.appendChild(save);
  actions.appendChild(cancel);
  form.appendChild(fields);
  form.appendChild(actions);

  const editor: Editor = { form, fields, text, when, save, cancel };
  cancel.addEventListener('click', () => { cancelEdit(page, entry.id); });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    saveEdit(page, entry, editor);
  });
  item.appendChild(form);
  return item;
}

function labelled(labelText: string, control: HTMLTextAreaElement | HTMLInputElement): HTMLDivElement {
  const field = document.createElement('div');
  field.className = 'field';
  const label = document.createElement('label');
  label.htmlFor = control.id;
  label.textContent = labelText;
  field.appendChild(label);
  field.appendChild(control);
  return field;
}

function relatedFieldset(page: HistoryPage, entry: EntryItem): HTMLFieldSetElement {
  const fieldset = document.createElement('fieldset');
  fieldset.className = 'related';
  const legend = document.createElement('legend');
  legend.textContent = HISTORY_TEXT.relatedLegend;
  fieldset.appendChild(legend);
  const groups = groupRelated(page.state.related);
  if (groups.length === 0) {
    fieldset.appendChild(textElement('p', 'hint', TEXT.noPeopleOrPlaces));
    return fieldset;
  }
  const choices = document.createElement('div');
  choices.className = 'choices';
  groups.forEach((group) => { appendGroup(choices, group, entry.relatedIds); });
  fieldset.appendChild(choices);
  return fieldset;
}

function appendGroup(choices: HTMLDivElement, group: RelatedGroup, linked: string[]): void {
  choices.appendChild(textElement('p', 'group-title', group.heading));
  group.items.forEach((item) => { choices.appendChild(choice(item, linked.includes(item.id))); });
}

function choice(item: RelatedItem, checked: boolean): HTMLLabelElement {
  const label = document.createElement('label');
  label.className = 'choice';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.value = item.id;
  box.checked = checked;
  label.appendChild(box);
  label.appendChild(textElement('span', '', item.text));
  return label;
}

function startEdit(page: HistoryPage, entryId: string): void {
  if (page.state.editingId !== null) return;
  page.state.editingId = entryId;
  setStatus(page, '', false);
  renderList(page);
  document.getElementById(EDIT_TEXT_ID)?.focus();
}

// Closing without saving drops the typed text. The Edit button of that entry takes the focus back.
function cancelEdit(page: HistoryPage, entryId: string): void {
  page.state.editingId = null;
  renderList(page);
  page.list.querySelector<HTMLButtonElement>('li[data-id="' + entryId + '"] .edit')?.focus();
}

function shownIds(page: HistoryPage): string[] {
  return page.state.related.map((item) => item.id);
}

function checkedIds(form: HTMLFormElement): string[] {
  return Array.from(form.querySelectorAll<HTMLInputElement>('input[type=checkbox]:checked'), (box) => box.value);
}

// A refused edit keeps the form and the typed text. A saved edit replaces the entry, closes the form and re-sorts the list.
function saveEdit(page: HistoryPage, entry: EntryItem, editor: Editor): void {
  let body: EditBody;
  try {
    const occurredAt = editedOccurredAt(entry.occurredAt, editor.when.value, browserClock);
    body = editBody(entry, editor.text.value, occurredAt, linksToSave(entry, shownIds(page), checkedIds(editor.form)));
  } catch (error) {
    setStatus(page, messageOf(error), true);
    return;
  }
  setSaving(editor, true);
  setStatus(page, TEXT.saving, false);
  send(page, 'PATCH', entryPath(entry.id), body)
    .then((reply) => { onSaveReply(page, editor, reply); })
    .catch((error: unknown) => {
      setSaving(editor, false);
      setStatus(page, messageOf(error), true);
    });
}

function onSaveReply(page: HistoryPage, editor: Editor, reply: Reply): void {
  const problem = editFailureMessage(reply.status, reply.data);
  if (problem !== null) {
    setSaving(editor, false);
    setStatus(page, problem, true);
    return;
  }
  const saved = (reply.data as EntryEnvelope).memory;
  page.state.entries = sortEntries(replaceEntry(page.state.entries, saved));
  page.state.editingId = null;
  renderList(page);
  setStatus(page, TEXT.saved, false);
}

// While a save is in flight every control of the editor is disabled, so the text cannot change under the request.
function setSaving(editor: Editor, saving: boolean): void {
  editor.fields.disabled = saving;
  editor.save.disabled = saving;
  editor.cancel.disabled = saving;
  editor.save.textContent = saving ? TEXT.saving : HISTORY_TEXT.saveChanges;
}

// The photo strip of an entry. It is made once, and its photos are asked for when the entry's row comes near the screen.
function photoStripFor(page: HistoryPage, entryId: string): HTMLDivElement {
  return page.state.strips.get(entryId) ?? newStrip(page, entryId);
}

// A new, empty strip for an entry. It stays cached until a photo change replaces it.
function newStrip(page: HistoryPage, entryId: string): HTMLDivElement {
  const strip = document.createElement('div');
  strip.className = 'thumbs';
  page.state.strips.set(entryId, strip);
  return strip;
}

// An entry's photos changed, so its strip is replaced rather than reloaded. A request still running fills the old strip, which
// is no longer on the page, so it cannot show the old photos. A strip on the page is swapped in place, and its row is watched
// again, so the new strip is asked for when the row is near the screen.
function renewStrip(page: HistoryPage, entryId: string): void {
  const old = page.state.strips.get(entryId);
  if (old === undefined) return;
  const fresh = newStrip(page, entryId);
  if (!old.isConnected) return;
  old.replaceWith(fresh);
  if (fresh.parentElement instanceof HTMLLIElement) watchPhotos(page, fresh.parentElement, entryId);
}

// The row of an entry is watched, not its strip. An empty strip has no box, so it is never near the screen and would never load.
// Without an observer, the photos are asked for at once.
function watchPhotos(page: HistoryPage, row: HTMLLIElement, entryId: string): void {
  if (page.viewer === null) loadStrip(page, entryId);
  else page.viewer.observe(row);
}

// Asks for an entry's photos once, into its current strip.
function loadStrip(page: HistoryPage, entryId: string): void {
  const strip = page.state.strips.get(entryId);
  if (strip === undefined || page.state.asked.has(strip)) return;
  page.state.asked.add(strip);
  loadThumbs(page, entryId, strip);
}

function watchStrips(page: HistoryPage): IntersectionObserver | null {
  if (typeof IntersectionObserver !== 'function') return null;
  return new IntersectionObserver((seen) => { onNearScreen(page, seen); }, { rootMargin: NEAR_SCREEN });
}

function onNearScreen(page: HistoryPage, seen: IntersectionObserverEntry[]): void {
  seen.forEach((entry) => {
    if (!entry.isIntersecting) return;
    page.viewer?.unobserve(entry.target);
    const entryId = (entry.target as HTMLElement).dataset.id;
    if (entryId !== undefined) loadStrip(page, entryId);
  });
}

// Requests every photo of one entry and fills the strip it is given. A failed request says so in that strip.
async function loadThumbs(page: HistoryPage, entryId: string, strip: HTMLDivElement): Promise<void> {
  try {
    const photos = await loadAllPhotos(entryId, (path) => getJson<MediaPage>(page, path));
    strip.textContent = '';
    photos.forEach((photo) => { strip.appendChild(thumbOf(photo)); });
  } catch {
    strip.textContent = HISTORY_TEXT.photosFailed;
  }
}

function thumbOf(photo: PhotoItem): HTMLImageElement {
  const image = document.createElement('img');
  image.loading = 'lazy';
  image.alt = HISTORY_TEXT.photoAlt;
  image.addEventListener('error', () => { image.alt = TEXT.noPreview; });
  image.src = thumbPath(photo.id);
  return image;
}

// The Photos area of the open editor. Its photo changes go to the server at once and redraw only the lists in it, so the
// text the owner is typing is never rebuilt.
function photosFieldset(page: HistoryPage, entryId: string): HTMLFieldSetElement {
  const fieldset = document.createElement('fieldset');
  fieldset.className = 'photos-area';
  const legend = document.createElement('legend');
  legend.textContent = HISTORY_TEXT.photos;
  fieldset.appendChild(legend);
  fieldset.appendChild(textElement('p', 'hint', HISTORY_TEXT.photosHint));

  const input = document.createElement('input');
  input.id = EDIT_PHOTOS_ID;
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = true;
  fieldset.appendChild(labelled(HISTORY_TEXT.addPhotos, input));

  const uploads = document.createElement('ul');
  uploads.className = 'uploads';
  const linked = document.createElement('div');
  linked.className = 'linked-photos';
  const toggle = buttonElement(HISTORY_TEXT.addFromUnlinked, 'secondary');
  toggle.setAttribute('aria-expanded', 'false');
  const status = statusLine();
  const pick = document.createElement('div');
  pick.className = 'pick';
  pick.hidden = true;
  fieldset.appendChild(uploads);
  fieldset.appendChild(linked);
  fieldset.appendChild(toggle);
  fieldset.appendChild(status);
  fieldset.appendChild(pick);

  const panel: PhotoPanel = { entryId, uploads, linked, toggle, status, pick, linkedTurn: 0, pickTurn: 0 };
  page.state.photos = panel;
  input.addEventListener('change', () => { pickFiles(page, panel, input); });
  toggle.addEventListener('click', () => { togglePick(page, panel); });
  messageBox(linked, HISTORY_TEXT.loadingPhotos);
  loadLinked(page, panel);
  return fieldset;
}

// The files of one selection are uploaded to the entry in turn, and a new selection replaces the rows of the last one. The
// input is cleared, so choosing a file again after it failed starts a new upload.
function pickFiles(page: HistoryPage, panel: PhotoPanel, input: HTMLInputElement): void {
  const files = Array.from(input.files ?? []);
  input.value = '';
  // A picker closed without a choice reports no files, and the rows of the last selection stay as they were.
  if (files.length === 0) return;
  panel.uploads.textContent = '';
  const rows = files.map((file) => uploadRow(panel, file));
  uploadInTurn(page, panel, rows);
}

function uploadRow(panel: PhotoPanel, file: File): UploadRow {
  const row = document.createElement('li');
  row.className = 'upload';
  row.dataset.state = 'waiting';
  const status = textElement('span', 'status', TEXT.waiting);
  row.appendChild(textElement('span', 'name', displayNameOf(file)));
  row.appendChild(status);
  panel.uploads.appendChild(row);
  return { file, row, status };
}

function setRow(item: UploadRow, phase: Phase, text: string): void {
  item.row.dataset.state = phase;
  item.status.textContent = text;
}

async function uploadInTurn(page: HistoryPage, panel: PhotoPanel, rows: UploadRow[]): Promise<void> {
  for (const item of rows) await uploadOne(page, panel, item);
}

// One photo through the shared pipeline. A photo that fails shows its error on its row; the rest of the selection still uploads.
async function uploadOne(page: HistoryPage, panel: PhotoPanel, item: UploadRow): Promise<void> {
  try {
    const uploaded = await uploadPhotoFile(item.file, panel.entryId, {
      api: <T>(method: string, path: string, body?: FormData | object) => photoRequest<T>(page, method, path, body),
      onPhase: (phase, text) => { setRow(item, phase, text); },
    });
    setRow(item, 'saved', uploaded.message);
  } catch (error) {
    setRow(item, 'failed', messageOf(error));
  }
  await photosChanged(page, panel.entryId);
}

// Opens or closes the list of unlinked photos. Opening loads the list afresh.
function togglePick(page: HistoryPage, panel: PhotoPanel): void {
  const opening = panel.pick.hidden;
  panel.pick.hidden = !opening;
  panel.toggle.setAttribute('aria-expanded', String(opening));
  if (!opening) return;
  messageBox(panel.pick, HISTORY_TEXT.loadingPhotos);
  loadPick(page, panel);
}

// The Unlinked photos section. A load that a newer load has overtaken is not shown.
async function loadUnlinked(page: HistoryPage): Promise<void> {
  const turn = ++page.state.unlinkedTurn;
  try {
    const photos = await loadAllUnlinked((path) => getJson<MediaPage>(page, path));
    if (turn === page.state.unlinkedTurn) fillBox(page.unlinked, photos.map((photo) => unlinkedCard(page, photo)), HISTORY_TEXT.noUnlinked);
  } catch (error) {
    if (turn === page.state.unlinkedTurn) messageBox(page.unlinked, HISTORY_TEXT.unlinkedFailed + ' ' + messageOf(error));
  }
}

// The photos on the open entry. A load that a newer load has overtaken is not shown.
async function loadLinked(page: HistoryPage, panel: PhotoPanel): Promise<void> {
  const turn = ++panel.linkedTurn;
  try {
    const photos = await loadAllPhotos(panel.entryId, (path) => getJson<MediaPage>(page, path));
    if (turn === panel.linkedTurn) fillBox(panel.linked, photos.map((photo) => linkedCard(page, panel, photo)), HISTORY_TEXT.noEntryPhotos);
  } catch (error) {
    if (turn === panel.linkedTurn) messageBox(panel.linked, HISTORY_TEXT.photosFailed + ' ' + messageOf(error));
  }
}

// The unlinked photos that the open entry can take. A load that a newer load has overtaken is not shown.
async function loadPick(page: HistoryPage, panel: PhotoPanel): Promise<void> {
  const turn = ++panel.pickTurn;
  try {
    const photos = await loadAllUnlinked((path) => getJson<MediaPage>(page, path));
    if (turn === panel.pickTurn) fillBox(panel.pick, photos.map((photo) => pickCard(page, panel, photo)), HISTORY_TEXT.noUnlinked);
  } catch (error) {
    if (turn === panel.pickTurn) messageBox(panel.pick, HISTORY_TEXT.unlinkedFailed + ' ' + messageOf(error));
  }
}

// A photo's card: a link that opens its display JPEG in a new tab, its thumbnail, and the day it was taken. Each list adds its buttons.
function photoCard(photo: PhotoItem): HTMLLIElement {
  const card = document.createElement('li');
  card.className = 'photo-card';
  const link = document.createElement('a');
  link.href = displayPath(photo.id);
  link.target = '_blank';
  link.rel = 'noopener';
  link.appendChild(thumbOf(photo));
  card.appendChild(link);
  card.appendChild(textElement('p', 'taken', takenDateLabel(photo.takenAt, browserClock)));
  return card;
}

// A button on a photo's card. It starts disabled while a change to that photo is still running.
function photoButton(page: HistoryPage, photo: PhotoItem, label: string, className: string, act: () => void): HTMLButtonElement {
  const button = buttonElement(label, className);
  button.disabled = page.state.busy.has(photo.id);
  button.addEventListener('click', () => { act(); });
  return button;
}

// A photo on the open entry. Remove from entry keeps the photo, which becomes unlinked. Delete permanently removes it for good.
function linkedCard(page: HistoryPage, panel: PhotoPanel, photo: PhotoItem): HTMLLIElement {
  const card = photoCard(photo);
  card.appendChild(photoButton(page, photo, HISTORY_TEXT.removeFromEntry, 'secondary', () => {
    changePhoto(page, card, photo, panel.entryId, panel.status, () => photoRequest(page, 'PATCH', mediaPath(photo.id), unlinkBody(photo)), HISTORY_TEXT.photoRemoved);
  }));
  card.appendChild(photoButton(page, photo, HISTORY_TEXT.deletePhoto, 'danger', () => { deletePhoto(page, card, photo, panel.entryId, panel.status); }));
  return card;
}

// An unlinked photo in the editor's list. Attach puts it on the open entry.
function pickCard(page: HistoryPage, panel: PhotoPanel, photo: PhotoItem): HTMLLIElement {
  const card = photoCard(photo);
  card.appendChild(photoButton(page, photo, HISTORY_TEXT.attach, 'primary', () => {
    changePhoto(page, card, photo, panel.entryId, panel.status, () => photoRequest(page, 'PATCH', mediaPath(photo.id), attachBody(photo, panel.entryId)), HISTORY_TEXT.photoAttached);
  }));
  return card;
}

// An unlinked photo in the Unlinked section. Delete permanently removes it for good.
function unlinkedCard(page: HistoryPage, photo: PhotoItem): HTMLLIElement {
  const card = photoCard(photo);
  card.appendChild(photoButton(page, photo, HISTORY_TEXT.deletePhoto, 'danger', () => { deletePhoto(page, card, photo, null, page.unlinkedStatus); }));
  return card;
}

// Runs one change to a photo, with that photo's buttons disabled until its lists are shown again. The outcome goes on the status
// line of the area the change was made in. The lists reload whether the change went through or was refused, so the page shows the
// photo as the server has it now.
async function changePhoto(page: HistoryPage, card: HTMLElement, photo: PhotoItem, entryId: string | null, line: HTMLElement, change: () => Promise<unknown>, doneText: string): Promise<void> {
  page.state.busy.add(photo.id);
  setButtonsDisabled(card, true);
  try {
    await change();
    writeLine(line, doneText, false);
  } catch (error) {
    writeLine(line, messageOf(error), true);
  } finally {
    page.state.busy.delete(photo.id);
    await photosChanged(page, entryId);
  }
}

// Deletes a photo for good, once the owner confirms. Cancelling sends nothing.
function deletePhoto(page: HistoryPage, card: HTMLElement, photo: PhotoItem, entryId: string | null, line: HTMLElement): void {
  if (!window.confirm(HISTORY_TEXT.deleteConfirm)) return;
  changePhoto(page, card, photo, entryId, line, () => photoRequest(page, 'DELETE', mediaPath(photo.id), photoDeleteBody(photo)), HISTORY_TEXT.photoDeleted);
}

// After a photo change or an upload: the entry's strip is replaced, and the open editor's lists and the Unlinked section reload.
async function photosChanged(page: HistoryPage, entryId: string | null): Promise<void> {
  if (entryId !== null) renewStrip(page, entryId);
  const panel = page.state.photos;
  await Promise.all([
    panel === null ? undefined : loadLinked(page, panel),
    panel === null || panel.pick.hidden ? undefined : loadPick(page, panel),
    loadUnlinked(page),
  ]);
}

// Disables or enables the buttons of one photo's card.
function setButtonsDisabled(card: HTMLElement, disabled: boolean): void {
  card.querySelectorAll<HTMLButtonElement>('button').forEach((button) => { button.disabled = disabled; });
}

// Replaces a box's contents with one line of text.
function messageBox(box: HTMLElement, text: string): void {
  box.textContent = '';
  box.appendChild(textElement('p', 'hint', text));
}

// Replaces a box's contents with a grid of cards, or with the text for an empty list when there are none.
function fillBox(box: HTMLElement, cards: HTMLLIElement[], empty: string): void {
  if (cards.length === 0) {
    messageBox(box, empty);
    return;
  }
  const grid = document.createElement('ul');
  grid.className = 'photo-grid';
  cards.forEach((card) => { grid.appendChild(card); });
  box.textContent = '';
  box.appendChild(grid);
}

startHistoryPage();
