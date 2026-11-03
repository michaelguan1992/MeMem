import type { CoreDependencies, Memory, MemoryStore } from './contracts.ts';
import { MemoryError, invalid } from './errors.ts';
import { FIRST_VERSION, instantSchema, memoryIdSchema, memoryInput, memoryQuery, parse, versionSchema, type MemoryContent, type MemoryId, type MemoryInput, type MemoryQueryInput } from './schema.ts';

/** A stored record is a replay of a request only while it is still the first version with the same content. */
function isReplayOf(stored: Memory, value: MemoryContent): boolean {
  return stored.version === FIRST_VERSION && stored.kind === value.kind && stored.text === value.text && stored.occurredAt === value.occurredAt
    && stored.relatedIds.length === value.relatedIds.length && stored.relatedIds.every((id, index) => id === value.relatedIds[index]);
}

/** Current content only: originalText is kept as history and never returned to clients. */
export type CurrentMemory = Omit<Memory, 'originalText'>;
export function currentMemory(memory: Memory): CurrentMemory {
  const { originalText: _historicalText, ...current } = memory;
  return current;
}

/** What every memory operation reads. The factory builds it once; `newId` and `now` are read at each call. */
interface MemoryContext {
  store: MemoryStore;
  owner: string;
  newId: () => string;
  now: () => string;
}

async function recordMemory(ctx: MemoryContext, value: MemoryInput, requestedId?: string): Promise<Memory> {
  const clean = parse(memoryInput, value);
  const now = parse(instantSchema, ctx.now());
  const id = parse(memoryIdSchema, requestedId === undefined ? ctx.newId() : requestedId);
  const memory: Memory = { ...clean, id, originalText: clean.text, createdAt: now, updatedAt: now, version: FIRST_VERSION };
  if (await ctx.store.save(ctx.owner, memory, null)) return memory;
  return replayOrConflict(ctx, clean, id, requestedId);
}

// A client-chosen ID that already holds the same content is an earlier attempt at this request (for example, a retry after a lost response).
async function replayOrConflict(ctx: MemoryContext, value: MemoryContent, id: MemoryId, requestedId: string | undefined): Promise<Memory> {
  const stored = requestedId === undefined ? null : await ctx.store.get(ctx.owner, id);
  if (stored && isReplayOf(stored, value)) return stored;
  throw new MemoryError('CONFLICT', 'Record ID already exists');
}

async function getMemory(ctx: MemoryContext, id: string): Promise<Memory | null> {
  return ctx.store.get(ctx.owner, parse(memoryIdSchema, id));
}

async function searchMemories(ctx: MemoryContext, query: MemoryQueryInput): Promise<Memory[]> {
  const clean = parse(memoryQuery, query);
  if (clean.from && clean.before && clean.from >= clean.before) invalid('Invalid time range');
  return ctx.store.list(ctx.owner, clean);
}

async function correctMemory(ctx: MemoryContext, id: string, expectedVersion: number, value: MemoryInput): Promise<Memory> {
  const memoryKey = parse(memoryIdSchema, id);
  const expected = parse(versionSchema, expectedVersion);
  if (expected === Number.MAX_SAFE_INTEGER) invalid('Record version limit reached');
  const clean = parse(memoryInput, value);
  const previous = await ctx.store.get(ctx.owner, memoryKey);
  if (!previous) throw new MemoryError('NOT_FOUND', 'Record not found');
  const memory: Memory = { ...previous, ...clean, updatedAt: parse(instantSchema, ctx.now()), version: parse(versionSchema, expected + 1) };
  if (!await ctx.store.save(ctx.owner, memory, expected)) throw new MemoryError('CONFLICT', 'Record has changed; read the latest version');
  return memory;
}

async function forgetMemory(ctx: MemoryContext, id: string, expectedVersion: number): Promise<void> {
  const memoryKey = parse(memoryIdSchema, id);
  const expected = parse(versionSchema, expectedVersion);
  let deleted: boolean;
  try { deleted = await ctx.store.delete(ctx.owner, memoryKey, expected); }
  catch (error) {
    // A delete can commit and still fail to report it (a lost response). Only a record that is still present keeps the failure.
    if (await ctx.store.get(ctx.owner, memoryKey)) throw error;
    return;
  }
  if (deleted) return;
  // Missing means already gone, so a repeat succeeds. Still present means the version is stale.
  if (await ctx.store.get(ctx.owner, memoryKey)) throw new MemoryError('CONFLICT', 'Record missing or changed');
}

export function createMemoryService(deps: CoreDependencies) {
  if (!deps.owner.trim()) throw new Error('Trusted owner is required');
  const ctx: MemoryContext = { store: deps.store, owner: deps.owner, newId: () => deps.newId(), now: () => deps.now() };
  return {
    async record(value: MemoryInput, requestedId?: string): Promise<Memory> { return recordMemory(ctx, value, requestedId); },
    async get(id: string): Promise<Memory | null> { return getMemory(ctx, id); },
    async search(query: MemoryQueryInput = {}): Promise<Memory[]> { return searchMemories(ctx, query); },
    async correct(id: string, expectedVersion: number, value: MemoryInput): Promise<Memory> { return correctMemory(ctx, id, expectedVersion, value); },
    async forget(id: string, expectedVersion: number): Promise<void> { return forgetMemory(ctx, id, expectedVersion); },
  };
}
