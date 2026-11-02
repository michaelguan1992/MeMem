import type { MediaStore } from '../core/contracts.ts';
import type { D1Binding } from './d1.ts';
import { createSqlMediaStore } from './media-sql.ts';

export function createD1MediaStore(db: D1Binding): MediaStore {
  return createSqlMediaStore({
    async query(sql, args) {
      const result = await db.prepare(sql).bind(...args).all();
      if (!result.success) throw new Error('D1 read failed');
      return result.results;
    },
    async execute(sql, args) {
      const result = await db.prepare(sql).bind(...args).run();
      if (!result.success) throw new Error('D1 write failed');
      return result.meta.changes;
    },
  });
}
