import { test } from 'vitest';
import assert from 'node:assert/strict';
import { TEXT } from '../src/client/capture-logic.ts';
import type { Clock, RelatedItem } from '../src/client/capture-logic.ts';
import {
  HISTORY_TEXT,
  attachBody,
  displayPath,
  editBody,
  editFailureMessage,
  editedOccurredAt,
  entriesPagePath,
  entryPath,
  entryPhotosPath,
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
  unlinkedPhotosPath,
  wallOfStored,
  whenLabel,
} from '../src/client/history-logic.ts';
import type { EntryItem, EntryPage, MediaPage, PhotoItem } from '../src/client/history-logic.ts';

/** A clock whose zone is the same at every instant. The browser's own clock is the one thing these tests replace. */
const fixedZone = (zoneMinutes: number): Clock => zoneClock(() => zoneMinutes);

/** A clock whose zone depends on the instant: +08:00 in winter, and +10:00 from March to October. */
function zoneClock(zoneAt: (instant: Date) => number): Clock {
  return {
    now: () => new Date(Date.UTC(2025, 0, 1)),
    offsetAt: (instant) => zoneAt(instant),
    localInstant: (year, monthIndex, day, hour, minute) => {
      const asUtc = Date.UTC(year, monthIndex, day, hour, minute);
      return new Date(asUtc - zoneAt(new Date(asUtc)) * 60_000);
    },
  };
}

const tokyo = fixedZone(540);
const kolkata = fixedZone(330);
const seasonal = zoneClock((instant) => (instant.getUTCMonth() >= 2 && instant.getUTCMonth() <= 9 ? 600 : 480));
const CONFLICT_TEXT = 'This entry was changed elsewhere. Reload to see the latest version.';

function entry(id: string, occurredAt: string | null, changes: Partial<EntryItem> = {}): EntryItem {
  return {
    id,
    kind: 'event',
    text: `Entry ${id}`,
    occurredAt,
    relatedIds: [],
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    version: 1,
    ...changes,
  };
}

const related = (id: string, kind: RelatedItem['kind'], text: string): RelatedItem => ({ id, kind, text });

const mediaItem = (id: string, takenAt: string | null, changes: Partial<PhotoItem> = {}): PhotoItem => ({
  id, memoryId: null, version: 1, caption: null, takenAt, ...changes,
});

test('entriesPagePath, entryPhotosPath and entryPath add percent-encoded cursors and IDs only where they belong', () => {
  assert.equal(entriesPagePath(null), '/api/entries');
  assert.equal(entriesPagePath('a b/&c'), '/api/entries?afterId=a%20b%2F%26c');
  assert.equal(entryPhotosPath('m 1', null), '/api/media?memoryId=m%201');
  assert.equal(entryPhotosPath('m1', 'p/2'), '/api/media?memoryId=m1&afterId=p%2F2');
  assert.equal(entryPath('e/1'), '/api/entries/e%2F1');
});

test('loadAllEntries requests each cursor in turn until a page has none', async () => {
  const pages: EntryPage[] = [
    { items: [entry('a', null)], nextAfterId: 'c 1' },
    { items: [entry('b', null)], nextAfterId: 'c/2' },
    { items: [entry('c', null)], nextAfterId: null },
  ];
  const requested: string[] = [];
  const items = await loadAllEntries(async (path) => {
    requested.push(path);
    return pages[requested.length - 1];
  });
  assert.deepEqual(requested, ['/api/entries', '/api/entries?afterId=c%201', '/api/entries?afterId=c%2F2']);
  assert.deepEqual(items.map((item) => item.id), ['a', 'b', 'c']);
});

test('loadAllEntries goes on past a page that holds no entries but still has a cursor', async () => {
  const pages: EntryPage[] = [
    { items: [], nextAfterId: 'c1' },
    { items: [entry('x', null)], nextAfterId: null },
  ];
  let calls = 0;
  const items = await loadAllEntries(async () => pages[calls++]);
  assert.equal(calls, 2);
  assert.deepEqual(items.map((item) => item.id), ['x']);
});

