import { test, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import schemaSql from '../migrations/d1/0001_memories.sql?raw';
import mediaSql from '../migrations/d1/0002_media.sql?raw';
import { createCloudflareMedia, createCloudflareMemory } from '../src/platform/cloudflare.ts';

const origin = 'http://localhost:8787';
const ownerPassphrase = 'test-only-owner-secret-never-used-in-production';
const cookieName = '__Host-memem_session';
const MiB = 1024 * 1024;

interface Auth { cookie: string; csrf: string }
interface MediaRecord {
  id: string; memoryId: string | null; contentType: string; bytes: number; sha256: string; takenAt: string | null;
  width: number | null; height: number | null; caption: string | null; createdAt: string; version: number;
}
interface MediaPage { items: MediaRecord[]; nextAfterId: string | null }
interface Related { items: { id: string; kind: string; text: string }[]; nextAfterId: string | null }

async function json<T = unknown>(response: Response): Promise<T> { return await response.json() as T; }
async function migrate(): Promise<void> {
  for (const statement of `${schemaSql}\n${mediaSql}`.split(';').map((part) => part.trim()).filter(Boolean)) {
    await env.DB.prepare(statement).run();
  }
}
async function reset(): Promise<void> {
  await migrate();
  for (const table of ['memories', 'media', 'web_sessions']) await env.DB.prepare(`DELETE FROM ${table}`).run();
  const listed = await env.MEDIA.list();
  if (listed.objects.length) await env.MEDIA.delete(listed.objects.map((object) => object.key));
}
async function count(table: string): Promise<number> {
  return (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? 0;
}
async function snapshot() {
  const objects = (await env.MEDIA.list()).objects.map((object) => object.key).sort();
  return { memories: await count('memories'), media: await count('media'), objects };
}
/** Blob keys are content-addressed: every photo with this SHA-256 shares one set of keys. */
async function objectKeys(digest: string): Promise<string[]> {
  return (await env.MEDIA.list({ prefix: `owner/${digest}/` })).objects.map((object) => object.key).sort();
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
async function hashValue(value: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}
async function signIn(): Promise<Auth> {
  const login = await SELF.fetch(new Request(`${origin}/capture/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin },
    body: new URLSearchParams({ password: ownerPassphrase }).toString(),
  }));
  expect(login.status).toBe(303);
  const token = login.headers.get('set-cookie')?.match(/^__Host-memem_session=([A-Za-z0-9_-]{43});/)?.[1] ?? '';
  expect(token).toHaveLength(43);
  const page = await (await SELF.fetch(`${origin}/capture`, { headers: { Cookie: `${cookieName}=${token}` } })).text();
  return { cookie: `${cookieName}=${token}`, csrf: page.match(/<meta name="csrf-token" content="([A-Za-z0-9_-]+)">/)?.[1] ?? '' };
}

function request(method: string, path: string, auth: Auth | null, body?: BodyInit, headers: Record<string, string> = {}): Request {
  const session: Record<string, string> = auth ? { Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf } : {};
  return new Request(`${origin}${path}`, { method, body, headers: { Origin: origin, ...session, ...headers } });
}
function jsonRequest(method: string, path: string, auth: Auth | null, value: unknown, headers: Record<string, string> = {}): Request {
  return request(method, path, auth, JSON.stringify(value), { 'Content-Type': 'application/json', ...headers });
}

function jpeg(tag: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode(`jpeg:${tag}`)]);
}
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}
function file(bytes: Uint8Array<ArrayBuffer>, name = 'photo.jpg', type = 'image/jpeg'): File {
  return new File([bytes], name, { type });
}
function upload(auth: Auth, fields: Record<string, string | File>, headers: Record<string, string> = {}): Promise<Response> {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  return SELF.fetch(request('POST', '/api/media', auth, form, headers));
}
async function createEntry(auth: Auth, text: string): Promise<string> {
  const response = await SELF.fetch(jsonRequest('POST', '/api/entries', auth, { text }));
  expect(response.status).toBe(201);
  return (await json<{ memory: { id: string } }>(response)).memory.id;
}
async function uploadPhoto(auth: Auth, fields: Record<string, string | File>): Promise<MediaRecord> {
  const response = await upload(auth, fields);
  expect(response.status).toBe(201);
  return (await json<{ media: MediaRecord }>(response)).media;
}

test('every /api request needs a session that belongs to the owner', async () => {
  await reset();
  const anonymous = [
    await SELF.fetch(request('GET', '/api/related', null)),
    await SELF.fetch(jsonRequest('POST', '/api/entries', null, { text: 'no session' })),
    await SELF.fetch(request('GET', '/api/media', null)),
  ];
  for (const response of anonymous) {
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await json(response)).toEqual({ error: 'unauthorized' });
  }

  // A valid session for another owner, and an expired session for this owner, are both refused.
  const stranger = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const expired = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const insert = 'INSERT INTO web_sessions (token_hash, owner, csrf_token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)';
  const now = Date.now();
  await env.DB.prepare(insert).bind(await hashValue(stranger), 'mallory', await hashValue('csrf'),
    new Date(now).toISOString(), new Date(now + 3_600_000).toISOString()).run();
  await env.DB.prepare(insert).bind(await hashValue(expired), 'owner', await hashValue('csrf'),
    new Date(now - 7_200_000).toISOString(), new Date(now - 3_600_000).toISOString()).run();
  for (const token of [stranger, expired]) {
    const response = await SELF.fetch(request('GET', '/api/related', { cookie: `${cookieName}=${token}`, csrf: '' }));
    expect(response.status).toBe(401);
  }
});

test('non-GET API requests need a same-origin request and the CSRF token', async () => {
  await reset();
  const auth = await signIn();
  const before = await snapshot();
  const attempts = [
    new Request(`${origin}/api/entries`, { method: 'POST', headers: { Origin: origin, Cookie: auth.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'no token' }) }),
    jsonRequest('POST', '/api/entries', { ...auth, csrf: 'not-the-token' }, { text: 'wrong token' }),
    jsonRequest('POST', '/api/entries', auth, { text: 'cross-site' }, { Origin: 'https://attacker.example' }),
    jsonRequest('POST', '/api/entries', auth, { text: 'other port' }, { Origin: 'http://localhost:9999' }),
    jsonRequest('POST', '/api/entries', auth, { text: 'null origin' }, { Origin: 'null' }),
    new Request(`${origin}/api/entries`, { method: 'POST', headers: { Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'no origin' }) }),
    jsonRequest('DELETE', '/api/media/missing', { ...auth, csrf: '' }, { expectedVersion: 1 }),
  ];
  for (const attempt of attempts) {
    const response = await SELF.fetch(attempt);
    expect(response.status).toBe(403);
    expect(await json(response)).toEqual({ error: 'forbidden', message: 'Request origin or CSRF token check failed' });
  }
  expect(await snapshot()).toEqual(before);
  expect((await SELF.fetch(jsonRequest('POST', '/api/entries', auth, { text: 'allowed' }))).status).toBe(201);
});

test('POST /api/entries stores an event in D1 and rejects bad bodies without writing', async () => {
  await reset();
  const auth = await signIn();
  const created = await SELF.fetch(jsonRequest('POST', '/api/entries', auth, { text: '和 Matthew 在京都吃午饭。', occurredAt: '2026-04-02T10:00:00+09:00' }));
  expect(created.status).toBe(201);
  const { memory } = await json<{ memory: Record<string, unknown> }>(created);
  expect(memory).toMatchObject({ kind: 'event', text: '和 Matthew 在京都吃午饭。', occurredAt: '2026-04-02T01:00:00.000Z', relatedIds: [], version: 1 });
  expect(memory).not.toHaveProperty('originalText');
  const stored = await env.DB.prepare('SELECT payload FROM memories WHERE owner = ? AND id = ?').bind('owner', String(memory.id)).all();
  expect(stored.results).toHaveLength(1);
  expect(JSON.parse(stored.results[0].payload as string)).toMatchObject({ kind: 'event', text: '和 Matthew 在京都吃午饭。' });

  const rejected: [Request, number][] = [
    [jsonRequest('POST', '/api/entries', auth, { text: 'x', kind: 'fact' }), 400],
    [jsonRequest('POST', '/api/entries', auth, ['not', 'an', 'object']), 400],
    [jsonRequest('POST', '/api/entries', auth, { text: '   ' }), 400],
    [request('POST', '/api/entries', auth, '{"text":', { 'Content-Type': 'application/json' }), 400],
    [request('POST', '/api/entries', auth, '{"text":"x"}', { 'Content-Type': 'text/plain' }), 415],
    [jsonRequest('POST', '/api/entries', auth, { text: 'x'.repeat(70 * 1024) }), 413],
  ];
  for (const [attempt, status] of rejected) expect((await SELF.fetch(attempt)).status).toBe(status);
  expect(await count('memories')).toBe(1);
});

test('POST /api/entries with a client-chosen id replays the same entry when the response was lost', async () => {
  await reset();
  const auth = await signIn();
  const body = { id: 'draft-entry-0001', text: '和 Matthew 在京都吃午饭。', occurredAt: '2026-04-02T10:00:00+09:00' };
  const first = await SELF.fetch(jsonRequest('POST', '/api/entries', auth, body));
  expect(first.status).toBe(201);
  const firstBody = await json(first);
  expect(firstBody).toMatchObject({ memory: { id: 'draft-entry-0001', version: 1 } });

  // The client repeats the request with the same ID; the server answers with the same 201 body and stores nothing new.
  const replay = await SELF.fetch(jsonRequest('POST', '/api/entries', auth, body));
  expect(replay.status).toBe(201);
  expect(await json(replay)).toEqual(firstBody);
  expect(await count('memories')).toBe(1);
  expect((await createCloudflareMemory(env, 'owner').search({ text: 'Matthew' })).map((memory) => memory.id)).toEqual(['draft-entry-0001']);

  // The same ID with different content is a conflict, not an overwrite.
  const changed = await SELF.fetch(jsonRequest('POST', '/api/entries', auth, { ...body, text: 'changed text' }));
  expect(changed.status).toBe(409);
  expect(await json(changed)).toEqual({ error: 'CONFLICT', message: 'Record ID already exists' });

  const malformed = await SELF.fetch(jsonRequest('POST', '/api/entries', auth, { text: 'x', id: 'bad id!' }));
  expect(malformed.status).toBe(400);
  expect(await json(malformed)).toEqual({ error: 'INVALID_INPUT', message: 'Invalid record identifier' });
});

test('GET /api/related lists people and places only, with 200-character text and ID paging', async () => {
  await reset();
  const auth = await signIn();
  // rel-0001..rel-0250: i % 4 === 2 is a person, i % 4 === 0 is a place, the rest are events.
  const statements: D1PreparedStatement[] = [];
  for (let i = 1; i <= 250; i++) {
    const id = `rel-${String(i).padStart(4, '0')}`;
    const kind = i % 4 === 0 ? 'place' : i % 4 === 2 ? 'person' : 'event';
    const text = i === 2 ? 'p'.repeat(300) : `${kind} ${i}`;
    const memory = { id, kind, text, originalText: text, occurredAt: null, relatedIds: [], createdAt: '2026-10-09T12:00:00.000Z', updatedAt: '2026-10-09T12:00:00.000Z', version: 1 };
    statements.push(env.DB.prepare('INSERT INTO memories (owner, id, payload, search_text, occurred_at, version) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('owner', id, JSON.stringify(memory), text.toLowerCase(), null, 1));
  }
  await env.DB.batch(statements);

  const first = await json<Related>(await SELF.fetch(request('GET', '/api/related', auth)));
  expect(first.items).toHaveLength(100);
  expect(first.nextAfterId).toBe('rel-0200');
  expect(first.items.every((item) => item.kind === 'person' || item.kind === 'place')).toBe(true);
  expect(Object.keys(first.items[0]).sort()).toEqual(['id', 'kind', 'text']);
  expect(first.items.find((item) => item.id === 'rel-0002')?.text).toHaveLength(200);

  const second = await json<Related>(await SELF.fetch(request('GET', '/api/related?afterId=rel-0200', auth)));
  expect(second.items).toHaveLength(25);
  expect(second.nextAfterId).toBeNull();
  expect((await SELF.fetch(request('GET', '/api/related?afterId=bad%20id', auth))).status).toBe(400);
});

test('a photo upload stores D1 metadata and three R2 objects, and every variant is served back unchanged', async () => {
  await reset();
  const auth = await signIn();
  const memoryId = await createEntry(auth, 'Kyoto day');
  const original = jpeg('original');
  const display = jpeg('display');
  const thumb = jpeg('thumb');
  const response = await upload(auth, {
    original: file(original, 'IMG_0001.jpg'), display: file(display, 'display.jpg'), thumb: file(thumb, 'thumb.jpg'),
    sha256: await sha256(original), memoryId, caption: 'Kyoto', takenAt: '2026-04-02T10:00:00+09:00', width: '4032', height: '3024',
  });
  expect(response.status).toBe(201);
  const created = await json<{ media: MediaRecord; duplicate: boolean }>(response);
  expect(created.duplicate).toBe(false);
  expect(created.media).toMatchObject({
    memoryId, contentType: 'image/jpeg', bytes: original.byteLength, sha256: await sha256(original),
    takenAt: '2026-04-02T01:00:00.000Z', width: 4032, height: 3024, caption: 'Kyoto', version: 1,
  });
  const { id } = created.media;
  const rows = await env.DB.prepare('SELECT memory_id, content_type, bytes FROM media WHERE owner = ? AND id = ?').bind('owner', id).all();
  expect(rows.results).toEqual([{ memory_id: memoryId, content_type: 'image/jpeg', bytes: original.byteLength }]);
  expect(await objectKeys(created.media.sha256)).toEqual([`owner/${created.media.sha256}/display`, `owner/${created.media.sha256}/original`, `owner/${created.media.sha256}/thumb`]);

  for (const [variant, expected] of [['original', original], ['display', display], ['thumb', thumb]] as const) {
    const served = await SELF.fetch(request('GET', `/api/media/${id}/${variant}`, auth));
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/jpeg');
    expect(served.headers.get('cache-control')).toBe('private, no-store');
    expect(served.headers.get('content-disposition')).toBe('inline');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(expected);
  }

  const listed = await json<MediaPage>(await SELF.fetch(request('GET', `/api/media?memoryId=${memoryId}`, auth)));
  expect(listed).toEqual({ items: [created.media], nextAfterId: null });

  // The same original again returns the existing photo. Its blobs are rewritten under the same keys, so no key or row is added.
  const before = await snapshot();
  const again = await upload(auth, { original: file(original, 'copy.jpg'), sha256: await sha256(original), caption: 'second copy' });
  expect(again.status).toBe(200);
  expect(await json(again)).toEqual({ media: created.media, duplicate: true });
  expect(await snapshot()).toEqual(before);
});

test('a missing sha256 is computed, and invalid uploads are rejected without writing anything', async () => {
  await reset();
  const auth = await signIn();
  const memoryId = await createEntry(auth, 'trip');
  const valid = jpeg('valid');
  const computed = await uploadPhoto(auth, { original: file(valid), memoryId });
  expect(computed.sha256).toBe(await sha256(valid));

  const before = await snapshot();
  const rejected: [string, Record<string, string | File>, number, string][] = [
    ['hash of other bytes', { original: file(valid), sha256: await sha256(jpeg('other')) }, 400, 'INVALID_INPUT'],
    ['malformed hash', { original: file(valid), sha256: 'ABC' }, 400, 'INVALID_INPUT'],
    ['PNG thumbnail', { original: file(jpeg('png-thumb')), thumb: file(png, 't.png', 'image/png') }, 400, 'INVALID_INPUT'],
    ['unrecognized original', { original: file(new Uint8Array([1, 2, 3, 4])) }, 400, 'INVALID_INPUT'],
    ['text instead of a file', { original: 'not a file' }, 400, 'INVALID_INPUT'],
    ['unknown memory', { original: file(jpeg('orphan')), memoryId: 'no-such-memory' }, 404, 'NOT_FOUND'],
    ['fractional width', { original: file(jpeg('width')), width: '12.5' }, 400, 'INVALID_INPUT'],
  ];
  for (const [label, fields, status, code] of rejected) {
    const response = await upload(auth, fields);
    expect({ label, status: response.status }).toEqual({ label, status });
    expect((await json<{ error: string }>(response)).error).toBe(code);
  }
  expect(await snapshot()).toEqual(before);
});

test('uploads are refused with 413 when Content-Length is over 32 MiB or missing', async () => {
  await reset();
  const auth = await signIn();
  const before = await snapshot();
  const multipartType = { 'Content-Type': 'multipart/form-data; boundary=memem' };
  const oversized = await SELF.fetch(request('POST', '/api/media', auth, new Uint8Array(32 * MiB + 1), multipartType));
  expect(oversized.status).toBe(413);
  expect(await json(oversized)).toMatchObject({ error: 'payload_too_large' });

  const unframed = new Request(`${origin}/api/media`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf, ...multipartType },
    body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('--memem--\r\n')); controller.close(); } }),
    duplex: 'half',
  } as RequestInit);
  const missing = await SELF.fetch(unframed);
  expect(missing.status).toBe(413);
  expect(await json(missing)).toMatchObject({ error: 'payload_too_large' });
  expect(await snapshot()).toEqual(before);
});

test('PATCH and DELETE use compare-and-set, and DELETE removes every stored variant', async () => {
  await reset();
  const auth = await signIn();
  const memoryId = await createEntry(auth, 'Kyoto');
  const photo = await uploadPhoto(auth, { original: file(jpeg('edit')), display: file(jpeg('edit-display')), memoryId });
  const { id } = photo;
  const path = `/api/media/${id}`;
  expect(await objectKeys(photo.sha256)).toEqual([`owner/${photo.sha256}/display`, `owner/${photo.sha256}/original`]);

  const edited = await SELF.fetch(jsonRequest('PATCH', path, auth, { expectedVersion: 1, memoryId, caption: 'Kyoto, day one' }));
  expect(edited.status).toBe(200);
  expect((await json<{ media: MediaRecord }>(edited)).media).toMatchObject({ memoryId, caption: 'Kyoto, day one', version: 2 });

  const stale = await SELF.fetch(jsonRequest('PATCH', path, auth, { expectedVersion: 1, memoryId: null, caption: null }));
  expect(stale.status).toBe(409);
  expect(await json(stale)).toEqual({ error: 'CONFLICT', message: 'Photo has changed; read the latest version' });
  expect((await SELF.fetch(jsonRequest('PATCH', path, auth, { expectedVersion: 2, memoryId: 'no-such-memory', caption: null }))).status).toBe(404);
  expect((await SELF.fetch(jsonRequest('PATCH', path, auth, { expectedVersion: 2, memoryId: null }))).status).toBe(400);
  expect((await SELF.fetch(jsonRequest('PATCH', path, auth, { expectedVersion: 2, memoryId: null, caption: null, owner: 'mallory' }))).status).toBe(400);

  expect((await SELF.fetch(jsonRequest('DELETE', path, auth, { expectedVersion: 1 }))).status).toBe(409);
  const deleted = await SELF.fetch(jsonRequest('DELETE', path, auth, { expectedVersion: 2 }));
  expect(deleted.status).toBe(200);
  expect(await json(deleted)).toEqual({ deleted: true, id });
  expect(await objectKeys(photo.sha256)).toEqual([]);
  // A repeated delete finds the photo already gone and succeeds.
  expect((await SELF.fetch(jsonRequest('DELETE', path, auth, { expectedVersion: 2 }))).status).toBe(200);
  expect((await SELF.fetch(request('GET', `${path}/original`, auth))).status).toBe(404);
  expect((await SELF.fetch(request('GET', `${path}/display`, auth))).status).toBe(404);
});

test('unknown IDs, another owner\'s photos and missing variants all get the same 404', async () => {
  await reset();
  const auth = await signIn();
  const own = await uploadPhoto(auth, { original: file(jpeg('own')) });
  const foreign = await createCloudflareMedia(env, 'mallory').upload({ original: jpeg('foreign'), sha256: await sha256(jpeg('foreign')) });
  const attempts = [
    `/api/media/no-such-photo/original`,
    `/api/media/${foreign.media.id}/original`,
    `/api/media/${own.id}/display`,
  ];
  const responses: { status: number; type: string | null; body: string }[] = [];
  for (const path of attempts) {
    const response = await SELF.fetch(request('GET', path, auth));
    responses.push({ status: response.status, type: response.headers.get('content-type'), body: await response.text() });
  }
  expect(responses[0].status).toBe(404);
  expect(responses[0].body).toBe('{"error":"NOT_FOUND","message":"Photo not found"}');
  expect(responses[1]).toEqual(responses[0]);
  expect(responses[2]).toEqual(responses[0]);
});

test('forgetting a memory unlinks its photos and keeps them readable', async () => {
  await reset();
  const auth = await signIn();
  const memoryId = await createEntry(auth, 'Kyoto');
  const bytes = jpeg('keep');
  const photoId = (await uploadPhoto(auth, { original: file(bytes), memoryId })).id;

  await createCloudflareMemory(env, 'owner').forget(memoryId, 1);
  expect(await count('memories')).toBe(0);

  const served = await SELF.fetch(request('GET', `/api/media/${photoId}/original`, auth));
  expect(served.status).toBe(200);
  expect(new Uint8Array(await served.arrayBuffer())).toEqual(bytes);
  const listed = await json<MediaPage>(await SELF.fetch(request('GET', '/api/media', auth)));
  expect(listed.items).toHaveLength(1);
  expect(listed.items[0]).toMatchObject({ id: photoId, memoryId: null });
  expect(await json(await SELF.fetch(request('GET', `/api/media?memoryId=${memoryId}`, auth)))).toEqual({ items: [], nextAfterId: null });
});

test('a failed photo unlink fails the forget, and a retry finishes it', async () => {
  await reset();
  const auth = await signIn();
  const memoryId = await createEntry(auth, 'Kyoto');
  const photoId = (await uploadPhoto(auth, { original: file(jpeg('retry-unlink')), memoryId })).id;
  let failed = false;
  // The memory row is deleted first; the first write that unlinks a photo then fails once.
  const flaky = { prepare(sql: string) {
    if (!failed && sql.startsWith('UPDATE media')) { failed = true; throw new Error('D1 unavailable'); }
    return env.DB.prepare(sql);
  } };
  await expect(createCloudflareMemory({ DB: flaky, MEDIA: env.MEDIA }, 'owner').forget(memoryId, 1)).rejects.toThrow('D1 unavailable');
  expect(await count('memories')).toBe(0);
  const stillLinked = await json<MediaPage>(await SELF.fetch(request('GET', `/api/media?memoryId=${memoryId}`, auth)));
  expect(stillLinked.items.map((item) => item.id)).toEqual([photoId]);

  // The retry finds the memory already gone, which is a success, and unlinks the photo.
  await createCloudflareMemory(env, 'owner').forget(memoryId, 1);
  expect(await json(await SELF.fetch(request('GET', `/api/media?memoryId=${memoryId}`, auth)))).toEqual({ items: [], nextAfterId: null });
  const listed = await json<MediaPage>(await SELF.fetch(request('GET', '/api/media', auth)));
  expect(listed.items).toMatchObject([{ id: photoId, memoryId: null }]);
});

test('unknown routes and wrong methods get JSON errors, with Allow where it applies', async () => {
  await reset();
  const auth = await signIn();
  const unknown = await SELF.fetch(request('GET', '/api/nope', auth));
  expect(unknown.status).toBe(404);
  expect(await json(unknown)).toEqual({ error: 'not_found', message: 'Not found' });
  expect((await SELF.fetch(request('GET', '/api/media/abc/raw', auth))).status).toBe(404);

  const wrongMethods: [string, string, string][] = [
    ['GET', '/api/entries', 'POST'],
    ['PUT', '/api/entries', 'POST'],
    ['POST', '/api/related', 'GET'],
    ['PATCH', '/api/media', 'GET, POST'],
    ['GET', '/api/media/abc', 'PATCH, DELETE'],
    ['POST', '/api/media/abc/original', 'GET'],
  ];
  for (const [method, path, allow] of wrongMethods) {
    const response = await SELF.fetch(request(method, path, auth));
    expect({ method, path, status: response.status }).toEqual({ method, path, status: 405 });
    expect(response.headers.get('allow')).toBe(allow);
  }
  expect((await SELF.fetch(request('GET', '/api/nope', null))).status).toBe(401);
});
