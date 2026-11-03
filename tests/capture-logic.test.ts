import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  DISPLAY_EDGE,
  THUMB_EDGE,
  browserOffset,
  checkOriginalSize,
  controlsFor,
  currentWall,
  defaultDictationLanguage,
  derivativesOf,
  dictationErrorMessage,
  dictationLanguageFor,
  displayNameOf,
  doneOf,
  draftFor,
  entryBody,
  entryContent,
  errorMessageOf,
  failureMessage,
  fitEdges,
  groupRelated,
  hexOf,
  insertTranscript,
  isMissingWords,
  isWallTime,
  joinTranscripts,
  keepIfWithin,
  linkBody,
  loadAllRelated,
  looksLikeJpeg,
  mediaPath,
  messageOf,
  needsLink,
  occurredAtOf,
  offsetText,
  ownOffsetOf,
  pendingNotice,
  pendingOf,
  photoForm,
  photoOutcome,
  prefillFrom,
  prefillFromPhoto,
  relatedPagePath,
  requestPlan,
  splitResults,
  statusClassOf,
  storedDictationLanguage,
  takenAtOf,
  thumbPath,
  wallTimeOf,
} from '../src/client/capture-logic.ts';
import type { Clock, RelatedItem, RelatedPage, UploadResult } from '../src/client/capture-logic.ts';

// Test-only JPEG and TIFF builders, little-endian, in the layout the page's own EXIF reader reads.
const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));
const u16 = (value: number): number[] => [value & 0xff, (value >> 8) & 0xff];
const u32 = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];

/** A TIFF block whose IFD0 points to an Exif sub-directory with DateTimeOriginal and, when given, OffsetTimeOriginal. */
function tiff(dateTime: string, zone?: string): number[] {
  const date = [...ascii(dateTime), 0];
  const offset = zone === undefined ? null : [...ascii(zone), 0];
  const entries = offset ? 2 : 1;
  const exifAt = 8 + 2 + 12 + 4;
  const dateAt = exifAt + 2 + entries * 12 + 4;
  const zoneAt = dateAt + date.length;
  return [
    ...ascii('II'), ...u16(42), ...u32(8),
    ...u16(1), ...u16(0x8769), ...u16(4), ...u32(1), ...u32(exifAt), ...u32(0),
    ...u16(entries),
    ...u16(0x9003), ...u16(2), ...u32(date.length), ...u32(dateAt),
    ...(offset ? [...u16(0x9011), ...u16(2), ...u32(offset.length), ...u32(zoneAt)] : []),
    ...u32(0),
    ...date,
    ...(offset ?? []),
  ];
}

/** A JPEG with one APP1 segment. JPEG segment lengths are big-endian, unlike the little-endian TIFF block inside them. */
function jpeg(tiffBytes: number[]): Uint8Array<ArrayBuffer> {
  const app1 = [...ascii('Exif'), 0, 0, ...tiffBytes];
  const length = app1.length + 2;
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, (length >> 8) & 0xff, length & 0xff, ...app1, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
}

/** A JPEG whose EXIF block gives the capture time, and its offset when `zone` is set. */
const exifJpeg = (dateTime: string, zone?: string): Uint8Array<ArrayBuffer> => jpeg(tiff(dateTime, zone));
const jpegNoExif = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02]);
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A clock whose zone is the same at every instant. The browser's own clock is the one thing these tests replace. */
const fixedZone = (zoneMinutes: number, now = new Date(Date.UTC(2025, 0, 1))): Clock => zoneClock(() => zoneMinutes, now);

/** A clock whose zone depends on the instant, such as a summer and a winter offset. */
function zoneClock(zoneAt: (instant: Date) => number, now: Date): Clock {
  return {
    now: () => new Date(now.getTime()),
    offsetAt: (instant) => zoneAt(instant),
    localInstant: (year, monthIndex, day, hour, minute) => {
      const asUtc = Date.UTC(year, monthIndex, day, hour, minute);
      return new Date(asUtc - zoneAt(new Date(asUtc)) * 60_000);
    },
  };
}

const item = (id: string, kind: RelatedItem['kind'], text: string): RelatedItem => ({ id, kind, text });

test('wallTimeOf writes the local date and time with two digits in each field', () => {
  assert.equal(wallTimeOf(new Date(2025, 0, 2, 3, 4)), '2025-01-02T03:04');
  assert.equal(wallTimeOf(new Date(2025, 11, 31, 23, 59)), '2025-12-31T23:59');
  assert.equal(wallTimeOf(new Date(2025, 9, 10, 10, 10)), '2025-10-10T10:10');
});