test('loadAllEntries stops at a cursor an earlier page already gave, including one that returns after other pages', async () => {
  const repeating: EntryPage[] = [
    { items: [entry('a', null)], nextAfterId: 'c1' },
    { items: [entry('b', null)], nextAfterId: 'c1' },
    { items: [entry('z', null)], nextAfterId: 'c2' },
  ];
  let calls = 0;
  const repeated = await loadAllEntries(async () => repeating[calls++]);
  assert.equal(calls, 2);
  assert.deepEqual(repeated.map((item) => item.id), ['a', 'b']);

  const cycle: EntryPage[] = [
    { items: [entry('a', null)], nextAfterId: 'c1' },
    { items: [entry('b', null)], nextAfterId: 'c2' },
    { items: [entry('c', null)], nextAfterId: 'c1' },
    { items: [entry('never', null)], nextAfterId: null },
  ];
  let cycleCalls = 0;
  const cycled = await loadAllEntries(async () => cycle[cycleCalls++]);
  assert.equal(cycleCalls, 3);
  assert.deepEqual(cycled.map((item) => item.id), ['a', 'b', 'c']);
});

test('loadAllEntries treats an empty cursor as the last page', async () => {
  let calls = 0;
  const items = await loadAllEntries(async () => {
    calls++;
    return { items: [entry('e', null)], nextAfterId: '' };
  });
  assert.equal(calls, 1);
  assert.deepEqual(items.map((item) => item.id), ['e']);
});

test('loadAllEntries asks for at most 1000 pages', async () => {
  let calls = 0;
  await loadAllEntries(async () => {
    calls++;
    return { items: [], nextAfterId: `c${calls}` };
  });
  assert.equal(calls, 1000);
});

test('loadAllEntries rejects when a page fails', async () => {
  let calls = 0;
  await assert.rejects(
    loadAllEntries(async () => {
      calls++;
      if (calls === 2) throw new Error('Request failed (HTTP 500).');
      return { items: [], nextAfterId: 'c1' };
    }),
    { message: 'Request failed (HTTP 500).' },
  );
});

test('loadAllPhotos follows the photo cursors of one entry only', async () => {
  const photo = (id: string): PhotoItem => mediaItem(id, null, { memoryId: 'entry-1' });
  const pages: MediaPage[] = [
    { items: [photo('p1')], nextAfterId: 'q1' },
    { items: [photo('p2')], nextAfterId: null },
  ];
  const requested: string[] = [];
  const photos = await loadAllPhotos('entry-1', async (path) => {
    requested.push(path);
    return pages[requested.length - 1];
  });
  assert.deepEqual(requested, ['/api/media?memoryId=entry-1', '/api/media?memoryId=entry-1&afterId=q1']);
  assert.deepEqual(photos.map((item) => item.id), ['p1', 'p2']);
});

test('unlinkedPhotosPath and displayPath add the cursor and encode the ID only where they belong', () => {
  assert.equal(unlinkedPhotosPath(null), '/api/media?unlinked=1');
  assert.equal(unlinkedPhotosPath('p 1/&'), '/api/media?unlinked=1&afterId=p%201%2F%26');
  assert.equal(displayPath('m/1'), '/api/media/m%2F1/display');
});

test('loadAllUnlinked requests each cursor in turn, through a page with no photos, until a page has no cursor', async () => {
  const pages: MediaPage[] = [
    { items: [mediaItem('u1', null)], nextAfterId: 'q 1' },
    { items: [], nextAfterId: 'q/2' },
    { items: [mediaItem('u2', '2025-05-01T05:30:00.000Z')], nextAfterId: null },
  ];
  const requested: string[] = [];
  const photos = await loadAllUnlinked(async (path) => {
    requested.push(path);
    return pages[requested.length - 1];
  });
  assert.deepEqual(requested, ['/api/media?unlinked=1', '/api/media?unlinked=1&afterId=q%201', '/api/media?unlinked=1&afterId=q%2F2']);
  assert.deepEqual(photos.map((item) => item.id), ['u1', 'u2']);
});

