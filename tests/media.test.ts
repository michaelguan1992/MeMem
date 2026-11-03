import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createSqlStore, schema } from '../src/storage/sql-store.ts';
import type { SqlDriver } from '../src/storage/sql-store.ts';
import { createSqlMediaStore, mediaSchema } from '../src/storage/media-sql.ts';
import { createD1MediaStore } from '../src/storage/media-d1.ts';
import { createD1Store } from '../src/storage/d1.ts';
import type { D1Binding } from '../src/storage/d1.ts';
import { createMediaService } from '../src/core/media.ts';
import { createR2BlobStore, type R2Binding } from '../src/platform/r2.ts';
import type { MediaUpload, MediaVariant } from '../src/core/schema.ts';
import { instantOf, mediaIdOf, memoryIdOf, sha256Of, versionOf } from './brands.ts';
import { createMemoryService } from '../src/core/service.ts';
import type { Media, MediaQuery, MediaStore } from '../src/core/contracts.ts';

const MiB = 1024 * 1024;
const latin1 = (text: string) => Buffer.from(text, 'latin1');
const jpeg = latin1('\xff\xd8\xffjpeg pixels');
const png = latin1('\x89PNG\r\n\x1a\npng pixels');
const webp = latin1('RIFF\x00\x00\x00\x00WEBPwebp pixels');
const heic = latin1('\x00\x00\x00\x18ftypheicheic pixels');
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const takenAt = '2026-04-02T10:00:00+09:00';
const input = (original: Uint8Array<ArrayBuffer>, extra: Partial<MediaUpload> = {}): MediaUpload => ({ original, sha256: sha(original), ...extra });

function openDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  db.exec(mediaSchema);
  const driver: SqlDriver = {
    async query(sql, args) { return db.prepare(sql).all(...args); },
    async execute(sql, args) { return Number(db.prepare(sql).run(...args).changes); },
  };
  return { memories: createSqlStore(driver), media: createSqlMediaStore(driver), close: () => db.close() };
}

/** In-memory blob store; `fail` makes matching puts reject. */
function fakeBlobs(fail: (key: string) => boolean = () => false) {
  const objects = new Map<string, { body: Uint8Array; contentType: string }>();
  return {
    objects,
    async put(key: string, body: Uint8Array, contentType: string) {
      if (fail(key)) throw new Error('R2 put failed');
      objects.set(key, { body: new Uint8Array(body), contentType });
    },
    async get(key: string) {
      const object = objects.get(key);
      return object ? { body: new Uint8Array(object.body), contentType: object.contentType } : null;
    },
    async delete(keys: string[]) { for (const key of keys) objects.delete(key); },
  };
}

function setup(fail?: (key: string) => boolean) {
  return { ...openDatabase(), blobs: fakeBlobs(fail) };
}
type Setup = ReturnType<typeof setup>;

function service(t: Setup, owner = 'alice', media: MediaStore = t.media, newId?: () => string) {
  let count = 0;
  return createMediaService({ media, blobs: t.blobs, memories: t.memories, owner,
    newId: newId ?? (() => `p${String(++count).padStart(4, '0')}`), now: () => '2026-10-09T12:00:00Z' });
}
async function memory(t: Setup, owner = 'alice', id = 'trip') {
  await createMemoryService({ store: t.memories, owner, newId: () => id, now: () => '2026-10-09T12:00:00Z' })
    .record({ kind: 'event', text: 'Kyoto trip', occurredAt: takenAt });
}
/** Applies one concurrent edit in front of the first conditional save. */
function racingStore(t: Setup, edit: Partial<Media>): MediaStore {
  let raced = false;
  return {
    ...t.media,
    async save(owner, record, expectedVersion) {
      if (!raced && expectedVersion !== null) {
        raced = true;
        const current = await t.media.get(owner, record.id) as Media;
        await t.media.save(owner, { ...current, ...edit, version: versionOf(current.version + 1) }, current.version);
      }
      return t.media.save(owner, record, expectedVersion);
    },
  };
}
/** Lets a winning upload save its row first, so this upload's own save loses the hash race. */
function racingInsert(t: Setup, winner: Media): MediaStore {
  let raced = false;
  return {
    ...t.media,
    async save(owner, record, expectedVersion) {
      if (!raced && expectedVersion === null) {
        raced = true;
        await t.media.save(owner, winner, null);
      }
      return t.media.save(owner, record, expectedVersion);
    },
  };
}

