import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { BASE_URL, COVERAGE_OUT_DIR, ROOT, e2eBundlePath } from './support/paths.ts';

const execFileAsync = promisify(execFile);

export default async function globalSetup(): Promise<void> {
  // e2e/support/serve.mjs applies the D1 migrations before it starts wrangler dev.
  await execFileAsync(process.execPath, ['scripts/build-client.mjs', '--bundle-out', e2eBundlePath(), '--sourcemap'], { cwd: ROOT });
  await assertServedBundleMatches();
  await rm(join(COVERAGE_OUT_DIR, 'lcov.info'), { force: true });
}

/** The Worker serves the bundle without a source map, and it is the same code as the bundle the tests run. */
async function assertServedBundleMatches(): Promise<void> {
  const response = await fetch(`${BASE_URL}/capture.js`);
  if (!response.ok) throw new Error(`/capture.js answered HTTP ${response.status}`);
  const served = await response.text();
  if (served.includes('sourceMappingURL')) throw new Error('The served /capture.js must not carry a source map.');
  const e2eBundle = await readFile(e2eBundlePath(), 'utf8');
  const expected = e2eBundle.slice(0, e2eBundle.lastIndexOf('//# sourceMappingURL='));
  if (served !== expected) throw new Error('The served /capture.js differs from the e2e bundle. Rebuild with npm run build:client.');
}