test('loadAllUnlinked stops at a cursor an earlier page gave, and asks for at most 1000 pages', async () => {
  let repeats = 0;
  const repeated = await loadAllUnlinked(async () => {
    repeats++;
    return { items: [mediaItem(`r${repeats}`, null)], nextAfterId: 'same' };
  });
  assert.equal(repeats, 2);
  assert.deepEqual(repeated.map((item) => item.id), ['r1', 'r2']);

  let calls = 0;
  await loadAllUnlinked(async () => {
    calls++;
    return { items: [], nextAfterId: `c${calls}` };
  });
  assert.equal(calls, 1000);
});

test('unlinkBody and attachBody send the photo version and caption with the new link, and photoDeleteBody sends the version', () => {
  const media = mediaItem('m1', null, { version: 4, caption: 'Harbour', memoryId: 'e0' });
  assert.equal(JSON.stringify(unlinkBody(media)), '{"expectedVersion":4,"memoryId":null,"caption":"Harbour"}');
  assert.equal(JSON.stringify(attachBody(media, 'e1')), '{"expectedVersion":4,"memoryId":"e1","caption":"Harbour"}');
  assert.equal(JSON.stringify(attachBody(mediaItem('m2', null), 'e1')), '{"expectedVersion":1,"memoryId":"e1","caption":null}');
  assert.equal(JSON.stringify(photoDeleteBody(media)), '{"expectedVersion":4}');
});

test('photoFailureMessage: a changed photo has its own text, 401 ends the session, success has no message, and other errors show the server text', () => {
  assert.equal(HISTORY_TEXT.photoConflict, 'This photo was changed elsewhere. Reload to see the latest version.');
  assert.equal(photoFailureMessage(409, { error: 'CONFLICT', message: 'Photo has changed; read the latest version' }), HISTORY_TEXT.photoConflict);
  assert.equal(photoFailureMessage(401, { error: 'unauthorized' }), TEXT.sessionEnded);
  assert.equal(photoFailureMessage(200, { media: {} }), null);
  assert.equal(photoFailureMessage(404, { error: 'NOT_FOUND', message: 'Photo not found' }), 'Photo not found');
  assert.equal(photoFailureMessage(500, null), 'Request failed (HTTP 500).');
});

test('the photo prompt, the empty-list text and the unknown-date label have the wording the page shows', () => {
  assert.equal(HISTORY_TEXT.deleteConfirm, 'Delete this photo permanently? This cannot be undone.');
  assert.equal(HISTORY_TEXT.noUnlinked, 'No unlinked photos.');
  assert.equal(HISTORY_TEXT.unknownDate, 'Date unknown');
});

test('takenDateLabel shows the day in the browser zone for a stored UTC time, and Date unknown for a photo with no time', () => {
  assert.equal(takenDateLabel('2025-05-01T05:30:00.000Z', tokyo), '2025-05-01');
  assert.equal(takenDateLabel('2025-05-01T23:30:00.000Z', tokyo), '2025-05-02');
  assert.equal(takenDateLabel('2025-05-01T23:30:00.000Z', fixedZone(-300)), '2025-05-01');
  assert.equal(takenDateLabel(null, tokyo), 'Date unknown');
});

test('sortEntries puts the newest time first, comparing instants rather than the text of each offset', () => {
  const sorted = sortEntries([
    entry('a', '2025-05-01T14:30:00+09:00'), // 05:30Z
    entry('b', '2025-05-01T06:00:00Z'), // 06:00Z, the latest of the three
    entry('c', '2025-05-01T05:00:00.000Z'),
  ]);
  assert.deepEqual(sorted.map((item) => item.id), ['b', 'a', 'c']);
});

test('sortEntries puts entries without a time last, newest saved first, and breaks ties by ID', () => {
  const sorted = sortEntries([
    entry('n-z', null, { createdAt: '2025-02-01T00:00:00.000Z' }),
    entry('n-b', null, { createdAt: '2025-03-01T00:00:00.000Z' }),
    entry('x-t', '2025-05-01T06:00:00Z'),
    entry('n-a', null, { createdAt: '2025-03-01T00:00:00.000Z' }),
    entry('a-t', '2025-05-01T06:00:00Z'),
  ]);
  assert.deepEqual(sorted.map((item) => item.id), ['a-t', 'x-t', 'n-a', 'n-b', 'n-z']);
});

