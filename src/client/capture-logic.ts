import type { MediaVariant } from '../core/schema.ts';
import { readJpegTakenAt } from './exif.ts';

/**
 * The part of the /capture page that needs no DOM: wall-clock and offset text, JPEG and hex helpers, error text, request
 * plans, the entry and photo request bodies, derivative sizes, related-list paging and grouping, status decisions, and
 * the dictation language, transcript insertion and recognition-error text.
 * capture.ts runs the page with these functions. The clock and randomness come in as parameters (a Clock and a newId
 * function), so each function returns the same result for the same inputs. The only runtime import is the EXIF reader.
 */

/** Longer edge, in pixels, of the display photo and of the thumbnail. */
export const DISPLAY_EDGE = 1600;
export const THUMB_EDGE = 400;
const MAX_ORIGINAL_BYTES = 25 * 1024 * 1024;
const MAX_DISPLAY_BYTES = 5 * 1024 * 1024;
const MAX_THUMB_BYTES = 1024 * 1024;
const MAX_RELATED_PAGES = 1000;
const WALL_TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2})?$/;
// Checked against the server's variant list by the type checker, so a renamed variant fails the build.
const THUMB_VARIANT: MediaVariant = 'thumb';

// Every sentence the page shows that is not a server message. The page writes each one with textContent.
export const TEXT = {
  unreachable: 'Could not reach MeMem. Check the connection; what you typed is still here.',
  sessionEnded: 'Your session has ended. Reload the page and sign in again.',
  genericError: 'Something went wrong. What you typed is still here; try again.',
  needWords: 'Write a few words about the moment first.',
  badWhen: 'Choose a valid date and time.',
  tooLarge: 'This photo is larger than 25 MB.',
  saving: 'Saving…',
  saved: 'Saved.',
  saveEntry: 'Save entry',
  retryPhotos: 'Retry photos',
  waiting: 'Waiting',
  reading: 'Reading photo',
  previewing: 'Making preview',
  uploading: 'Uploading',
  linking: 'Linking to this entry',
  noPreview: 'No preview',
  savedPhoto: 'Saved',
  savedWithoutPreview: 'Saved without a preview',
  savedDuplicate: 'Saved (this photo was already in MeMem)',
  savedElsewhere: 'Already saved to another entry',
  savedPhotoAlt: 'Saved photo',
  savedNoPreviewAlt: 'Saved; no preview',
  untitledPhoto: 'Photo',
  noPeopleOrPlaces: 'No people or places saved yet.',
  relatedFailed: 'Could not load people and places. ',
  dictate: 'Dictate',
  dictateStop: 'Stop',
  dictateListening: 'Listening…',
  dictateDenied: 'Microphone access was denied.',
  dictateNoSpeech: 'No speech was heard.',
  dictateNoMic: 'No microphone was found.',
  dictateNetwork: 'The speech service is unreachable.',
  dictateStopped: 'Dictation stopped: ',
} as const;

/** The state a photo's row shows. */
export type Phase = 'waiting' | 'working' | 'saved' | 'failed';

// The parts of the server's JSON that the page reads or sends back.
export interface MediaRecord {
  id: string;
  memoryId: string | null;
  version: number;
  caption: string | null;
}

export interface MediaEnvelope {
  media: MediaRecord;
}

export interface UploadResult extends MediaEnvelope {
  duplicate: boolean;
}

export interface CreatedEntry {
  memory: { id: string };
}

export interface RelatedItem {
  id: string;
  kind: 'person' | 'place';
  text: string;
}

export interface RelatedPage {
  items: RelatedItem[];
  nextAfterId: string | null;
}

/** The fields of an entry that the user chose. */
export interface EntryContent {
  text: string;
  occurredAt?: string;
  relatedIds?: string[];
}

/** The POST /api/entries body: the draft's ID, then the content. */
export interface EntryBody extends EntryContent {
  id: string;
}

/** The entry's client-chosen ID, with the JSON of the content it was minted for. */
export interface Draft {
  id: string;
  content: string;
}

export interface Size {
  width: number;
  height: number;
}

export interface Derivatives<B = Blob> {
  width: number;
  height: number;
  display: B | null;
  thumb: B | null;
}

/** The browser's clock and time zone. Passing one in keeps the functions below deterministic. */
export interface Clock {
  /** The current instant. */
  now(): Date;
  /** The browser's offset in minutes east of UTC at an instant. */
  offsetAt(instant: Date): number;
  /** The instant of a local wall-clock time. The month counts from zero, as in the Date constructor. */
  localInstant(year: number, monthIndex: number, day: number, hour: number, minute: number): Date;
}

