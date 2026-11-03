import { test } from 'vitest';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteStore } from '../src/storage/sqlite.ts';
import { createD1Store } from '../src/storage/d1.ts';
import { schema } from '../src/storage/sql-store.ts';
import { createMemoryService } from '../src/core/service.ts';
import type { MemoryStore } from '../src/core/contracts.ts';
import type { D1Binding } from '../src/storage/d1.ts';
import { memoryIdOf } from './brands.ts';

// Emulates only the D1 binding boundary. This is not a Cloudflare runtime test.
function simulatedD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  return {
    store: createD1Store({ prepare(sql) { return { bind(...args) { return {
      async all() { return { success: true, results: db.prepare(sql).all(...args) }; },
      async run() { return { success: true, meta: { changes: Number(db.prepare(sql).run(...args).changes) } }; },
    }; } }; } }),
    close: () => db.close(),
  };
}
function service(store: MemoryStore, owner = 'alice') {
  let count = 0;
  return createMemoryService({ store, owner, newId: () => `m${String(++count).padStart(4, '0')}`,
    now: () => '2026-10-09T12:00:00Z' });
}

for (const [name, factory] of [
  ['SQLite', () => openSqliteStore(':memory:')],
  ['D1 binding simulation', simulatedD1],
] as const) {
  test(`${name}: owner isolation, detached results, conflicts and deletion`, async () => {
    const db = factory();
    try {
      const alice = service(db.store), bob = service(db.store, 'bob');
      const a = await alice.record({ kind: 'person', text: 'Matthew' });
      const b = await bob.record({ kind: 'person', text: 'Bob' });
      assert.equal(a.id, b.id); // Identical IDs must remain independently scoped.
      a.text = 'outside mutation';
      assert.equal((await alice.get(a.id))?.text, 'Matthew');
      assert.deepEqual((await bob.search()).map(m => m.text), ['Bob']);
      const changes = await Promise.allSettled([
        alice.correct(a.id, 1, { kind: 'person', text: 'Matthew updated A' }),
        alice.correct(a.id, 1, { kind: 'person', text: 'Matthew updated B' }),
      ]);
      assert.equal(changes.filter(r => r.status === 'fulfilled').length, 1);
      const rejected = changes.find(r => r.status === 'rejected');
      assert.equal(rejected?.status === 'rejected' && rejected.reason.code, 'CONFLICT');
      assert.equal((await alice.get(a.id))?.originalText, 'Matthew');
      await assert.rejects(alice.forget(a.id, 1), { code: 'CONFLICT' });
      await alice.forget(a.id, 2);
      assert.equal(await alice.get(a.id), null);
      assert.equal((await bob.get(b.id))?.text, 'Bob');
    } finally { db.close(); }
  });
  test(`${name}: names, literal search, dates, links and pagination`, async () => {
    const db = factory();
    try {
      const api = service(db.store);
      const person = await api.record({ kind: 'person', text: 'Matthew' });
      const fact = await api.record({ kind: 'fact', text: 'Matthew 的妻子是 Linda。', relatedIds: [person.id, person.id] });
      const meal = await api.record({ kind: 'event', text: '在中餐馆吃饭，优惠 10%。', occurredAt: '2026-10-08T20:00:00-07:00' });
      assert.equal(meal.occurredAt, '2026-10-09T03:00:00.000Z');
      assert.deepEqual(fact.relatedIds, [person.id]);
      assert.deepEqual((await api.search({ text: 'LINDA' })).map(m => m.id), [fact.id]);
      assert.deepEqual((await api.search({ text: '%' })).map(m => m.id), [meal.id]);
      assert.deepEqual((await api.search({ relatedTo: person.id })).map(m => m.id), [fact.id]);
      assert.deepEqual((await api.search({ from: '2026-10-09T03:00:00Z', before: '2026-10-09T04:00:00Z' })).map(m => m.id), [meal.id]);
      assert.equal((await api.search({ before: '2026-10-09T03:00:00Z' })).length, 0);
      const first = await api.search({ limit: 1 });
      assert.deepEqual((await api.search({ afterId: first[0].id, limit: 2 })).map(m => m.id), [fact.id, meal.id]);
      await api.correct(fact.id, 1, { kind: 'fact', text: '关系待核实', relatedIds: [person.id] });
      assert.equal((await api.search({ text: 'Linda' })).length, 0);
    } finally { db.close(); }
  });
  test(`${name}: invalid input does not mutate storage`, async () => {
    const db = factory();
    try {
      const api = service(db.store);
      await assert.rejects(api.record({ kind: 'fact', text: ' ' }), { code: 'INVALID_INPUT' });
      await assert.rejects(api.record({ kind: 'event', text: 'meal', occurredAt: '2026-10-09' }), { code: 'INVALID_INPUT' });
      await assert.rejects(api.search({ limit: 0 }), { code: 'INVALID_INPUT' });
      await assert.rejects(api.search({ from: '2026-10-10T00:00:00Z', before: '2026-10-09T00:00:00Z' }), { code: 'INVALID_INPUT' });
      assert.equal((await api.search()).length, 0);
    } finally { db.close(); }
  });
  test(`${name}: a client-chosen ID replays the stored record and never duplicates it`, async () => {
    const db = factory();
    try {
      const api = service(db.store);
      const value = { kind: 'event' as const, text: 'Lunch with Matthew', occurredAt: '2026-10-09T03:00:00Z', relatedIds: ['person-1', 'person-1'] };
      const first = await api.record(value, 'entry-1');
      const replay = await api.record({ ...value, relatedIds: ['person-1'] }, 'entry-1');
      assert.equal(first.id, 'entry-1');
      assert.deepEqual(replay, first);
      assert.deepEqual((await api.search()).map(m => m.id), ['entry-1']);
    } finally { db.close(); }
  });
  test(`${name}: a client-chosen ID with different content conflicts, and so does a replay after correction`, async () => {
    const db = factory();
    try {
      const api = service(db.store);
      await api.record({ kind: 'event', text: 'Lunch', relatedIds: ['a', 'b'] }, 'entry-2');
      await assert.rejects(api.record({ kind: 'event', text: 'Dinner', relatedIds: ['a', 'b'] }, 'entry-2'), { code: 'CONFLICT', message: 'Record ID already exists' });
      await assert.rejects(api.record({ kind: 'event', text: 'Lunch', relatedIds: ['b', 'a'] }, 'entry-2'), { code: 'CONFLICT' });
      assert.equal((await api.get('entry-2'))?.text, 'Lunch');
      await api.correct('entry-2', 1, { kind: 'event', text: 'Lunch, corrected', relatedIds: ['a', 'b'] });
      await assert.rejects(api.record({ kind: 'event', text: 'Lunch', relatedIds: ['a', 'b'] }, 'entry-2'), { code: 'CONFLICT' });
      assert.equal((await api.search()).length, 1);
    } finally { db.close(); }
  });
  test(`${name}: a replay does not call newId, and concurrent requests with one ID create one record`, async () => {
    const db = factory();
    try {
      const api = createMemoryService({ store: db.store, owner: 'alice', newId: () => { throw new Error('newId must not run'); },
        now: () => '2026-10-09T12:00:00Z' });
      const value = { kind: 'fact' as const, text: 'Written twice at once' };
      const [first, second] = await Promise.all([api.record(value, 'entry-3'), api.record(value, 'entry-3')]);
      assert.equal(first.id, 'entry-3');
      assert.deepEqual(second, first);
      assert.equal((await api.search()).length, 1);
    } finally { db.close(); }
  });
  test(`${name}: forgetting twice succeeds, while a stale version on a live record still conflicts`, async () => {
    const db = factory();
    try {
      const api = service(db.store);
      const fact = await api.record({ kind: 'fact', text: 'Forget me' });
      await assert.rejects(api.forget(fact.id, 2), { code: 'CONFLICT' });
      await api.forget(fact.id, 1);
      await api.forget(fact.id, 1);
      assert.equal(await api.get(fact.id), null);
    } finally { db.close(); }
  });
  test(`${name}: forgetting succeeds after a delete that committed before its response was lost`, async () => {
    const db = factory();
    try {
      const api = service(db.store);
      const committed = await api.record({ kind: 'fact', text: 'Delete committed' });
      const lostResponse = service({ ...db.store, async delete(owner, id, expectedVersion) {
        await db.store.delete(owner, id, expectedVersion);
        throw new Error('response lost');
      } });
      await lostResponse.forget(committed.id, 1);
      assert.equal(await api.get(committed.id), null);
      const kept = await api.record({ kind: 'fact', text: 'Delete never committed' });
      const unavailable = service({ ...db.store, async delete() { throw new Error('D1 unavailable'); } });
      await assert.rejects(unavailable.forget(kept.id, 1), /D1 unavailable/);
      assert.equal((await api.get(kept.id))?.text, 'Delete never committed');
    } finally { db.close(); }
  });
}