test('JPEG upload stores normalized metadata and original, display, and thumbnail blobs', async () => {
  const t = setup();
  try {
    await memory(t);
    const result = await service(t).upload(input(jpeg, { display: jpeg, thumb: webp, takenAt, width: 4032, height: 3024, caption: 'Kyoto', memoryId: 'trip' }));
    assert.equal(result.duplicate, false);
    assert.deepEqual(result.media, {
      id: 'p0001', memoryId: 'trip', contentType: 'image/jpeg', bytes: jpeg.byteLength, sha256: sha(jpeg),
      takenAt: '2026-04-02T01:00:00.000Z', width: 4032, height: 3024, caption: 'Kyoto',
      createdAt: '2026-10-09T12:00:00.000Z', version: 1,
    });
    assert.deepEqual(await t.media.get('alice', mediaIdOf('p0001')), result.media);
    assert.deepEqual([...t.blobs.objects.keys()].sort(), [`alice/${sha(jpeg)}/display`, `alice/${sha(jpeg)}/original`, `alice/${sha(jpeg)}/thumb`]);
    assert.equal(t.blobs.objects.get(`alice/${sha(jpeg)}/thumb`)?.contentType, 'image/webp');
  } finally { t.close(); }
});

test('PNG, WebP and HEIC originals are identified from their bytes', async () => {
  const t = setup();
  try {
    const api = service(t);
    const types: string[] = [];
    for (const original of [png, webp, heic]) types.push((await api.upload(input(original))).media.contentType);
    assert.deepEqual(types, ['image/png', 'image/webp', 'image/heic']);
  } finally { t.close(); }
});

test('unrecognized originals are rejected before anything is written', async () => {
  const t = setup();
  try {
    const api = service(t);
    await assert.rejects(api.upload(input(latin1('GIF89a not a supported photo'))), { code: 'INVALID_INPUT' });
    await assert.rejects(api.upload(input(latin1('RIFF\x00\x00\x00\x00WAVEfmt '))), { code: 'INVALID_INPUT' });
    await assert.rejects(api.upload(input(new Uint8Array(0))), { code: 'INVALID_INPUT' });
    assert.equal(t.blobs.objects.size, 0);
    assert.deepEqual(await api.list(), []);
  } finally { t.close(); }
});

test('display and thumbnail images must be JPEG or WebP', async () => {
  const t = setup();
  try {
    const api = service(t);
    await assert.rejects(api.upload(input(jpeg, { display: png })), { code: 'INVALID_INPUT' });
    await assert.rejects(api.upload(input(jpeg, { thumb: heic })), { code: 'INVALID_INPUT' });
    assert.equal(t.blobs.objects.size, 0);
  } finally { t.close(); }
});

test('size limits apply to the original, display image and thumbnail', async () => {
  const t = setup();
  try {
    const api = service(t);
    const exact = Buffer.concat([jpeg, Buffer.alloc(25 * MiB - jpeg.byteLength)]);
    assert.equal((await api.upload(input(exact))).media.bytes, 25 * MiB);
    await assert.rejects(api.upload(input(Buffer.concat([exact, Buffer.alloc(1)]))), { code: 'INVALID_INPUT', message: /25 MiB/ });
    await assert.rejects(api.upload(input(jpeg, { display: Buffer.concat([jpeg, Buffer.alloc(5 * MiB)]) })), { code: 'INVALID_INPUT', message: /5 MiB/ });
    await assert.rejects(api.upload(input(jpeg, { thumb: Buffer.concat([webp, Buffer.alloc(MiB)]) })), { code: 'INVALID_INPUT', message: /1 MiB/ });
    assert.equal(t.blobs.objects.size, 1); // only the exact-size original was stored
  } finally { t.close(); }
});

