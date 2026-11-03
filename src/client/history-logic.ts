import { TEXT, browserOffset, failureMessage, isWallTime, linkBody, mediaPath, offsetText } from './capture-logic.ts';
import type { Clock, MediaRecord, RelatedItem } from './capture-logic.ts';

/**
 * The part of the /capture/history page that needs no DOM: the paged loads of entries, of each entry's photos and of the
 * unlinked photos, the list order, the times and days as the lists and the editor show them, the body of an edit, the
 * bodies of a photo change, and the text for a refused edit or photo change.
 * The clock comes in as a parameter, so each function returns the same result for the same inputs.
 *
 * The server stores every time in UTC, so a stored time has no offset of its own. The page shows it in the browser's
 * zone at that instant. A time that does carry an offset, such as +09:00, is shown with that offset as written.
 */

const MAX_PAGES = 1000;
const WALL_LENGTH = 16; // 2025-05-01T14:30
const DAY_LENGTH = 10; // 2025-05-01
// The offset at the end of a stored time, such as +09:00 or -05:30. A UTC time ends in Z and has none.
const WRITTEN_OFFSET = /[+-]\d{2}:\d{2}$/;

// Every sentence this page shows that capture-logic.ts does not already have. The page writes each one with textContent.
export const HISTORY_TEXT = {
  loading: 'Loading past entries…',
  none: 'No entries yet.',
  loadFailed: 'Could not load past entries. ',
  edit: 'Edit',
  saveChanges: 'Save changes',
  cancel: 'Cancel',
  conflict: 'This entry was changed elsewhere. Reload to see the latest version.',
  entryText: 'Entry text',
  when: 'When',
  unknownTime: 'Time unknown',
  relatedLegend: 'People and places',
  linkedWith: 'With: ',
  photoAlt: 'Photo',
  photosFailed: 'Could not load photos.',
  photos: 'Photos',
  photosHint: 'Changes to photos take effect at once. They do not wait for Save changes.',
  addPhotos: 'Add photos',
  loadingPhotos: 'Loading photos…',
  noEntryPhotos: 'No photos on this entry.',
  removeFromEntry: 'Remove from entry',
  deletePhoto: 'Delete permanently',
  deleteConfirm: 'Delete this photo permanently? This cannot be undone.',
  addFromUnlinked: 'Add from unlinked photos',
  attach: 'Attach',
  noUnlinked: 'No unlinked photos.',
  unlinkedFailed: 'Could not load unlinked photos.',
  unknownDate: 'Date unknown',
  photoConflict: 'This photo was changed elsewhere. Reload to see the latest version.',
  photoRemoved: 'Photo removed from this entry. It is now under Unlinked photos.',
  photoAttached: 'Photo added to this entry.',
  photoDeleted: 'Photo deleted.',
} as const;

/** An entry as the history API returns it: an event's current content, with its first text left out. */
export interface EntryItem {
  id: string;
  kind: 'event';
  text: string;
  occurredAt: string | null;
  relatedIds: string[];
  createdAt: string;
  updatedAt: string;
  version: number;
}

/** One page of /api/entries. A page can hold fewer items than its limit, or none, and still have a cursor. */
export interface EntryPage {
  items: EntryItem[];
  nextAfterId: string | null;
}

/** One photo as the photo list returns it. takenAt is when the photo was taken, or null when the photo has no time. */
export interface PhotoItem extends MediaRecord {
  takenAt: string | null;
}

/** One page of the photo list, from /api/media: the photos of one entry, or the photos that no entry holds. */
export interface MediaPage {
  items: PhotoItem[];
  nextAfterId: string | null;
}

/** The PATCH body that changes a photo's entry. Both fields are required, so the photo's version and caption go back unchanged. */
export interface PhotoLinkBody {
  expectedVersion: number;
  memoryId: string | null;
  caption: string | null;
}

/** The response to a saved edit. */
export interface EntryEnvelope {
  memory: EntryItem;
}

/** The PATCH body of an edit. The server replaces the time and the links on every edit, so both are always sent. */
export interface EditBody {
  expectedVersion: number;
  text: string;
  occurredAt: string | null;
  relatedIds: string[];
}

/** The path of one page of /api/entries. The first page has no cursor. */
export function entriesPagePath(afterId: string | null): string {
  return '/api/entries' + (afterId === null ? '' : '?afterId=' + encodeURIComponent(afterId));
}