test('SQLite records persist across reopening', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'portable-memory-'));
  try {
    const filename = join(directory, 'test.sqlite');
    const first = openSqliteStore(filename);
    const saved = await service(first.store).record({ kind: 'fact', text: '持久化记录' });
    first.close();
    const second = openSqliteStore(filename);
    try { assert.equal((await service(second.store).get(saved.id))?.text, '持久化记录'); }
    finally { second.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('D1 outages reject instead of returning a missing record', async () => {
  const store = createD1Store({ prepare() { return { bind() { return {
    async all() { return { success: false, results: [] }; },
    async run() { return { success: false, meta: { changes: 0 } }; },
  }; } }; } });
  await assert.rejects(service(store).get('known-id'), /D1 read failed/);
  await assert.rejects(service(store).record({ kind: 'fact', text: 'hello' }), /D1 write failed/);
});

test('D1 initial migration matches local SQLite schema', () => {
  const migration = readFileSync(new URL('../migrations/d1/0001_memories.sql', import.meta.url), 'utf8');
  assert.equal(migration.trim(), schema.trim());
});

test('a corrupt memory payload is refused on read instead of being returned as a memory', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  // An unknown kind can only come from damaged storage; the core never writes one.
  const payload = { kind: 'diary', text: 'x', occurredAt: null, relatedIds: [], id: 'm0001', originalText: 'x', createdAt: '2026-10-09T12:00:00.000Z', updatedAt: '2026-10-09T12:00:00.000Z', version: 1 };
  db.prepare('INSERT INTO memories (owner, id, payload, search_text, occurred_at, version) VALUES (?, ?, ?, ?, ?, ?)').run('alice', 'm0001', JSON.stringify(payload), 'x', null, 1);
  const binding: D1Binding = { prepare(sql) { return { bind(...args) { return {
    async all() { return { success: true, results: db.prepare(sql).all(...args) }; },
    async run() { return { success: true, meta: { changes: Number(db.prepare(sql).run(...args).changes) } }; },
  }; } }; } };
  try {
    const store = createD1Store(binding);
    const corrupt = (error: unknown) => error instanceof Error && error.constructor === Error && /Corrupt memory payload in storage/.test(error.message);
    await assert.rejects(store.get('alice', memoryIdOf('m0001')), corrupt);
    await assert.rejects(store.list('alice', { limit: 10 }), corrupt);
  } finally { db.close(); }
});
