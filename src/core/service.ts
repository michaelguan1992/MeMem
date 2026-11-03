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
    async record(value: MemoryInput): Promise<Memory> {
      const clean = input(value);
      const now = instant(deps.now());
      const memory: Memory = { ...clean, id: identifier(deps.newId()), originalText: clean.text,
        createdAt: now, updatedAt: now, version: 1 };
      if (!await store.save(owner, memory, null)) throw new MemoryError('CONFLICT', 'Record ID already exists');
      return memory;
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
      if (!await store.delete(owner, id, expectedVersion)) throw new MemoryError('CONFLICT', 'Record missing or changed');
    },
  };
}