test('the client SHA-256 must be lowercase hex and match the original bytes', async () => {
  const t = setup();
  try {
    const api = service(t);
    await assert.rejects(api.upload({ original: jpeg, sha256: sha(png) }), { code: 'INVALID_INPUT' });
    await assert.rejects(api.upload({ original: jpeg, sha256: sha(jpeg).toUpperCase() }), { code: 'INVALID_INPUT' });
    await assert.rejects(api.upload({ original: jpeg, sha256: 'not-a-hash' }), { code: 'INVALID_INPUT' });
    assert.equal(t.blobs.objects.size, 0);
  } finally { t.close(); }
});

test('an identical original returns the existing photo and rewrites only its own content-keyed blobs', async () => {
  const t = setup();
  try {
    await memory(t);
    const api = service(t);
    const first = await api.upload(input(jpeg, { display: jpeg, thumb: webp, memoryId: 'trip' }));
    const writes = t.blobs.objects.size;
    const again = await api.upload(input(jpeg, { caption: 'second copy' }));
    assert.deepEqual(again, { media: first.media, duplicate: true });
    assert.equal(t.blobs.objects.size, writes);
    assert.equal((await api.list()).length, 1);
  } finally { t.close(); }
});

test('linking to an unknown memory is rejected without writes', async () => {
  const t = setup();
  try {
    const api = service(t);
    await assert.rejects(api.upload(input(jpeg, { memoryId: 'missing' })), { code: 'NOT_FOUND' });
    await assert.rejects(api.upload(input(jpeg, { memoryId: 'bad id!' })), { code: 'INVALID_INPUT' });
    assert.equal(t.blobs.objects.size, 0);
    assert.deepEqual(await api.list(), []);
  } finally { t.close(); }
});

test('a failed blob write leaves only content-keyed blobs, and the next upload of the photo completes it', async () => {
  let failing = true;
  const t = setup((key) => failing && key.endsWith('/thumb'));
  try {
    await assert.rejects(service(t).upload(input(jpeg, { display: jpeg, thumb: webp })), /R2 put failed/);
    assert.equal(await t.media.get('alice', mediaIdOf('p0001')), null);
    // Nothing purges after a failed upload; the blobs it left are the photo's own keys, which the next upload overwrites.
    assert.deepEqual([...t.blobs.objects.keys()].sort(), [`alice/${sha(jpeg)}/display`, `alice/${sha(jpeg)}/original`]);
    failing = false;
    const { media: photo, duplicate } = await service(t).upload(input(jpeg, { display: jpeg, thumb: webp }));
    assert.equal(duplicate, false);
    assert.equal(photo.sha256, sha(jpeg));
    assert.deepEqual([...t.blobs.objects.keys()].sort(), [`alice/${sha(jpeg)}/display`, `alice/${sha(jpeg)}/original`, `alice/${sha(jpeg)}/thumb`]);
  } finally { t.close(); }
});

test('a duplicate upload rewrites a blob that is missing from storage', async () => {
  const t = setup();
  try {
    await memory(t);
    const api = service(t);
    const { media: photo } = await api.upload(input(jpeg, { display: jpeg, thumb: webp, memoryId: 'trip' }));
    t.blobs.objects.delete(`alice/${photo.sha256}/display`); // lost out of band
    const again = await api.upload(input(jpeg, { display: jpeg, thumb: webp }));
    assert.deepEqual(again, { media: photo, duplicate: true });
    assert.deepEqual([...t.blobs.objects.keys()].sort(), [`alice/${photo.sha256}/display`, `alice/${photo.sha256}/original`, `alice/${photo.sha256}/thumb`]);
  } finally { t.close(); }
});

test('a lost race reports the winner and deletes nothing', async () => {
  const t = setup();
  try {
    const winner: Media = { id: mediaIdOf('winner'), memoryId: null, contentType: 'image/jpeg', bytes: jpeg.byteLength, sha256: sha256Of(sha(jpeg)),
      takenAt: null, width: null, height: null, caption: null, createdAt: instantOf('2026-10-09T12:00:00.000Z'), version: versionOf(1) };
    // The winning upload saves its row after this upload has written its blobs.
    const result = await service(t, 'alice', racingInsert(t, winner)).upload(input(jpeg, { display: jpeg }));
    assert.deepEqual(result, { media: winner, duplicate: true });
    assert.deepEqual([...t.blobs.objects.keys()].sort(), [`alice/${sha(jpeg)}/display`, `alice/${sha(jpeg)}/original`]);
  } finally { t.close(); }
});