test('currentWall reads the current time from the clock', () => {
  assert.equal(currentWall(fixedZone(0, new Date(2025, 4, 1, 14, 30))), '2025-05-01T14:30');
});

test('offsetText signs the offset and shows hours and minutes', () => {
  assert.equal(offsetText(540), '+09:00');
  assert.equal(offsetText(-300), '-05:00');
  assert.equal(offsetText(330), '+05:30');
  assert.equal(offsetText(-570), '-09:30');
  assert.equal(offsetText(825), '+13:45');
  assert.equal(offsetText(0), '+00:00');
});

test('isWallTime accepts a local time with optional seconds and nothing else', () => {
  assert.equal(isWallTime('2025-05-01T14:30'), true);
  assert.equal(isWallTime('2025-05-01T14:30:15'), true);
  assert.equal(isWallTime('2025-05-01 14:30'), false);
  assert.equal(isWallTime('2025-05-01T14:30:15.5'), false);
  assert.equal(isWallTime('tomorrow'), false);
  assert.equal(isWallTime(''), false);
});

test('browserOffset passes the wall-clock parts with a zero-based month', () => {
  const calls: number[][] = [];
  const clock: Clock = {
    now: () => new Date(0),
    offsetAt: () => 540,
    localInstant: (...parts) => {
      calls.push(parts);
      return new Date(0);
    },
  };
  assert.equal(browserOffset('2025-05-01T14:30:45', clock), 540);
  assert.deepEqual(calls, [[2025, 4, 1, 14, 30]]);
});

test('browserOffset reads the zone at the wall-clock time, so a winter time gets the winter offset', () => {
  const clock = zoneClock((instant) => (instant.getUTCMonth() >= 2 && instant.getUTCMonth() <= 9 ? 600 : 480), new Date(Date.UTC(2025, 6, 1)));
  assert.equal(browserOffset('2025-01-15T10:00', clock), 480);
  assert.equal(browserOffset('2025-07-15T10:00', clock), 600);
});

test('takenAtOf keeps the photo offset, and otherwise uses the browser offset for the photo date', () => {
  const tokyo = fixedZone(540);
  assert.equal(takenAtOf(exifJpeg('2025:05:01 14:30:00', '+09:00'), tokyo), '2025-05-01T14:30:00+09:00');
  assert.equal(takenAtOf(exifJpeg('2025:05:01 14:30:00'), tokyo), '2025-05-01T14:30:00+09:00');
  const kolkata = fixedZone(330);
  assert.equal(takenAtOf(exifJpeg('2025:05:01 14:30:00', '-05:00'), kolkata), '2025-05-01T14:30:00-05:00');
  assert.equal(takenAtOf(exifJpeg('2025:05:01 14:30:00'), kolkata), '2025-05-01T14:30:00+05:30');
  assert.equal(takenAtOf(jpegNoExif, tokyo), null);
  assert.equal(takenAtOf(png, tokyo), null);
});

test('takenAtOf asks for the offset that applied on the photo date, not the one in force today', () => {
  const summerNow = zoneClock((instant) => (instant.getUTCMonth() >= 2 && instant.getUTCMonth() <= 9 ? 600 : 480), new Date(Date.UTC(2025, 6, 1)));
  assert.equal(takenAtOf(exifJpeg('2025:01:15 10:00:00'), summerNow), '2025-01-15T10:00:00+08:00');
});

test('takenAtOf reads the four-digit year, so the browser offset is the one for that year', () => {
  const byYear = zoneClock((instant) => (instant.getFullYear() === 2025 ? 480 : 0), new Date(Date.UTC(2025, 6, 1)));
  assert.equal(takenAtOf(exifJpeg('2025:01:15 10:00:00'), byYear), '2025-01-15T10:00:00+08:00');
});

test('ownOffsetOf returns the photo own offset, or null when the photo has none', () => {
  assert.equal(ownOffsetOf(exifJpeg('2025:05:01 14:30:00', '-05:00')), '-05:00');
  assert.equal(ownOffsetOf(exifJpeg('2025:05:01 14:30:00')), null);
  assert.equal(ownOffsetOf(jpegNoExif), null);
});