/** This browser's clock and time zone. The pages pass it to the functions above; the functions themselves never read it. */
export const browserClock: Clock = {
  now: () => new Date(),
  offsetAt: (instant) => -instant.getTimezoneOffset(),
  localInstant: (year, monthIndex, day, hour, minute) => new Date(year, monthIndex, day, hour, minute),
};

function pad2(value: number): string {
  return (value < 10 ? '0' : '') + value;
}

/** Local wall-clock text for an instant, such as 2025-05-01T14:30, the form a datetime-local field uses. */
export function wallTimeOf(instant: Date): string {
  return instant.getFullYear() + '-' + pad2(instant.getMonth() + 1) + '-' + pad2(instant.getDate())
    + 'T' + pad2(instant.getHours()) + ':' + pad2(instant.getMinutes());
}

/** The current wall-clock time, which the time field shows when no photo supplies one. */
export function currentWall(clock: Clock): string {
  return wallTimeOf(clock.now());
}

/** An offset such as +09:00 or -05:30, for minutes east of UTC. */
export function offsetText(minutes: number): string {
  const size = Math.abs(minutes);
  return (minutes < 0 ? '-' : '+') + pad2(Math.floor(size / 60)) + ':' + pad2(size % 60);
}

/** Whether a value from the time field is a local time, with optional seconds. */
export function isWallTime(value: string): boolean {
  return WALL_TIME.test(value);
}

/** The browser's offset at a local wall-clock time such as 2025-05-01T14:30. The browser looks it up for that date. */
export function browserOffset(wall: string, clock: Clock): number {
  const parts = wall.split(/[-T:]/).map(Number);
  return clock.offsetAt(clock.localInstant(parts[0], parts[1] - 1, parts[2], parts[3], parts[4]));
}

/**
 * The capture time of a JPEG as an ISO time with offset, or null. The photo's own offset is used when it has one;
 * otherwise the browser's offset for the photo's date is used.
 */
export function takenAtOf(bytes: Uint8Array, clock: Clock): string | null {
  // The first pass gives the wall-clock time. The second pass supplies the offset for that date.
  const guess = readJpegTakenAt(bytes, clock.offsetAt(clock.now()));
  return guess === null ? null : readJpegTakenAt(bytes, browserOffset(guess.slice(0, 16), clock));
}

/**
 * The photo's own OffsetTimeOriginal, or null. readJpegTakenAt returns its fallback only when the photo has no offset,
 * so two different fallbacks give the same time exactly when the offset is the photo's own.
 */
export function ownOffsetOf(bytes: Uint8Array): string | null {
  const asZero = readJpegTakenAt(bytes, 0);
  const asSixty = readJpegTakenAt(bytes, 60);
  return asZero !== null && asZero === asSixty ? asZero.slice(19) : null;
}

/** Whether the bytes start with the JPEG start-of-image marker and the first byte of the next marker. */
export function looksLikeJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** Lower-case hex text for every byte of a buffer. */
export function hexOf(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let text = '';
  for (let i = 0; i < bytes.length; i++) text += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  return text;
}

/** The text to show for a thrown value: its own message, or the generic text when it has none. */
export function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : TEXT.genericError;
}

/** The `message` field of a JSON error body, when the body has one. */
export function errorMessageOf(data: unknown): unknown {
  return typeof data === 'object' && data !== null && 'message' in data ? data.message : undefined;
}

/** The text to show when an API response failed, or null when it succeeded. A 401 always ends the session. */
export function failureMessage(status: number, data: unknown): string | null {
  if (status === 401) return TEXT.sessionEnded;
  if (status >= 200 && status < 300) return null;
  return String(errorMessageOf(data) || 'Request failed (HTTP ' + status + ').');
}

/** The fetch options for a request. The shape matches what fetch receives. */
export interface RequestPlan {
  method: string;
  credentials: 'same-origin';
  headers: Record<string, string>;
  body?: FormData | string;
}

/**
 * The fetch options for a same-origin request. Writes carry the page's CSRF token. A JSON body is sent as text, and
 * FormData is sent as it is. The header order is the order the server has always seen.
 */