test('a reused photo ID cannot overwrite an existing photo', async () => {
  const t = setup();
  try {
    const api = service(t, 'alice', t.media, () => 'same');
    await api.upload(input(jpeg));
    await assert.rejects(api.upload(input(png)), { code: 'CONFLICT', message: 'Photo ID already exists' });
    assert.equal(t.blobs.objects.get(`alice/${sha(jpeg)}/original`)?.contentType, 'image/jpeg');
    assert.equal((await api.get('same'))?.sha256, sha(jpeg));
  } finally { t.close(); }
});

test("owners cannot read, change, or remove each other's photos", async () => {
  const t = setup();
  try {
    await memory(t);
    const alice = service(t), bob = service(t, 'bob');
    const { media: photo } = await alice.upload(input(jpeg, { memoryId: 'trip' }));
    assert.equal(await bob.get(photo.id), null);
    assert.deepEqual(await bob.list(), []);
    assert.equal(await bob.read(photo.id, 'original'), null);
    await assert.rejects(bob.update(photo.id, 1, { memoryId: null, caption: 'stolen' }), { code: 'NOT_FOUND' });
    await bob.remove(photo.id, 1); // bob has no such photo: nothing is removed and alice's photo stays intact
    assert.deepEqual(await alice.get(photo.id), photo);
    assert.ok(t.blobs.objects.has(`alice/${photo.sha256}/original`));
    // Deduplication is per owner: bob's copy gets its own record and blob prefix.
    const copy = await bob.upload(input(jpeg));
    assert.equal(copy.duplicate, false);
    assert.ok(t.blobs.objects.has(`bob/${copy.media.sha256}/original`));
    assert.equal((await alice.list()).length, 1);
  } finally { t.close(); }
});

test('update requires both edit fields and uses compare-and-set', async () => {
  const t = setup();
  try {
    await memory(t);
    const api = service(t);
    const { media: photo } = await api.upload(input(jpeg));
    const edited = await api.update(photo.id, 1, { memoryId: 'trip', caption: 'Kyoto' });
    assert.equal(edited.version, 2);
    assert.deepEqual(await api.get(photo.id), edited);
    await assert.rejects(api.update(photo.id, 1, { memoryId: null, caption: null }), { code: 'CONFLICT' });
    await assert.rejects(api.update(photo.id, 2, { memoryId: 'missing', caption: null }), { code: 'NOT_FOUND' });
    await assert.rejects(api.update('no-such-photo', 1, { memoryId: null, caption: null }), { code: 'NOT_FOUND' });
    // @ts-expect-error caption is required on every edit
    await assert.rejects(api.update(photo.id, 2, { memoryId: null }), { code: 'INVALID_INPUT' });
    assert.deepEqual(await api.get(photo.id), edited);
  } finally { t.close(); }
});

test('remove checks the version first, then deletes metadata and every blob variant', async () => {
  const t = setup();
  try {
    const api = service(t);
    const { media: photo } = await api.upload(input(jpeg, { display: jpeg }));
    await assert.rejects(api.remove(photo.id, 2), { code: 'CONFLICT' });
    assert.equal(t.blobs.objects.size, 2);
    await api.remove(photo.id, 1);
    assert.equal(await api.get(photo.id), null);
    assert.equal(t.blobs.objects.size, 0);
    await api.remove(photo.id, 1); // a repeat finds the photo already gone and succeeds
  } finally { t.close(); }
});

test('removing a photo twice succeeds and leaves no blobs', async () => {
  const t = setup();
  try {
    const api = service(t);
    const { media: photo } = await api.upload(input(jpeg, { display: jpeg, thumb: webp }));
    await api.remove(photo.id, 1);
    await api.remove(photo.id, 1);
    await api.remove(photo.id, 2); // a missing photo is already gone whatever version is sent
    assert.equal(await api.get(photo.id), null);
    assert.equal(t.blobs.objects.size, 0);
  } finally { t.close(); }
});