test('prefillFromPhoto gives the wall time to the minute, with the photo own offset', () => {
  assert.deepEqual(prefillFromPhoto(exifJpeg('2025:05:01 14:30:45', '+09:00'), fixedZone(0)), { wall: '2025-05-01T14:30', offset: '+09:00' });
  assert.deepEqual(prefillFromPhoto(exifJpeg('2025:05:01 14:30:45'), fixedZone(330)), { wall: '2025-05-01T14:30', offset: null });
  assert.deepEqual(prefillFromPhoto(jpegNoExif, fixedZone(0)), { wall: null, offset: null });
});

test('prefillFrom reads the first JPEG only, and passes its answer to use once', async () => {
  const clock = fixedZone(0);
  const withZone = new File([exifJpeg('2025:05:01 14:30:00', '+09:00')], 'a.jpg');
  const withoutZone = new File([exifJpeg('2024:01:01 08:00:00')], 'b.jpg');
  const noExif = new File([jpegNoExif], 'c.jpg');
  const picture = new File([png], 'd.png');
  const answers = async (files: Blob[]): Promise<unknown[]> => {
    const got: unknown[] = [];
    await prefillFrom(files, clock, (found) => { got.push(found); });
    return got;
  };
  assert.deepEqual(await answers([picture, withZone, withoutZone]), [{ wall: '2025-05-01T14:30', offset: '+09:00' }]);
  assert.deepEqual(await answers([picture, withoutZone]), [{ wall: '2024-01-01T08:00', offset: null }]);
  assert.deepEqual(await answers([noExif, withZone]), [{ wall: null, offset: null }]);
  assert.deepEqual(await answers([picture]), [{ wall: null, offset: null }]);
  assert.deepEqual(await answers([]), [{ wall: null, offset: null }]);
});

test('prefillFrom rejects when a file cannot be read, so the page can fall back to the current time', async () => {
  const unreadable = { slice: () => { throw new Error('no slice'); } } as unknown as Blob;
  await assert.rejects(prefillFrom([unreadable], fixedZone(0), () => {}), { message: 'no slice' });
});

test('looksLikeJpeg needs the start-of-image marker and the first byte of the next marker', () => {
  assert.equal(looksLikeJpeg(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), true);
  assert.equal(looksLikeJpeg(Uint8Array.from([0xff, 0xd8, 0xff])), true);
  assert.equal(looksLikeJpeg(Uint8Array.from([0xff, 0xd8])), false);
  assert.equal(looksLikeJpeg(Uint8Array.from([0xff, 0xd8, 0x00])), false);
  assert.equal(looksLikeJpeg(png), false);
  assert.equal(looksLikeJpeg(new Uint8Array(0)), false);
});

test('hexOf writes two lower-case digits for each byte', () => {
  assert.equal(hexOf(Uint8Array.from([0, 15, 16, 255]).buffer), '000f10ff');
  assert.equal(hexOf(new ArrayBuffer(0)), '');
});

test('messageOf shows an error message, and the generic text when there is none', () => {
  const generic = 'Something went wrong. What you typed is still here; try again.';
  assert.equal(messageOf(new Error('Boom')), 'Boom');
  assert.equal(messageOf(new Error('')), generic);
  assert.equal(messageOf('text'), generic);
  assert.equal(messageOf({ message: 'not an Error' }), generic);
  assert.equal(messageOf(undefined), generic);
});

test('errorMessageOf reads the message field of an object and nothing else', () => {
  assert.equal(errorMessageOf({ message: 'Bad' }), 'Bad');
  assert.equal(errorMessageOf({ message: 42 }), 42);
  assert.equal(errorMessageOf({}), undefined);
  assert.equal(errorMessageOf(null), undefined);
  assert.equal(errorMessageOf('text'), undefined);
});

test('failureMessage: 401 ends the session, 2xx is a success, and other errors show the server message or the status', () => {
  assert.equal(failureMessage(401, { message: 'Nope' }), 'Your session has ended. Reload the page and sign in again.');
  assert.equal(failureMessage(200, null), null);
  assert.equal(failureMessage(201, {}), null);
  assert.equal(failureMessage(299, null), null);
  assert.equal(failureMessage(300, null), 'Request failed (HTTP 300).');
  assert.equal(failureMessage(400, { message: 'Bad input' }), 'Bad input');
  assert.equal(failureMessage(400, { message: '' }), 'Request failed (HTTP 400).');
  assert.equal(failureMessage(409, { message: 42 }), '42');
  assert.equal(failureMessage(500, null), 'Request failed (HTTP 500).');
});

