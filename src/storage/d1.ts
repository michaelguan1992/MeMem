import { createSqlStore } from './sql-store.ts';

/** Structural subset of a D1 binding. Provider types stay out of core. */
export interface D1Binding {
  prepare(sql: string): {
    bind(...args: (string | number | null)[]): {
      all(): Promise<{ success: boolean; results: Record<string, unknown>[] }>;
      run(): Promise<{ success: boolean; meta: { changes: number } }>;
    };
  };
}
export function createD1Store(db: D1Binding) {
  return createSqlStore({
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