export function requestPlan(method: string, csrf: string, body?: FormData | object): RequestPlan {
  const headers: Record<string, string> = {};
  const plan: RequestPlan = { method, credentials: 'same-origin', headers };
  if (method !== 'GET') headers['X-CSRF-Token'] = csrf;
  if (body instanceof FormData) {
    plan.body = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    plan.body = JSON.stringify(body);
  }
  return plan;
}

/** The path of one page of /api/related. The first page has no cursor. */
export function relatedPagePath(afterId: string | null): string {
  return '/api/related' + (afterId === null ? '' : '?afterId=' + encodeURIComponent(afterId));
}

/** The path of one photo record. */
export function mediaPath(mediaId: string): string {
  return '/api/media/' + encodeURIComponent(mediaId);
}

/** The path of a saved photo's thumbnail. */
export function thumbPath(mediaId: string | null): string {
  return mediaPath(String(mediaId)) + '/' + THUMB_VARIANT;
}

/**
 * Follows every page of /api/related through fetchPage, which receives each page's path. The loop ends at a page with
 * no cursor, at a page that repeats the cursor it was asked with, or after 1000 pages. Pages can hold fewer items,
 * because the server filters each page.
 */
export async function loadAllRelated(fetchPage: (path: string) => Promise<RelatedPage>): Promise<RelatedItem[]> {
  let items: RelatedItem[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_RELATED_PAGES; page++) {
    const data = await fetchPage(relatedPagePath(after));
    items = items.concat(data.items);
    if (!data.nextAfterId || data.nextAfterId === after) break;
    after = data.nextAfterId;
  }
  return items;
}

/** A heading and the items under it, in the order the list shows them. */
export interface RelatedGroup {
  heading: string;
  items: RelatedItem[];
}

const RELATED_KINDS: ReadonlyArray<readonly [RelatedItem['kind'], string]> = [['person', 'People'], ['place', 'Places']];

/** The people, then the places. A group with no items is left out, and other kinds are not listed. */
export function groupRelated(items: RelatedItem[]): RelatedGroup[] {
  return RELATED_KINDS
    .map(([kind, heading]) => ({ heading, items: items.filter((item) => item.kind === kind) }))
    .filter((group) => group.items.length > 0);
}

/**
 * The entry's occurredAt: undefined when the time field is empty, otherwise the local time with seconds and an offset.
 * The offset is the photo's own when the first photo had one, and the browser's offset for that date otherwise.
 * Throws when the field is not a local time.
 */
export function occurredAtOf(wall: string, exifOffset: string | null, clock: Clock): string | undefined {
  if (!wall) return undefined;
  if (!isWallTime(wall)) throw new Error(TEXT.badWhen);
  const zone = exifOffset || offsetText(browserOffset(wall, clock));
  return (wall.length === 16 ? wall + ':00' : wall) + zone;
}

/** The content of a new entry. Empty optional fields are left out, and the keys are in request order. */
export function entryContent(text: string, occurredAt: string | undefined, relatedIds: string[]): EntryContent {
  const content: EntryContent = { text };
  if (occurredAt !== undefined) content.occurredAt = occurredAt;
  if (relatedIds.length > 0) content.relatedIds = relatedIds;
  return content;
}

/**
 * The draft that a save uses. The previous draft is kept while the content is unchanged, so a retry replays the same
 * entry. Changed content gets a new ID, because the server refuses to replay an ID with other content. newId is called
 * only when a new ID is needed.
 */
export function draftFor(previous: Draft | null, content: EntryContent, newId: () => string): Draft {
  const key = JSON.stringify(content);
  return previous !== null && previous.content === key ? previous : { id: newId(), content: key };
}

/** The POST /api/entries body: the draft's ID first, then the content. */
export function entryBody(draft: Draft, content: EntryContent): EntryBody {
  return { id: draft.id, ...content };
}

/** Whether a first save has nothing to save. */
export function isMissingWords(memoryId: string | null, text: string): boolean {
  return memoryId === null && text === '';
}

/** Throws when an original photo is over the 25 MB limit. */
export function checkOriginalSize(size: number): void {
  if (size > MAX_ORIGINAL_BYTES) throw new Error(TEXT.tooLarge);
}

