#!/usr/bin/env node
// Checks that every stored memory row still reads under the current schema, before a deploy that parses rows on read.
// It reads `wrangler d1 execute --json` output on stdin and decodes each row through the real store, so the check is the
// read path itself. It prints only counts and the IDs that fail with the schema's message, never memory text.
//
//   node scripts/wrangler-cloudflare.mjs d1 execute memem --remote --env production --json \
//     --command "SELECT owner, id, payload FROM memories" | node scripts/check-stored-memories.mjs
import { createSqlStore } from '../src/storage/sql-store.ts';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = Buffer.concat(chunks).toString('utf8');
const start = input.indexOf('[');
if (start === -1) {
  console.error('No JSON result on stdin.');
  process.exit(2);
}
const results = JSON.parse(input.slice(start));
const rows = results.flatMap((result) => result.results ?? []);

let failed = 0;
for (const row of rows) {
  const store = createSqlStore({
    query: async () => [{ payload: row.payload }],
    execute: async () => { throw new Error('This check is read-only.'); },
  });
  try {
    await store.get(row.owner, row.id);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${row.id}: ${error instanceof Error ? error.message : 'unreadable'}`);
  }
}
console.log(`Checked ${rows.length} memory rows: ${rows.length - failed} read, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