/** The path of one page of the photos linked to an entry. The first page has no cursor. */
export function entryPhotosPath(memoryId: string, afterId: string | null): string {
  return '/api/media?memoryId=' + encodeURIComponent(memoryId) + (afterId === null ? '' : '&afterId=' + encodeURIComponent(afterId));
}

/** The path of one page of the photos that no entry holds. The first page has no cursor. */
export function unlinkedPhotosPath(afterId: string | null): string {
  return '/api/media?unlinked=1' + (afterId === null ? '' : '&afterId=' + encodeURIComponent(afterId));
}

/** The path of one photo's display JPEG, which a photo opens from. */
export function displayPath(photoId: string): string {
  return mediaPath(photoId) + '/display';
}

/** The path of one entry, which its edit is sent to. */
export function entryPath(id: string): string {
  return '/api/entries/' + encodeURIComponent(id);
}

/**
 * Follows every page of a cursor-paged list through fetchPage, which receives each page's path. The loop ends at a page with
 * no cursor, at a cursor that an earlier page already gave, or after 1000 pages. A page can hold fewer items than its limit,
 * or none, and still have a cursor, so the cursor alone decides whether to go on.
 */
async function loadAllPages<Item>(
  pathAt: (afterId: string | null) => string,
  fetchPage: (path: string) => Promise<{ items: Item[]; nextAfterId: string | null }>,
): Promise<Item[]> {
  let items: Item[] = [];
  let after: string | null = null;
  const given = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await fetchPage(pathAt(after));
    items = items.concat(data.items);
    const next = data.nextAfterId;
    if (!next || given.has(next)) break;
    given.add(next);
    after = next;
  }
  return items;
}

/** Every entry, following the cursor of each page through fetchPage. */
export function loadAllEntries(fetchPage: (path: string) => Promise<EntryPage>): Promise<EntryItem[]> {
  return loadAllPages(entriesPagePath, fetchPage);
}

/** Every photo linked to one entry, following the cursor of each page through fetchPage. */
export function loadAllPhotos(memoryId: string, fetchPage: (path: string) => Promise<MediaPage>): Promise<PhotoItem[]> {
  return loadAllPages((afterId) => entryPhotosPath(memoryId, afterId), fetchPage);
}

/** Every photo that no entry holds, following the cursor of each page through fetchPage. */
export function loadAllUnlinked(fetchPage: (path: string) => Promise<MediaPage>): Promise<PhotoItem[]> {
  return loadAllPages(unlinkedPhotosPath, fetchPage);
}

/** Newest first: an entry with a time comes first, by that time. An entry without one comes after, newest saved first. Ties go by ID. */
export function sortEntries(items: EntryItem[]): EntryItem[] {
  return [...items].sort(compareEntries);
}

function compareEntries(a: EntryItem, b: EntryItem): number {
  if (a.occurredAt !== null && b.occurredAt !== null) return newestFirst(a.occurredAt, b.occurredAt) || byId(a, b);
  if (a.occurredAt !== null) return -1;
  if (b.occurredAt !== null) return 1;
  return newestFirst(a.createdAt, b.createdAt) || byId(a, b);
}

/** Negative when the first instant is the later one. Instants are compared as times, because the offsets in the text differ. */
function newestFirst(first: string, second: string): number {
  return Date.parse(second) - Date.parse(first);
}