/** The size of a JPEG whose longer edge is at most `edge`, keeping the shape. A photo is never enlarged. */
export function fitEdges(width: number, height: number, edge: number): Size {
  const scale = Math.min(1, edge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** The item when it is within the limit, otherwise null. A missing item stays missing. */
export function keepIfWithin<T extends { size: number }>(item: T | null, limit: number): T | null {
  return item !== null && item.size <= limit ? item : null;
}

/** The decoded size, with each preview kept only when it is within its own limit. */
export function derivativesOf<B extends { size: number }>(width: number, height: number, display: B | null, thumb: B | null): Derivatives<B> {
  return { width, height, display: keepIfWithin(display, MAX_DISPLAY_BYTES), thumb: keepIfWithin(thumb, MAX_THUMB_BYTES) };
}

/** The multipart body of POST /api/media. A field the photo does not have is left out. */
export function photoForm(file: File, sha256: string, takenAt: string | null, derived: Derivatives<Blob> | null, memoryId: string | null): FormData {
  const body = new FormData();
  body.append('original', file, file.name || 'photo.jpg');
  body.append('sha256', sha256);
  if (takenAt !== null) body.append('takenAt', takenAt);
  appendDerivatives(body, derived);
  // String() gives the same text that FormData.append would send for a null memory ID.
  body.append('memoryId', String(memoryId));
  return body;
}

function appendDerivatives(body: FormData, derived: Derivatives<Blob> | null): void {
  if (derived === null) return;
  body.append('width', String(derived.width));
  body.append('height', String(derived.height));
  if (derived.display !== null) body.append('display', derived.display, 'display.jpg');
  if (derived.thumb !== null) body.append('thumb', derived.thumb, 'thumb.jpg');
}

/** The status text for a photo that is saved. */
export function photoOutcome(input: {
  duplicate: boolean;
  mediaMemoryId: string | null;
  entryMemoryId: string | null;
  derived: Derivatives<Blob> | null;
}): string {
  if (input.mediaMemoryId !== input.entryMemoryId) return TEXT.savedElsewhere;
  if (input.duplicate) return TEXT.savedDuplicate;
  const previewed = input.derived !== null && input.derived.display !== null;
  return previewed ? TEXT.savedPhoto : TEXT.savedWithoutPreview;
}

/** Whether a duplicate photo still has to be linked to this entry. */
export function needsLink(result: UploadResult): boolean {
  return result.duplicate && result.media.memoryId === null;
}

/**
 * The PATCH body that links a photo to the entry. Both fields are required on every PATCH, so the photo's current
 * version and caption are sent back unchanged.
 */
export function linkBody(media: MediaRecord, memoryId: string | null): { expectedVersion: number; memoryId: string | null; caption: string | null } {
  return { expectedVersion: media.version, memoryId, caption: media.caption };
}

/** The name to show for a photo. */
export function displayNameOf(file: File): string {
  return file.name || TEXT.untitledPhoto;
}

/** The items that still need uploading, in order. */
export function pendingOf<T extends { done: boolean }>(queue: T[]): T[] {
  return queue.filter((item) => !item.done);
}

/** The items that are saved, in order. */
export function doneOf<T extends { done: boolean }>(queue: T[]): T[] {
  return queue.filter((item) => item.done);
}

/** The status after a save that left photos behind, or null when no photo is left. */
export function pendingNotice(pendingCount: number): string | null {
  return pendingCount > 0
    ? 'The entry is saved, but ' + pendingCount + ' photo(s) did not upload. Press Retry photos to try them again.'
    : null;
}

/** The save form's controls: the entry fields lock while saving or once the entry exists, and the button says what it does next. */
export function controlsFor(busy: boolean, memoryId: string | null): { entryLocked: boolean; saveDisabled: boolean; saveLabel: string } {
  return {
    entryLocked: busy || memoryId !== null,
    saveDisabled: busy,
    saveLabel: busy ? TEXT.saving : memoryId !== null ? TEXT.retryPhotos : TEXT.saveEntry,
  };
}

/** The class name of the status line. */
export function statusClassOf(isError: boolean): string {
  return isError ? 'error' : '';
}

/** The time and offset that a photo selection pre-fills. Both are null when the photo has no capture time. */
export interface Prefill {
  wall: string | null;
  offset: string | null;
}

/** The pre-fill that a JPEG's bytes give. */
export function prefillFromPhoto(bytes: Uint8Array, clock: Clock): Prefill {
  const taken = takenAtOf(bytes, clock);
  return taken === null ? { wall: null, offset: null } : { wall: taken.slice(0, 16), offset: ownOffsetOf(bytes) };
}

/**
 * Reads the first JPEG of a selection and passes its pre-fill to `use`. The first JPEG decides, whether or not it has an
 * EXIF time. With no JPEG, `use` receives nulls. `use` runs in the same step that reads the last bytes it needs, so the
 * caller can act on the answer without waiting for another step.
 */
export async function prefillFrom(files: Blob[], clock: Clock, use: (found: Prefill) => void): Promise<void> {
  for (const file of files) {
    const head = new Uint8Array(await file.slice(0, 3).arrayBuffer());
    if (!looksLikeJpeg(head)) continue;
    use(prefillFromPhoto(new Uint8Array(await file.arrayBuffer()), clock));
    return;
  }
  use({ wall: null, offset: null });
}

/** The two languages the dictation button recognises. The page's language select offers the same two. */
export const DICTATION_LANGUAGES = ['zh-CN', 'en-US'] as const;
export type DictationLanguage = (typeof DICTATION_LANGUAGES)[number];

/** The language for a browser with no stored choice: Chinese for a zh browser language, English otherwise. */
export function defaultDictationLanguage(browserLanguage: string): DictationLanguage {
  return browserLanguage.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
}

/** The stored choice when it is one of the two languages, otherwise null. Any other stored text is ignored. */
export function storedDictationLanguage(stored: string | null): DictationLanguage | null {
  return DICTATION_LANGUAGES.find((language) => language === stored) ?? null;
}

/** The language a page starts with: a valid stored choice, or else the default for the browser's language. */
export function dictationLanguageFor(stored: string | null, browserLanguage: string): DictationLanguage {
  return storedDictationLanguage(stored) ?? defaultDictationLanguage(browserLanguage);
}

/** The text of the entry after a dictated transcript replaces text[start:end], and the caret position after it. */
export interface InsertResult {
  text: string;
  caret: number;
}

/** A space separates the transcript from a neighbouring character only in English, and only when that character is not a space. */
function joinSpace(neighbour: string, lang: DictationLanguage): string {
  return lang === 'en-US' && /\S/.test(neighbour) ? ' ' : '';
}

/**
 * Puts a dictated transcript in place of text[start:end]. The transcript is trimmed, and a blank one changes nothing.
 * In English a single space separates it from a non-space character on either side. Chinese text gets no spaces.
 * The caret goes after the inserted text, including a space that was added after it.
 */
export function insertTranscript(text: string, start: number, end: number, transcript: string, lang: DictationLanguage): InsertResult {
  const spoken = transcript.trim();
  if (spoken === '') return { text, caret: end };
  const before = text.slice(0, start);
  const after = text.slice(end);
  const inserted = joinSpace(before.slice(-1), lang) + spoken + joinSpace(after.charAt(0), lang);
  return { text: before + inserted + after, caret: before.length + inserted.length };
}

/** One result as the browser reports it: whether it is final, and its best transcript. */
export interface SpeechResultLike {
  readonly isFinal: boolean;
  readonly 0: { readonly transcript: string };
}

/**
 * The final transcripts from resultIndex on, in order, and the interim text that is still changing. Only the final
 * transcripts go into the entry. The interim text is shown on the status line and nowhere else.
 */
export function splitResults(results: ArrayLike<SpeechResultLike>, resultIndex: number): { finals: string[]; interim: string } {
  const finals: string[] = [];
  let interim = '';
  for (let index = resultIndex; index < results.length; index++) {
    const result = results[index];
    if (result.isFinal) finals.push(result[0].transcript);
    else interim += result[0].transcript;
  }
  return { finals, interim };
}

/** The final transcripts of one result event as one piece of text: each trimmed, joined by a space in English and by nothing in Chinese. */
export function joinTranscripts(parts: string[], lang: DictationLanguage): string {
  return parts.map((part) => part.trim()).filter((part) => part !== '').join(lang === 'en-US' ? ' ' : '');
}

const DICTATION_ERROR_TEXT = new Map<string, string>([
  ['not-allowed', TEXT.dictateDenied],
  ['service-not-allowed', TEXT.dictateDenied],
  ['no-speech', TEXT.dictateNoSpeech],
  ['audio-capture', TEXT.dictateNoMic],
  ['network', TEXT.dictateNetwork],
]);

/** The status text for a recognition error code. An aborted recognition was stopped on purpose, so it shows nothing (null). */
export function dictationErrorMessage(code: string): string | null {
  if (code === 'aborted') return null;
  return DICTATION_ERROR_TEXT.get(code) ?? TEXT.dictateStopped + code;
}