test('removing with a stale version gives CONFLICT and keeps every blob', async () => {
  const t = setup();
  try {
    const api = service(t);
    const { media: photo } = await api.upload(input(jpeg, { display: jpeg, thumb: webp }));
    await assert.rejects(api.remove(photo.id, 2), { code: 'CONFLICT' });
    assert.equal((await api.get(photo.id))?.version, 1);
    assert.equal(t.blobs.objects.size, 3);
  } finally { t.close(); }
});

test('a crash after the blobs are deleted is finished by a retry', async () => {
  const t = setup();
  try {
    const { media: photo } = await service(t).upload(input(jpeg, { display: jpeg }));
    let failOnce = true;
    // The first metadata delete fails after the blobs are gone, as if the process stopped at that point.
    const crashing: MediaStore = { ...t.media, async delete(owner, id, expectedVersion) {
      if (failOnce) { failOnce = false; throw new Error('D1 write failed'); }
      return t.media.delete(owner, id, expectedVersion);
    } };
    await assert.rejects(service(t, 'alice', crashing).remove(photo.id, 1), /D1 write failed/);
    assert.deepEqual(await t.media.get('alice', photo.id), photo);
    assert.equal(t.blobs.objects.size, 0);
    await service(t).remove(photo.id, 1);
    assert.equal(await t.media.get('alice', photo.id), null);
    assert.equal(t.blobs.objects.size, 0);
  } finally { t.close(); }
});

test('read returns stored variants and null for missing photos or variants', async () => {
  const t = setup();
  try {
    const api = service(t);
    const { media: photo } = await api.upload(input(jpeg, { display: webp }));
    const original = await api.read(photo.id, 'original');
    assert.equal(original?.contentType, 'image/jpeg');
    assert.deepEqual(Buffer.from(original?.body as Uint8Array), jpeg);
    assert.equal((await api.read(photo.id, 'display'))?.contentType, 'image/webp');
    assert.equal(await api.read(photo.id, 'thumb'), null);
    assert.equal(await api.read('no-such-photo', 'original'), null);
    await assert.rejects(api.read(photo.id, 'raw' as MediaVariant), { code: 'INVALID_INPUT' });
  } finally { t.close(); }
});

test('unlinkMemory clears links to one memory and leaves other photos alone', async () => {
  const t = setup();
  try {
    await memory(t);
    await memory(t, 'alice', 'other');
    const api = service(t);
    await api.upload(input(jpeg, { memoryId: 'trip' }));
    await api.upload(input(png, { memoryId: 'trip' }));
    await api.upload(input(webp, { memoryId: 'other' }));
    await api.upload(input(heic));
    assert.equal(await api.unlinkMemory('trip'), 2);
    assert.deepEqual(await api.list({ memoryId: 'trip' }), []);
    assert.deepEqual((await api.list({ memoryId: 'other' })).map(item => item.id), ['p0003']);
    assert.deepEqual((await api.list({ memoryId: null })).map(item => item.id), ['p0001', 'p0002', 'p0004']);
    assert.equal(await api.unlinkMemory('trip'), 0);
  } finally { t.close(); }
});

test('unlinkMemory retries once after a concurrent edit', async () => {
  const t = setup();
  try {
    await memory(t);
    const { media: photo } = await service(t).upload(input(jpeg, { memoryId: 'trip' }));
    const unlinked = await service(t, 'alice', racingStore(t, { caption: 'edited elsewhere' })).unlinkMemory('trip');
    assert.equal(unlinked, 1);
    const after = await t.media.get('alice', photo.id) as Media;
    assert.deepEqual([after.memoryId, after.caption, after.version], [null, 'edited elsewhere', 3]);
  } finally { t.close(); }
});

test('unlinkMemory leaves a photo alone when it moved to another memory mid-run', async () => {
  const t = setup();
  try {
    await memory(t);
    await memory(t, 'alice', 'other');
    const { media: photo } = await service(t).upload(input(jpeg, { memoryId: 'trip' }));
    const unlinked = await service(t, 'alice', racingStore(t, { memoryId: memoryIdOf('other') })).unlinkMemory('trip');
    assert.equal(unlinked, 0);
    assert.equal((await t.media.get('alice', photo.id))?.memoryId, 'other');
  } finally { t.close(); }
});