test('requestPlan sends the CSRF token on writes only, and a JSON body as text in the page order', () => {
  assert.deepEqual(requestPlan('GET', 'tok'), { method: 'GET', credentials: 'same-origin', headers: {} });
  assert.equal('body' in requestPlan('GET', 'tok'), false);
  const post = requestPlan('POST', 'tok', { id: 'd1', text: 'Hi' });
  assert.equal(JSON.stringify(post.headers), '{"X-CSRF-Token":"tok","Content-Type":"application/json"}');
  assert.equal(post.body, '{"id":"d1","text":"Hi"}');
  const form = new FormData();
  const upload = requestPlan('POST', 'tok', form);
  assert.deepEqual(upload.headers, { 'X-CSRF-Token': 'tok' });
  assert.equal(upload.body, form);
});

test('relatedPagePath adds a percent-encoded cursor only after the first page', () => {
  assert.equal(relatedPagePath(null), '/api/related');
  assert.equal(relatedPagePath('abc'), '/api/related?afterId=abc');
  assert.equal(relatedPagePath('a b/&c'), '/api/related?afterId=a%20b%2F%26c');
});

test('mediaPath and thumbPath encode the photo ID in the path', () => {
  assert.equal(mediaPath('a/b c'), '/api/media/a%2Fb%20c');
  assert.equal(thumbPath('m1'), '/api/media/m1/thumb');
});

test('loadAllRelated requests each cursor in turn until a page has none', async () => {
  const pages: RelatedPage[] = [
    { items: [item('p1', 'person', 'Ana')], nextAfterId: 'c 1' },
    { items: [item('pl1', 'place', 'Cafe')], nextAfterId: 'c/2' },
    { items: [item('p2', 'person', 'Ben')], nextAfterId: null },
  ];
  const requested: string[] = [];
  const items = await loadAllRelated(async (path) => {
    requested.push(path);
    return pages[requested.length - 1];
  });
  assert.deepEqual(requested, ['/api/related', '/api/related?afterId=c%201', '/api/related?afterId=c%2F2']);
  assert.deepEqual(items.map((entry) => entry.id), ['p1', 'pl1', 'p2']);
});

test('loadAllRelated stops when a page repeats the cursor it was asked with, or returns an empty cursor', async () => {
  const repeating: RelatedPage[] = [
    { items: [item('a', 'person', 'A')], nextAfterId: 'c1' },
    { items: [item('b', 'person', 'B')], nextAfterId: 'c1' },
    { items: [item('z', 'person', 'Z')], nextAfterId: 'c2' },
  ];
  let calls = 0;
  const repeated = await loadAllRelated(async () => repeating[calls++]);
  assert.equal(calls, 2);
  assert.deepEqual(repeated.map((entry) => entry.id), ['a', 'b']);

  let emptyCalls = 0;
  const empty = await loadAllRelated(async () => {
    emptyCalls++;
    return { items: [item('e', 'place', 'Empty')], nextAfterId: '' };
  });
  assert.equal(emptyCalls, 1);
  assert.deepEqual(empty.map((entry) => entry.id), ['e']);
});

test('loadAllRelated asks for at most 1000 pages', async () => {
  let calls = 0;
  await loadAllRelated(async () => {
    calls++;
    return { items: [], nextAfterId: `c${calls}` };
  });
  assert.equal(calls, 1000);
});

test('loadAllRelated rejects when a page fails', async () => {
  let calls = 0;
  await assert.rejects(
    loadAllRelated(async () => {
      calls++;
      if (calls === 2) throw new Error('Request failed (HTTP 500).');
      return { items: [], nextAfterId: 'c1' };
    }),
    { message: 'Request failed (HTTP 500).' },
  );
});

test('groupRelated lists people before places, and leaves out empty groups and other kinds', () => {
  const groups = groupRelated([
    item('pl1', 'place', 'Cafe'),
    item('p1', 'person', 'Ana'),
    { id: 'x', kind: 'fact', text: 'ignored' } as unknown as RelatedItem,
    item('p2', 'person', 'Ben'),
  ]);
  assert.deepEqual(groups, [
    { heading: 'People', items: [item('p1', 'person', 'Ana'), item('p2', 'person', 'Ben')] },
    { heading: 'Places', items: [item('pl1', 'place', 'Cafe')] },
  ]);
  assert.deepEqual(groupRelated([]), []);
  assert.deepEqual(groupRelated([item('pl1', 'place', 'Cafe')]).map((group) => group.heading), ['Places']);
});