test('sortEntries returns a new list and leaves the list it is given in place', () => {
  const given = [entry('a', null), entry('b', '2025-05-01T06:00:00Z')];
  const sorted = sortEntries(given);
  assert.notEqual(sorted, given);
  assert.deepEqual(given.map((item) => item.id), ['a', 'b']);
  assert.deepEqual(sorted.map((item) => item.id), ['b', 'a']);
});

test('wallOfStored shows a time with its own offset as written, whatever the browser zone, and nothing for no time', () => {
  assert.equal(wallOfStored('2025-05-01T14:30:00+09:00', tokyo), '2025-05-01T14:30');
  assert.equal(wallOfStored('2025-05-01T14:30:00+09:00', kolkata), '2025-05-01T14:30');
  assert.equal(wallOfStored('2025-05-01T14:30:15-05:00', fixedZone(0)), '2025-05-01T14:30');
  assert.equal(wallOfStored(null, tokyo), '');
});

test('wallOfStored shows a stored UTC time as the browser wall time at that instant', () => {
  assert.equal(wallOfStored('2025-05-01T05:30:00.000Z', tokyo), '2025-05-01T14:30');
  assert.equal(wallOfStored('2025-05-01T05:30:00.000Z', kolkata), '2025-05-01T11:00');
  assert.equal(wallOfStored('2025-05-01T23:45:00.000Z', tokyo), '2025-05-02T08:45');
  assert.equal(wallOfStored('2025-01-15T02:00:00.000Z', seasonal), '2025-01-15T10:00');
  assert.equal(wallOfStored('2025-07-15T02:00:00.000Z', seasonal), '2025-07-15T12:00');
});

test('whenLabel names the time and its offset, and says so when the time is unknown', () => {
  assert.equal(whenLabel('2025-05-01T14:30:00+09:00', kolkata), '2025-05-01 14:30 (+09:00)');
  assert.equal(whenLabel('2025-05-01T14:30:00-05:00', tokyo), '2025-05-01 14:30 (-05:00)');
  assert.equal(whenLabel('2025-05-01T05:30:00.000Z', tokyo), '2025-05-01 14:30 (+09:00)');
  assert.equal(whenLabel('2025-05-01T05:30:00.000Z', kolkata), '2025-05-01 11:00 (+05:30)');
  assert.equal(whenLabel('2025-01-15T02:00:00.000Z', seasonal), '2025-01-15 10:00 (+08:00)');
  assert.equal(whenLabel(null, tokyo), 'Time unknown');
});

test('editedOccurredAt turns an empty time into an unknown time, and refuses a time that is not a local time', () => {
  assert.equal(editedOccurredAt(null, '', tokyo), null);
  assert.equal(editedOccurredAt('2025-05-01T05:30:00.000Z', '', tokyo), null);
  assert.throws(() => editedOccurredAt(null, 'tomorrow', tokyo), { message: TEXT.badWhen });
  assert.throws(() => editedOccurredAt('2025-05-01T05:30:00.000Z', '2025-05-01 14:30', tokyo), { message: TEXT.badWhen });
  assert.throws(() => editedOccurredAt(null, '2025-05-01T14:30:15.5', tokyo), { message: TEXT.badWhen });
});

test('editedOccurredAt keeps the stored text exactly while the wall time is the one shown', () => {
  assert.equal(editedOccurredAt('2025-05-01T14:30:15+09:00', '2025-05-01T14:30', kolkata), '2025-05-01T14:30:15+09:00');
  assert.equal(editedOccurredAt('2025-05-01T05:30:00.000Z', '2025-05-01T14:30', tokyo), '2025-05-01T05:30:00.000Z');
  assert.equal(editedOccurredAt('2025-05-01T05:30:00.000Z', '2025-05-01T11:00', kolkata), '2025-05-01T05:30:00.000Z');
});

test('editedOccurredAt gives a changed time the offset the entry was written with', () => {
  assert.equal(editedOccurredAt('2025-05-01T14:30:15+09:00', '2025-05-01T15:45', kolkata), '2025-05-01T15:45:00+09:00');
  assert.equal(editedOccurredAt('2025-05-01T14:30:15-05:00', '2025-05-02T08:00', tokyo), '2025-05-02T08:00:00-05:00');
});