test('unlinkMemory leaves alone a photo that was removed during the run', async () => {
  const t = setup();
  try {
    await memory(t);
    const { media: photo } = await service(t).upload(input(jpeg, { memoryId: 'trip' }));
    const removedMidRun: MediaStore = {
      ...t.media,
      async save(owner, record, expectedVersion) {
        if (expectedVersion !== null) {
          await t.media.delete(owner, record.id, versionOf(expectedVersion)); // another request deletes the photo first
          return false;
        }
        return t.media.save(owner, record, expectedVersion);
      },
    };
    assert.equal(await service(t, 'alice', removedMidRun).unlinkMemory('trip'), 0);
    assert.equal(await t.media.get('alice', photo.id), null);
  } finally { t.close(); }
});

test('unlinkMemory stops after two lost compare-and-set attempts and leaves the photo linked', async () => {
  const t = setup();
  try {
    await memory(t);
    const { media: photo } = await service(t).upload(input(jpeg, { memoryId: 'trip' }));
    let conditionalSaves = 0;
    const twoConcurrentEdits: MediaStore = {
      ...t.media,
      async save(owner, record, expectedVersion) {
        // The first two conditional saves lose to concurrent edits. A third would succeed, and must not be tried.
        if (expectedVersion !== null && conditionalSaves++ < 2) return false;
        return t.media.save(owner, record, expectedVersion);
      },
    };
    assert.equal(await service(t, 'alice', twoConcurrentEdits).unlinkMemory('trip'), 0);
    assert.equal(conditionalSaves, 2);
    assert.equal((await t.media.get('alice', photo.id))?.memoryId, 'trip');
  } finally { t.close(); }
});

test('media store filters, pages, compares versions and enforces unique hashes per owner', async () => {
  const t = setup();
  try {
    const row = (id: string, memoryId: string | null, hash: string): Media => ({ id: mediaIdOf(id), memoryId: memoryId === null ? null : memoryIdOf(memoryId), contentType: 'image/jpeg', bytes: 1, sha256: sha256Of(hash),
      takenAt: null, width: null, height: null, caption: null, createdAt: instantOf('2026-10-09T12:00:00.000Z'), version: versionOf(1) });
    const a = row('a', 'trip', 'a'.repeat(64)), b = row('b', null, 'b'.repeat(64)), c = row('c', 'trip', 'c'.repeat(64));
    for (const item of [a, b, c]) assert.equal(await t.media.save('alice', item, null), true);
    assert.equal(await t.media.save('alice', row('d', null, 'b'.repeat(64)), null), false); // same hash
    assert.equal(await t.media.save('alice', row('a', null, 'e'.repeat(64)), null), false); // same ID
    const ids = async (query?: MediaQuery) => (await t.media.list('alice', query)).map(item => item.id);
    assert.deepEqual(await ids(), ['a', 'b', 'c']);
    assert.deepEqual(await ids({ memoryId: memoryIdOf('trip') }), ['a', 'c']);
    assert.deepEqual(await ids({ memoryId: null }), ['b']);
    assert.deepEqual(await ids({ sha256: sha256Of('c'.repeat(64)) }), ['c']);
    assert.deepEqual(await ids({ afterId: mediaIdOf('a'), limit: 1 }), ['b']);
    assert.equal(await t.media.save('alice', { ...a, caption: 'edited', version: versionOf(2) }, versionOf(1)), true);
    assert.equal(await t.media.save('alice', { ...a, caption: 'stale', version: versionOf(2) }, versionOf(1)), false);
    assert.equal(await t.media.delete('alice', mediaIdOf('a'), versionOf(1)), false);
    assert.equal(await t.media.delete('alice', mediaIdOf('a'), versionOf(2)), true);
    assert.equal(await t.media.save('bob', b, null), true); // uniqueness is per owner
    assert.deepEqual(await ids(), ['b', 'c']);
  } finally { t.close(); }
});