test('occurredAtOf adds seconds and the photo offset, or the browser offset for that date', () => {
  const kolkata = fixedZone(330);
  assert.equal(occurredAtOf('2025-05-01T14:30', '+09:00', kolkata), '2025-05-01T14:30:00+09:00');
  assert.equal(occurredAtOf('2025-05-01T14:30', null, kolkata), '2025-05-01T14:30:00+05:30');
  assert.equal(occurredAtOf('2025-05-01T14:30', '', kolkata), '2025-05-01T14:30:00+05:30');
  assert.equal(occurredAtOf('2025-05-01T14:30:15', null, fixedZone(0)), '2025-05-01T14:30:15+00:00');
  assert.equal(occurredAtOf('', null, kolkata), undefined);
  assert.throws(() => occurredAtOf('tomorrow', null, kolkata), { message: 'Choose a valid date and time.' });
});

test('entryContent keeps only the fields that have values, in request order', () => {
  assert.equal(JSON.stringify(entryContent('Hi', undefined, [])), '{"text":"Hi"}');
  assert.equal(JSON.stringify(entryContent('Hi', undefined, ['p1'])), '{"text":"Hi","relatedIds":["p1"]}');
  assert.equal(
    JSON.stringify(entryContent('Hi', '2025-05-01T14:30:00+09:00', ['p1'])),
    '{"text":"Hi","occurredAt":"2025-05-01T14:30:00+09:00","relatedIds":["p1"]}',
  );
});

test('a retry with the same content keeps the draft ID, so the server replays the same entry', () => {
  const minted: string[] = [];
  const newId = (): string => {
    const id = `id-${minted.length + 1}`;
    minted.push(id);
    return id;
  };
  const content = entryContent('Lost reply', '2025-05-01T14:30:00+09:00', ['p1']);
  const first = draftFor(null, content, newId);
  const retry = draftFor(first, entryContent('Lost reply', '2025-05-01T14:30:00+09:00', ['p1']), newId);
  assert.equal(retry, first);
  assert.equal(JSON.stringify(entryBody(retry, content)), '{"id":"id-1","text":"Lost reply","occurredAt":"2025-05-01T14:30:00+09:00","relatedIds":["p1"]}');
  assert.deepEqual(minted, ['id-1']);
});

test('changed text or a changed choice gets a new draft ID, and a first save always mints one', () => {
  let minted = 0;
  const newId = (): string => `id-${++minted}`;
  const first = draftFor(null, entryContent('First', undefined, []), newId);
  assert.equal(first.id, 'id-1');
  const edited = draftFor(first, entryContent('Second', undefined, []), newId);
  assert.equal(edited.id, 'id-2');
  assert.equal(JSON.stringify(entryBody(edited, entryContent('Second', undefined, []))), '{"id":"id-2","text":"Second"}');
  const choiceChanged = draftFor(edited, entryContent('Second', undefined, ['p1']), newId);
  assert.equal(choiceChanged.id, 'id-3');
  assert.equal(draftFor(null, entryContent('Second', undefined, []), newId).id, 'id-4');
});

test('photoForm names the original and derivatives, and sends the fields in the server order', async () => {
  const file = new File([exifJpeg('2025:05:01 14:30:00', '+09:00')], 'holiday.jpg', { type: 'image/jpeg' });
  const derived = { width: 1600, height: 1067, display: new Blob(['d']), thumb: new Blob(['t']) };
  const form = photoForm(file, 'abc123', '2025-05-01T14:30:00+09:00', derived, 'mem1');
  assert.deepEqual([...form.keys()], ['original', 'sha256', 'takenAt', 'width', 'height', 'display', 'thumb', 'memoryId']);
  assert.equal((form.get('original') as File).name, 'holiday.jpg');
  assert.equal((form.get('display') as File).name, 'display.jpg');
  assert.equal((form.get('thumb') as File).name, 'thumb.jpg');
  assert.equal(form.get('sha256'), 'abc123');
  assert.equal(form.get('takenAt'), '2025-05-01T14:30:00+09:00');
  assert.equal(form.get('width'), '1600');
  assert.equal(form.get('height'), '1067');
  assert.equal(form.get('memoryId'), 'mem1');
});

