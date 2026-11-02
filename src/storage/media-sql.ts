import type { Media, MediaStore } from '../core/contracts.ts';
import type { SqlDriver } from './sql-store.ts';

/** SQLite-family implementation detail; same SQL as the media table in migrations/d1/0002_media.sql. */
export const mediaSchema = `CREATE TABLE IF NOT EXISTS media (
  owner TEXT NOT NULL, id TEXT NOT NULL,
  memory_id TEXT,
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  taken_at TEXT,
  width INTEGER, height INTEGER,
  caption TEXT,
  created_at TEXT NOT NULL, version INTEGER NOT NULL,
  PRIMARY KEY (owner, id)
);
CREATE INDEX IF NOT EXISTS media_memory ON media(owner, memory_id);
CREATE UNIQUE INDEX IF NOT EXISTS media_hash ON media(owner, sha256);`;

const columns = 'id, memory_id, content_type, bytes, sha256, taken_at, width, height, caption, created_at, version';
function decode(row: Record<string, unknown>): Media {
  return {
    id: row.id as string, memoryId: row.memory_id as string | null, contentType: row.content_type as Media['contentType'],
    bytes: row.bytes as number, sha256: row.sha256 as string, takenAt: row.taken_at as string | null,
    width: row.width as number | null, height: row.height as number | null, caption: row.caption as string | null,
    createdAt: row.created_at as string, version: row.version as number,
  };
}

export function createSqlMediaStore(driver: SqlDriver): MediaStore {
  return {
    async get(owner, id) {
      const rows = await driver.query(`SELECT ${columns} FROM media WHERE owner = ? AND id = ?`, [owner, id]);
      return rows.length ? decode(rows[0]) : null;
    },
    async list(owner, query = {}) {
      const where = ['owner = ?'];
      const args: (string | number | null)[] = [owner];
      if (query.memoryId === null) where.push('memory_id IS NULL');
      else if (query.memoryId !== undefined) { where.push('memory_id = ?'); args.push(query.memoryId); }
      if (query.sha256 !== undefined) { where.push('sha256 = ?'); args.push(query.sha256); }
      if (query.afterId !== undefined) { where.push('id > ?'); args.push(query.afterId); }
      args.push(query.limit ?? 50);
      return (await driver.query(`SELECT ${columns} FROM media WHERE ${where.join(' AND ')} ORDER BY id LIMIT ?`, args)).map(decode);
    },
    async save(owner, media, expectedVersion) {
      const values = [media.memoryId, media.contentType, media.bytes, media.sha256, media.takenAt, media.width, media.height, media.caption, media.createdAt, media.version];
      // No conflict target: DO NOTHING covers both the duplicate-ID key and the unique (owner, sha256) index.
      if (expectedVersion === null) {
        return (await driver.execute('INSERT INTO media (owner, id, memory_id, content_type, bytes, sha256, taken_at, width, height, caption, created_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
          [owner, media.id, ...values])) === 1;
      }
      return (await driver.execute('UPDATE media SET memory_id = ?, content_type = ?, bytes = ?, sha256 = ?, taken_at = ?, width = ?, height = ?, caption = ?, created_at = ?, version = ? WHERE owner = ? AND id = ? AND version = ?',
        [...values, owner, media.id, expectedVersion])) === 1;
    },
    async delete(owner, id, expectedVersion) {
      return (await driver.execute('DELETE FROM media WHERE owner = ? AND id = ? AND version = ?', [owner, id, expectedVersion])) === 1;
    },
  };
}