test('D1 media store works through a simulated binding and rejects provider failures', async () => {
  // Emulates only the D1 binding boundary. This is not a Cloudflare runtime test.
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  db.exec(mediaSchema);
  const binding: D1Binding = { prepare(sql) { return { bind(...args) { return {
    async all() { return { success: true, results: db.prepare(sql).all(...args) }; },
    async run() { return { success: true, meta: { changes: Number(db.prepare(sql).run(...args).changes) } }; },
  }; } }; } };
  try {
    const media = createD1MediaStore(binding);
    const api = createMediaService({ media, blobs: fakeBlobs(), memories: createD1Store(binding), owner: 'alice',
      newId: () => 'p0001', now: () => '2026-10-09T12:00:00Z' });
    await createMemoryService({ store: createD1Store(binding), owner: 'alice', newId: () => 'trip', now: () => '2026-10-09T12:00:00Z' })
      .record({ kind: 'event', text: 'Kyoto trip' });
    const { media: photo } = await api.upload(input(jpeg, { memoryId: 'trip' }));
    assert.deepEqual(await api.get(photo.id), photo);
    assert.equal((await api.upload(input(jpeg))).duplicate, true);
    assert.equal(await media.delete('alice', photo.id, versionOf(2)), false);
    await api.remove(photo.id, 1);
    assert.equal(await media.get('alice', photo.id), null);
  } finally { db.close(); }
  const failing: D1Binding = { prepare() { return { bind() { return {
    async all() { return { success: false, results: [] }; },
    async run() { return { success: false, meta: { changes: 0 } }; },
  }; } }; } };
  await assert.rejects(createD1MediaStore(failing).get('alice', mediaIdOf('p0001')), /D1 read failed/);
  await assert.rejects(createD1MediaStore(failing).delete('alice', mediaIdOf('p0001'), versionOf(1)), /D1 write failed/);
});

test('media schema matches the D1 migration', () => {
  const migration = readFileSync(new URL('../migrations/d1/0002_media.sql', import.meta.url), 'utf8');
  assert.ok(migration.includes(mediaSchema.trim()));
});

test('a corrupt media row is refused on read instead of being returned as a photo', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  db.exec(mediaSchema);
  // A digest that is not 64 lowercase hex characters can only come from damaged storage; the core never writes one.
  db.prepare("INSERT INTO media (owner, id, memory_id, content_type, bytes, sha256, taken_at, width, height, caption, created_at, version) VALUES ('alice', 'p0001', NULL, 'image/jpeg', 3, 'NOT-A-DIGEST', NULL, NULL, NULL, NULL, '2026-10-09T12:00:00.000Z', 1)").run();
  const binding: D1Binding = { prepare(sql) { return { bind(...args) { return {
    async all() { return { success: true, results: db.prepare(sql).all(...args) }; },
    async run() { return { success: true, meta: { changes: Number(db.prepare(sql).run(...args).changes) } }; },
  }; } }; } };
  try {
    const media = createD1MediaStore(binding);
    const corrupt = (error: unknown) => error instanceof Error && error.constructor === Error && /Corrupt media row in storage/.test(error.message);
    await assert.rejects(media.get('alice', mediaIdOf('p0001')), corrupt);
    await assert.rejects(media.list('alice'), corrupt);
  } finally { db.close(); }
});

test('an empty caption is kept as written, which is not the same as no caption', async () => {
  const t = setup();
  try {
    const api = service(t);
    const { media: empty } = await api.upload(input(jpeg, { caption: '' }));
    const { media: none } = await api.upload(input(png));
    assert.equal((await t.media.get('alice', empty.id))?.caption, '');
    assert.equal((await t.media.get('alice', none.id))?.caption, null);
  } finally { t.close(); }
});

test('the R2 blob store returns a stored content type, and octet-stream when R2 has none', async () => {
  const objects = new Map<string, { httpMetadata?: { contentType?: string } }>([
    ['typed', { httpMetadata: { contentType: 'image/webp' } }],
    ['bare', {}],
    ['untyped', { httpMetadata: {} }],
  ]);
  const bucket: R2Binding = {
    async put() { return undefined; },
    async get(key) {
      const object = objects.get(key);
      return object ? { body: new ReadableStream<Uint8Array>(), ...object } : null;
    },
    async delete() {},
  };
  const store = createR2BlobStore(bucket);
  assert.equal((await store.get('typed'))?.contentType, 'image/webp');
  assert.equal((await store.get('bare'))?.contentType, 'application/octet-stream');
  assert.equal((await store.get('untyped'))?.contentType, 'application/octet-stream');
  assert.equal(await store.get('missing'), null);
});