function byId(a: EntryItem, b: EntryItem): number {
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** The offset a stored time was written with, or null when the stored text has none. */
function writtenOffsetOf(occurredAt: string): string | null {
  return occurredAt.match(WRITTEN_OFFSET)?.[0] ?? null;
}

/**
 * The wall-clock text of a stored time, such as 2025-05-01T14:30, as the time field shows it. A time with its own offset
 * is shown as written. A UTC time is shown in the browser's zone at that instant. An empty value gives ''.
 */
export function wallOfStored(occurredAt: string | null, clock: Clock): string {
  if (occurredAt === null) return '';
  if (writtenOffsetOf(occurredAt) !== null) return occurredAt.slice(0, WALL_LENGTH);
  const instant = new Date(occurredAt);
  return new Date(instant.getTime() + clock.offsetAt(instant) * 60_000).toISOString().slice(0, WALL_LENGTH);
}

/** The offset a stored time is shown with: the one it was written with, or else the browser's offset at that instant. */
function zoneTextOf(occurredAt: string, clock: Clock): string {
  return writtenOffsetOf(occurredAt) ?? offsetText(clock.offsetAt(new Date(occurredAt)));
}

/** The list label of a stored time, such as 2025-05-01 14:30 (+09:00), or Time unknown when there is no time. */
export function whenLabel(occurredAt: string | null, clock: Clock): string {
  if (occurredAt === null) return HISTORY_TEXT.unknownTime;
  return wallOfStored(occurredAt, clock).replace('T', ' ') + ' (' + zoneTextOf(occurredAt, clock) + ')';
}

/**
 * The day a photo was taken, such as 2025-05-01, in the zone its stored time is shown in. The server keeps a photo's time in
 * UTC, so the day is the browser's day at that instant. A photo with no time shows Date unknown.
 */
export function takenDateLabel(takenAt: string | null, clock: Clock): string {
  if (takenAt === null) return HISTORY_TEXT.unknownDate;
  return wallOfStored(takenAt, clock).slice(0, DAY_LENGTH);
}

/**
 * The stored time an edit sends. An empty field is an unknown time. A field still showing the stored wall time keeps the
 * stored text exactly, with its seconds, milliseconds and offset. Any other time gets the offset the entry was written
 * with, or else the browser's offset for that date. A field that is not a local time throws.
 */
export function editedOccurredAt(original: string | null, wall: string, clock: Clock): string | null {
  if (wall === '') return null;
  if (!isWallTime(wall)) throw new Error(TEXT.badWhen);
  if (original !== null && wall === wallOfStored(original, clock)) return original;
  const written = original === null ? null : writtenOffsetOf(original);
  const zone = written ?? offsetText(browserOffset(wall, clock));
  return (wall.length === WALL_LENGTH ? wall + ':00' : wall) + zone;
}

/** The PATCH body of an edit. The text is trimmed, and blank text throws before anything is sent. */
export function editBody(entry: EntryItem, text: string, occurredAt: string | null, relatedIds: string[]): EditBody {
  const spoken = text.trim();
  if (spoken === '') throw new Error(TEXT.needWords);
  return { expectedVersion: entry.version, text: spoken, occurredAt, relatedIds };
}

/**
 * The related IDs an edit sends: the boxes the page shows, as they are ticked, plus the entry's links that the page does not
 * show (such as a link to a record that is not a person or a place). An edit must not drop a link the user cannot see.
 */
export function linksToSave(entry: EntryItem, shownIds: readonly string[], checkedIds: readonly string[]): string[] {
  const shown = new Set(shownIds);
  return [...entry.relatedIds.filter((id) => !shown.has(id)), ...checkedIds];
}

/** The names of the people and places an entry is linked to, in the order the entry lists them. An unknown ID has no name. */
export function linkedNames(entry: EntryItem, related: readonly RelatedItem[]): string[] {
  const names = new Map(related.map((item) => [item.id, item.text] as const));
  return entry.relatedIds.flatMap((id) => names.get(id) ?? []);
}

/** The text to show when an edit is refused, or null when it went through. A changed entry has its own text. */
export function editFailureMessage(status: number, data: unknown): string | null {
  return status === 409 ? HISTORY_TEXT.conflict : failureMessage(status, data);
}

/** The list with one entry swapped for its saved version. The other entries keep their places. */
export function replaceEntry(items: EntryItem[], saved: EntryItem): EntryItem[] {
  return items.map((item) => (item.id === saved.id ? saved : item));
}

/** The PATCH body that takes a photo off its entry. The photo is kept, and it is listed as unlinked. */
export function unlinkBody(media: PhotoItem): PhotoLinkBody {
  return linkBody(media, null);
}

/** The PATCH body that puts an unlinked photo on an entry. */
export function attachBody(media: PhotoItem, entryId: string): PhotoLinkBody {
  return linkBody(media, entryId);
}

/** The DELETE body of a photo. Its version goes in, so a photo changed elsewhere is refused rather than deleted. */
export function photoDeleteBody(media: PhotoItem): { expectedVersion: number } {
  return { expectedVersion: media.version };
}

/** The text to show when a photo change is refused, or null when it went through. A changed photo has its own text. */
export function photoFailureMessage(status: number, data: unknown): string | null {
  return status === 409 ? HISTORY_TEXT.photoConflict : failureMessage(status, data);
}
