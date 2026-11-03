import { z } from 'zod';
import type { Memory, MemoryQuery, MemoryStore } from '../core/contracts.ts';
import { DEFAULT_PAGE_LIMIT, instantSchema, memoryIdSchema, memoryKindSchema, memoryTextSchema, parseStored, relatedIdList, versionSchema } from '../core/schema.ts';

/** SQLite-family implementation detail, NOT the interface new databases must implement. */
export interface SqlDriver {
  query(sql: string, args: (string | number | null)[]): Promise<Record<string, unknown>[]>;
  execute(sql: string, args: (string | number | null)[]): Promise<number>;
}
export const schema = `CREATE TABLE IF NOT EXISTS memories (
  owner TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
  search_text TEXT NOT NULL, occurred_at TEXT, version INTEGER NOT NULL,
  PRIMARY KEY (owner, id)
);
CREATE INDEX IF NOT EXISTS memories_time ON memories(owner, occurred_at);`;

// The payload is the JSON of a Memory, written in this key order. A row that does not match is corrupt storage.
const storedPayload = z.object({
  kind: memoryKindSchema, text: memoryTextSchema, occurredAt: instantSchema.nullable(), relatedIds: relatedIdList,
  id: memoryIdSchema, originalText: memoryTextSchema, createdAt: instantSchema, updatedAt: instantSchema, version: versionSchema,
});
const payloadRow = z.object({ payload: z.string() });
function decode(row: Record<string, unknown>): Memory {
  const { payload } = parseStored(payloadRow, row, 'memory row');
  let value: unknown;
  try { value = JSON.parse(payload); }
  catch { throw new Error('Corrupt memory payload in storage: not JSON'); }
  return parseStored(storedPayload, value, 'memory payload');
}

export function createSqlStore(driver: SqlDriver): MemoryStore {
  return {
    async get(owner, id) {
      const rows = await driver.query('SELECT payload FROM memories WHERE owner = ? AND id = ?', [owner, id]);
      return rows.length ? decode(rows[0]) : null;
    },
    async list(owner, query: MemoryQuery) {
      const where = ['owner = ?'];
      const args: (string | number | null)[] = [owner];
      if (query.text) {
        where.push('instr(search_text, ?) > 0'); args.push(query.text.toLowerCase());
      }
      if (query.relatedTo) {
        where.push("EXISTS (SELECT 1 FROM json_each(memories.payload, '$.relatedIds') WHERE value = ?)");
        args.push(query.relatedTo);
      }
      if (query.from) { where.push('occurred_at >= ?'); args.push(query.from); }
      if (query.before) { where.push('occurred_at < ?'); args.push(query.before); }
      if (query.afterId) { where.push('id > ?'); args.push(query.afterId); }
      args.push(query.limit ?? DEFAULT_PAGE_LIMIT);
      return (await driver.query(`SELECT payload FROM memories WHERE ${where.join(' AND ')} ORDER BY id LIMIT ?`, args)).map(decode);
    },
    async save(owner, memory, expectedVersion) {
      const payload = JSON.stringify(memory);
      if (expectedVersion === null) {
        return (await driver.execute('INSERT INTO memories (owner, id, payload, search_text, occurred_at, version) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(owner, id) DO NOTHING',
          [owner, memory.id, payload, memory.text.toLowerCase(), memory.occurredAt, memory.version])) === 1;
      }
      return (await driver.execute('UPDATE memories SET payload = ?, search_text = ?, occurred_at = ?, version = ? WHERE owner = ? AND id = ? AND version = ?',
        [payload, memory.text.toLowerCase(), memory.occurredAt, memory.version, owner, memory.id, expectedVersion])) === 1;
    },
    async delete(owner, id, expectedVersion) {
      return (await driver.execute('DELETE FROM memories WHERE owner = ? AND id = ? AND version = ?', [owner, id, expectedVersion])) === 1;
    },
  };
}