test('photoForm leaves out what the photo does not have, and sends a missing memory ID as text', () => {
  const bare = photoForm(new File([jpegNoExif], ''), 'h', null, null, null);
  assert.deepEqual([...bare.keys()], ['original', 'sha256', 'memoryId']);
  assert.equal((bare.get('original') as File).name, 'photo.jpg');
  assert.equal(bare.get('memoryId'), 'null');
  const thumbOnly = photoForm(new File([jpegNoExif], 'x.jpg'), 'h', null, { width: 400, height: 300, display: null, thumb: new Blob(['t']) }, 'm');
  assert.deepEqual([...thumbOnly.keys()], ['original', 'sha256', 'width', 'height', 'thumb', 'memoryId']);
  const displayOnly = photoForm(new File([jpegNoExif], 'y.jpg'), 'h', null, { width: 1600, height: 900, display: new Blob(['d']), thumb: null }, 'm');
  assert.deepEqual([...displayOnly.keys()], ['original', 'sha256', 'width', 'height', 'display', 'memoryId']);
});

test('photoOutcome names how the photo was saved, and a photo held by another entry wins', () => {
  const previewed = { width: 1, height: 1, display: new Blob(['d']), thumb: null };
  const unpreviewed = { width: 1, height: 1, display: null, thumb: null };
  const base = { duplicate: false, mediaMemoryId: 'mem1', entryMemoryId: 'mem1', derived: previewed };
  assert.equal(photoOutcome(base), 'Saved');
  assert.equal(photoOutcome({ ...base, derived: unpreviewed }), 'Saved without a preview');
  assert.equal(photoOutcome({ ...base, derived: null }), 'Saved without a preview');
  assert.equal(photoOutcome({ ...base, duplicate: true }), 'Saved (this photo was already in MeMem)');
  assert.equal(photoOutcome({ ...base, mediaMemoryId: 'other' }), 'Already saved to another entry');
  assert.equal(photoOutcome({ ...base, mediaMemoryId: 'other', duplicate: true }), 'Already saved to another entry');
});

test('linkBody sends the version and caption back unchanged, with the entry ID', () => {
  const media = { id: 'm1', memoryId: null, version: 3, caption: 'Beach' };
  assert.equal(JSON.stringify(linkBody(media, 'mem1')), '{"expectedVersion":3,"memoryId":"mem1","caption":"Beach"}');
});

test('needsLink is true only for a duplicate that is not linked to an entry yet', () => {
  const unlinked = { id: 'm', memoryId: null, version: 1, caption: null };
  const linked = { id: 'm', memoryId: 'mem1', version: 1, caption: null };
  const duplicate = (media: UploadResult['media']): UploadResult => ({ duplicate: true, media });
  assert.equal(needsLink(duplicate(unlinked)), true);
  assert.equal(needsLink(duplicate(linked)), false);
  assert.equal(needsLink({ duplicate: false, media: unlinked }), false);
});

test('checkOriginalSize allows exactly 25 MB and refuses anything larger', () => {
  assert.doesNotThrow(() => checkOriginalSize(25 * 1024 * 1024));
  assert.throws(() => checkOriginalSize(25 * 1024 * 1024 + 1), { message: 'This photo is larger than 25 MB.' });
});

test('the page asks for a 1600-pixel display photo and a 400-pixel thumbnail', () => {
  assert.equal(DISPLAY_EDGE, 1600);
  assert.equal(THUMB_EDGE, 400);
});

test('fitEdges scales the longer edge to the target, keeps the shape, and never enlarges', () => {
  assert.deepEqual(fitEdges(3000, 2000, DISPLAY_EDGE), { width: 1600, height: 1067 });
  assert.deepEqual(fitEdges(2000, 3000, DISPLAY_EDGE), { width: 1067, height: 1600 });
  assert.deepEqual(fitEdges(3000, 2000, THUMB_EDGE), { width: 400, height: 267 });
  assert.deepEqual(fitEdges(800, 600, DISPLAY_EDGE), { width: 800, height: 600 });
  assert.deepEqual(fitEdges(1, 1000, THUMB_EDGE), { width: 1, height: 400 });
  assert.deepEqual(fitEdges(0, 0, THUMB_EDGE), { width: 1, height: 1 });
});

test('keepIfWithin keeps a preview at its limit and drops one over it', () => {
  const atLimit = { size: 5 };
  assert.equal(keepIfWithin(atLimit, 5), atLimit);
  assert.equal(keepIfWithin({ size: 6 }, 5), null);
  assert.equal(keepIfWithin(null, 5), null);
});

