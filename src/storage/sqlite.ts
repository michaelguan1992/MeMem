import { DatabaseSync } from 'node:sqlite';
import { createSqlStore, schema } from './sql-store.ts';

export function openSqliteStore(filename: string) {
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(schema);
  const store = createSqlStore({
    async query(sql, args) { return db.prepare(sql).all(...args); },
    async execute(sql, args) { return Number(db.prepare(sql).run(...args).changes); },
  });
  return { store, close: () => db.close() };
}