test('editedOccurredAt gives a changed time the browser offset for its own date, for a new entry or a UTC one', () => {
  assert.equal(editedOccurredAt(null, '2025-05-01T14:30', kolkata), '2025-05-01T14:30:00+05:30');
  assert.equal(editedOccurredAt('2025-05-01T05:30:00.000Z', '2025-05-01T15:45', kolkata), '2025-05-01T15:45:00+05:30');
  assert.equal(editedOccurredAt(null, '2025-01-15T10:00', seasonal), '2025-01-15T10:00:00+08:00');
  assert.equal(editedOccurredAt(null, '2025-07-15T10:00', seasonal), '2025-07-15T10:00:00+10:00');
  assert.equal(editedOccurredAt('2025-05-01T05:30:00.000Z', '2025-07-15T10:00', seasonal), '2025-07-15T10:00:00+10:00');
});

test('editBody sends the entry version with the trimmed text, the time and the links, and refuses blank text', () => {
  const body = editBody(entry('e1', null, { version: 3 }), '  Lunch with Ana  ', '2025-05-01T05:30:00.000Z', ['p1']);
  assert.deepEqual(body, { expectedVersion: 3, text: 'Lunch with Ana', occurredAt: '2025-05-01T05:30:00.000Z', relatedIds: ['p1'] });

  const undated = editBody(entry('e1', null), 'Undated', null, []);
  assert.equal(JSON.stringify(undated), '{"expectedVersion":1,"text":"Undated","occurredAt":null,"relatedIds":[]}');

  for (const blank of ['', '   ', '\n\t']) {
    assert.throws(() => editBody(entry('e1', null), blank, null, []), { message: TEXT.needWords });
  }
});

test('linksToSave sends the boxes that are ticked, and keeps the links the page does not show', () => {
  const linked = entry('e1', null, { relatedIds: ['p1', 'other-record', 'pl1'] });
  // p1 is shown and unticked, so it goes. other-record is not a box on this page, so it stays.
  assert.deepEqual(linksToSave(linked, ['p1', 'p2', 'pl1'], ['p2', 'pl1']), ['other-record', 'p2', 'pl1']);
  assert.deepEqual(linksToSave(entry('e2', null), ['p1'], []), []);
});

test('linkedNames gives the names in the order the entry lists them, and leaves out unknown IDs', () => {
  const people = [related('p1', 'person', 'Ana'), related('pl1', 'place', 'Cafe')];
  assert.deepEqual(linkedNames(entry('e1', null, { relatedIds: ['pl1', 'gone', 'p1'] }), people), ['Cafe', 'Ana']);
  assert.deepEqual(linkedNames(entry('e2', null), people), []);
});

test('editFailureMessage: a changed entry has its own text, 401 ends the session, success has no message, and other errors show the server text', () => {
  assert.equal(HISTORY_TEXT.conflict, CONFLICT_TEXT);
  assert.equal(editFailureMessage(409, { error: 'CONFLICT', message: 'Record has changed; read the latest version' }), CONFLICT_TEXT);
  assert.equal(editFailureMessage(401, { error: 'unauthorized' }), TEXT.sessionEnded);
  assert.equal(editFailureMessage(200, { memory: {} }), null);
  assert.equal(editFailureMessage(400, { error: 'INVALID_INPUT', message: 'Text must contain 1–20000 characters' }), 'Text must contain 1–20000 characters');
  assert.equal(editFailureMessage(500, null), 'Request failed (HTTP 500).');
});

test('replaceEntry swaps one entry for its saved version, keeps the others in place, and does not change the list it is given', () => {
  const items = [entry('a', null), entry('b', null), entry('c', null)];
  const saved = entry('b', '2025-05-01T05:30:00.000Z', { version: 2 });
  const replaced = replaceEntry(items, saved);
  assert.deepEqual(replaced.map((item) => item.version), [1, 2, 1]);
  assert.equal(replaced[1], saved);
  assert.equal(items[1].version, 1);
});