test('derivativesOf keeps the decoded size and drops each preview that is over its own limit', () => {
  const thumb = { size: 1024 * 1024 };
  assert.deepEqual(derivativesOf(3000, 2000, { size: 5 * 1024 * 1024 + 1 }, thumb), { width: 3000, height: 2000, display: null, thumb });
  const display = { size: 5 * 1024 * 1024 };
  assert.deepEqual(derivativesOf(10, 20, display, { size: 1024 * 1024 + 1 }), { width: 10, height: 20, display, thumb: null });
  assert.deepEqual(derivativesOf(10, 20, null, null), { width: 10, height: 20, display: null, thumb: null });
});

test('pendingOf and doneOf split a queue by its done flag, and keep the order', () => {
  const queue = [{ done: true, name: 'a' }, { done: false, name: 'b' }, { done: true, name: 'c' }];
  assert.deepEqual(doneOf(queue).map((entry) => entry.name), ['a', 'c']);
  assert.deepEqual(pendingOf(queue).map((entry) => entry.name), ['b']);
});

test('pendingNotice names the photos that did not upload, and is null when none are left', () => {
  assert.equal(pendingNotice(0), null);
  assert.equal(pendingNotice(1), 'The entry is saved, but 1 photo(s) did not upload. Press Retry photos to try them again.');
  assert.equal(pendingNotice(2), 'The entry is saved, but 2 photo(s) did not upload. Press Retry photos to try them again.');
});

test('controlsFor locks the entry while saving or once it exists, and labels the button for the next press', () => {
  assert.deepEqual(controlsFor(false, null), { entryLocked: false, saveDisabled: false, saveLabel: 'Save entry' });
  assert.deepEqual(controlsFor(true, null), { entryLocked: true, saveDisabled: true, saveLabel: 'Saving…' });
  assert.deepEqual(controlsFor(false, 'mem1'), { entryLocked: true, saveDisabled: false, saveLabel: 'Retry photos' });
  assert.deepEqual(controlsFor(true, 'mem1'), { entryLocked: true, saveDisabled: true, saveLabel: 'Saving…' });
});

test('isMissingWords is true only for a first save with no text', () => {
  assert.equal(isMissingWords(null, ''), true);
  assert.equal(isMissingWords(null, 'x'), false);
  assert.equal(isMissingWords('mem1', ''), false);
});

test('displayNameOf falls back to Photo for an unnamed file', () => {
  assert.equal(displayNameOf(new File([], '')), 'Photo');
  assert.equal(displayNameOf(new File([], 'a.jpg')), 'a.jpg');
});

test('statusClassOf marks only errors', () => {
  assert.equal(statusClassOf(true), 'error');
  assert.equal(statusClassOf(false), '');
});

test('defaultDictationLanguage picks Chinese for a Chinese browser language, and English otherwise', () => {
  assert.equal(defaultDictationLanguage('zh-CN'), 'zh-CN');
  assert.equal(defaultDictationLanguage('zh'), 'zh-CN');
  assert.equal(defaultDictationLanguage('ZH-TW'), 'zh-CN');
  assert.equal(defaultDictationLanguage('en-US'), 'en-US');
  assert.equal(defaultDictationLanguage('fr-FR'), 'en-US');
  assert.equal(defaultDictationLanguage(''), 'en-US');
});

test('storedDictationLanguage keeps only the two offered languages, and dictationLanguageFor prefers a valid stored choice', () => {
  assert.equal(storedDictationLanguage('zh-CN'), 'zh-CN');
  assert.equal(storedDictationLanguage('en-US'), 'en-US');
  for (const stored of ['zh-TW', 'en', '', 'constructor', null]) assert.equal(storedDictationLanguage(stored), null);
  assert.equal(dictationLanguageFor('en-US', 'zh-CN'), 'en-US');
  assert.equal(dictationLanguageFor('zh-CN', 'en-US'), 'zh-CN');
  assert.equal(dictationLanguageFor('fr-FR', 'zh-CN'), 'zh-CN');
  assert.equal(dictationLanguageFor(null, 'en-US'), 'en-US');
});

