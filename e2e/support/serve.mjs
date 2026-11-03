// The e2e web server: `wrangler dev` on 127.0.0.1:8788, with the test env file and this run's state directory.
// Playwright stops this process group with SIGTERM when the run ends. The wrapper then stops wrangler, and removes the
// state directory only after wrangler has exited, so nothing is written to it while it is deleted.
import { execFileSync, spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const stateDirectory = process.argv[2];
if (!stateDirectory) throw new Error('Usage: node e2e/support/serve.mjs <state-directory>');

const wranglerBin = fileURLToPath(new URL('../../node_modules/wrangler/bin/wrangler.js', import.meta.url));
// Migrations finish before wrangler dev starts, so no request can reach a D1 database without its tables.
execFileSync(process.execPath, [wranglerBin, 'd1', 'migrations', 'apply', 'memem', '--local', '--persist-to', stateDirectory], {
  cwd: root, stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
});

const wrangler = spawn(process.execPath, [
  wranglerBin,
  'dev', '--port', '8788', '--ip', '127.0.0.1', '--env-file', 'e2e/e2e.env', '--persist-to', stateDirectory,
], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
});

let stopping = false;
function stop(signal) {
  if (stopping) return;
  stopping = true;
  if (wrangler.exitCode === null && wrangler.signalCode === null) wrangler.kill(signal);
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));

wrangler.on('exit', async (code, signal) => {
  await rm(stateDirectory, { recursive: true, force: true });
  process.exit(code ?? (signal === null ? 0 : 1));
});
