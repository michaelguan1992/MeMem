import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { ROOT, runStateDir } from './paths.ts';

const execFileAsync = promisify(execFile);

/** One SQL string literal, with each single quote doubled. */
export function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Runs one wrangler D1 command against this run's state directory. `--local` keeps it off Cloudflare. */
async function wrangler(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('npx', ['wrangler', ...args, '--local', '--persist-to', runStateDir()], {
    cwd: ROOT,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

/** Rows from one SQL statement against the run's `memem` database. */
export async function query<Row = Record<string, unknown>>(sql: string): Promise<Row[]> {
  const stdout = await wrangler(['d1', 'execute', 'memem', '--json', '--command', sql]);
  const [statement] = JSON.parse(stdout) as Array<{ results: Row[]; success: boolean }>;
  if (!statement?.success) throw new Error(`D1 query failed: ${sql}`);
  return statement.results;
}

/**
 * Writes a person row for the People and places list, and returns its ID. The web API has no endpoint that creates a
 * person or a place, so the row goes in directly, in the shape the core SQL store writes (src/storage/sql-store.ts).
 * The owner is 'owner', the ID src/worker.ts uses for every session.
 */
export async function seedPersonRow(text: string): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const payload = JSON.stringify({ kind: 'person', text, occurredAt: null, relatedIds: [], id, originalText: text, createdAt: now, updatedAt: now, version: 1 });
  await query(`INSERT INTO memories (owner, id, payload, search_text, occurred_at, version) VALUES ('owner', ${sqlString(id)}, ${sqlString(payload)}, ${sqlString(text.toLowerCase())}, NULL, 1)`);
  return id;
}
