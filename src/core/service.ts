import type { CoreDependencies, Memory, MemoryInput, MemoryKind, MemoryQuery } from './contracts.ts';
import { MemoryError } from './errors.ts';
import { identifier, instant, invalid, version } from './validate.ts';

const kinds = new Set(['event', 'person', 'place', 'fact']);
function input(value: MemoryInput): Required<MemoryInput> {
  if (!value || !kinds.has(value.kind)) invalid('Unknown memory kind');
  if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 20000) invalid('Text must contain 1–20000 characters');
  const links = value.relatedIds ?? [];
  if (!Array.isArray(links) || links.length > 100) invalid('At most 100 related IDs are allowed');
  return {
    kind: value.kind as MemoryKind, text: value.text,
    occurredAt: value.occurredAt == null ? null : instant(value.occurredAt),
    relatedIds: [...new Set(links.map(identifier))],
  };
}

/** A stored record is a replay of a request only while it is still the first version with the same content. */
function isReplayOf(stored: Memory, value: Required<MemoryInput>): boolean {
  return stored.version === 1 && stored.kind === value.kind && stored.text === value.text && stored.occurredAt === value.occurredAt
    && stored.relatedIds.length === value.relatedIds.length && stored.relatedIds.every((id, index) => id === value.relatedIds[index]);
}

/** Current content only: originalText is kept as history and never returned to clients. */
export type CurrentMemory = Omit<Memory, 'originalText'>;
export function currentMemory(memory: Memory): CurrentMemory {
  const { originalText: _historicalText, ...current } = memory;
  return current;
}

export function createMemoryService(deps: CoreDependencies) {
  if (!deps.owner.trim()) throw new Error('Trusted owner is required');
  const { store, owner } = deps;
  return {
    async record(value: MemoryInput, requestedId?: string): Promise<Memory> {
      const clean = input(value);
      const now = instant(deps.now());
      const id = identifier(requestedId === undefined ? deps.newId() : requestedId);
      const memory: Memory = { ...clean, id, originalText: clean.text, createdAt: now, updatedAt: now, version: 1 };
      if (await store.save(owner, memory, null)) return memory;
      // A client-chosen ID that already holds the same content is an earlier attempt at this request (for example, a retry after a lost response).
      const stored = requestedId === undefined ? null : await store.get(owner, id);
      if (stored && isReplayOf(stored, clean)) return stored;
      throw new MemoryError('CONFLICT', 'Record ID already exists');
    },
    async get(id: string): Promise<Memory | null> { return store.get(owner, identifier(id)); },
    async search(query: MemoryQuery = {}): Promise<Memory[]> {
      const limit = query.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) invalid('Limit must be 1–200');
      if (query.text !== undefined && (typeof query.text !== 'string' || query.text.length > 500)) invalid('Search text is too long');
      const clean: MemoryQuery = { text: query.text, limit };
      if (query.relatedTo !== undefined) clean.relatedTo = identifier(query.relatedTo);
      if (query.afterId !== undefined) clean.afterId = identifier(query.afterId);
      if (query.from !== undefined) clean.from = instant(query.from);
      if (query.before !== undefined) clean.before = instant(query.before);
      if (clean.from && clean.before && clean.from >= clean.before) invalid('Invalid time range');
      return store.list(owner, clean);
    },
    async correct(id: string, expectedVersion: number, value: MemoryInput): Promise<Memory> {
      identifier(id); version(expectedVersion);
      if (expectedVersion === Number.MAX_SAFE_INTEGER) invalid('Record version limit reached');
      const clean = input(value);
      const previous = await store.get(owner, id);
      if (!previous) throw new MemoryError('NOT_FOUND', 'Record not found');
      const memory: Memory = { ...previous, ...clean, updatedAt: instant(deps.now()), version: expectedVersion + 1 };
      if (!await store.save(owner, memory, expectedVersion)) throw new MemoryError('CONFLICT', 'Record has changed; read the latest version');
      return memory;
    },
    async forget(id: string, expectedVersion: number): Promise<void> {
      identifier(id); version(expectedVersion);
      let deleted: boolean;
      try { deleted = await store.delete(owner, id, expectedVersion); }
      catch (error) {
        // A delete can commit and still fail to report it (a lost response). Only a record that is still present keeps the failure.
        if (await store.get(owner, id)) throw error;
        return;
      }
      if (deleted) return;
      // Missing means already gone, so a repeat succeeds. Still present means the version is stale.
      if (await store.get(owner, id)) throw new MemoryError('CONFLICT', 'Record missing or changed');
    },
  };
}