test('insertTranscript puts the transcript at the caret, and leaves the caret after it', () => {
  assert.deepEqual(insertTranscript('我们去了公园', 2, 2, '中午', 'zh-CN'), { text: '我们中午去了公园', caret: 4 });
  assert.deepEqual(insertTranscript('后面的话', 0, 0, '前面', 'zh-CN'), { text: '前面后面的话', caret: 2 });
  assert.deepEqual(insertTranscript('前面的话', 4, 4, '后面', 'zh-CN'), { text: '前面的话后面', caret: 6 });
  assert.deepEqual(insertTranscript('', 0, 0, '你好', 'zh-CN'), { text: '你好', caret: 2 });
});

test('insertTranscript replaces the selected text', () => {
  assert.deepEqual(insertTranscript('我们去了公园', 2, 4, '中午', 'zh-CN'), { text: '我们中午公园', caret: 4 });
  assert.deepEqual(insertTranscript('go to the park', 6, 9, 'the beach', 'en-US'), { text: 'go to the beach park', caret: 15 });
});

test('insertTranscript adds one English space on each side that touches a non-space, and no spaces in Chinese', () => {
  assert.deepEqual(insertTranscript('hello', 5, 5, 'there', 'en-US'), { text: 'hello there', caret: 11 });
  assert.deepEqual(insertTranscript('hello world', 5, 5, 'big', 'en-US'), { text: 'hello big world', caret: 9 });
  assert.deepEqual(insertTranscript('hello world', 6, 6, 'big', 'en-US'), { text: 'hello big world', caret: 10 });
  assert.deepEqual(insertTranscript('abcdef', 2, 4, 'xy', 'en-US'), { text: 'ab xy ef', caret: 6 });
  assert.deepEqual(insertTranscript('world', 0, 0, 'hello', 'en-US'), { text: 'hello world', caret: 6 });
  assert.deepEqual(insertTranscript('hello world', 5, 5, 'big', 'zh-CN'), { text: 'hellobig world', caret: 8 });
});

test('insertTranscript trims the transcript, and an empty or blank transcript changes nothing', () => {
  assert.deepEqual(insertTranscript('', 0, 0, '  hi there  ', 'en-US'), { text: 'hi there', caret: 8 });
  assert.deepEqual(insertTranscript('abc', 1, 2, '', 'en-US'), { text: 'abc', caret: 2 });
  assert.deepEqual(insertTranscript('abc', 1, 2, '   ', 'zh-CN'), { text: 'abc', caret: 2 });
});

test('dictationErrorMessage names each recognition error, and shows nothing for an aborted recognition', () => {
  assert.equal(dictationErrorMessage('not-allowed'), 'Microphone access was denied.');
  assert.equal(dictationErrorMessage('service-not-allowed'), 'Microphone access was denied.');
  assert.equal(dictationErrorMessage('no-speech'), 'No speech was heard.');
  assert.equal(dictationErrorMessage('audio-capture'), 'No microphone was found.');
  assert.equal(dictationErrorMessage('network'), 'The speech service is unreachable.');
  assert.equal(dictationErrorMessage('aborted'), null);
  assert.equal(dictationErrorMessage('language-not-supported'), 'Dictation stopped: language-not-supported');
  assert.equal(dictationErrorMessage('constructor'), 'Dictation stopped: constructor');
});

test('splitResults takes the final transcripts from resultIndex on, and the interim text that is still changing', () => {
  const results = [
    { isFinal: true, 0: { transcript: '我们' } },
    { isFinal: true, 0: { transcript: '中午' } },
    { isFinal: false, 0: { transcript: '去' } },
  ];
  assert.deepEqual(splitResults(results, 0), { finals: ['我们', '中午'], interim: '去' });
  assert.deepEqual(splitResults(results, 1), { finals: ['中午'], interim: '去' });
  assert.deepEqual(splitResults(results, 2), { finals: [], interim: '去' });
  assert.deepEqual(splitResults([{ isFinal: false, 0: { transcript: '去' } }, { isFinal: false, 0: { transcript: '了' } }], 0), { finals: [], interim: '去了' });
  assert.deepEqual(splitResults([], 0), { finals: [], interim: '' });
});

test('joinTranscripts trims each final transcript, joins them with a space in English and with nothing in Chinese', () => {
  assert.equal(joinTranscripts([' hello ', 'there', ' '], 'en-US'), 'hello there');
  assert.equal(joinTranscripts(['你好', '今天'], 'zh-CN'), '你好今天');
  assert.equal(joinTranscripts([], 'en-US'), '');
});
