import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { BASE_URL, COVERAGE_OUT_DIR, REPO_ROOT, RUN_ROOT, e2eBundlePath, workerBundlePath } from './support/paths.ts';

const execFileAsync = promisify(execFile);

export default async function globalSetup(): Promise<void> {
  // The browser bundle comes from the tree this run starts in, and the Worker's bundle from the repository. The build
  // script takes its root from its working directory, so each bundle is built from the tree named as cwd.
  await buildClient(RUN_ROOT, ['--bundle-out', e2eBundlePath(), '--sourcemap']);
  await buildClient(REPO_ROOT, ['--bundle-out', workerBundlePath()]);
  // e2e/support/serve.mjs applies the D1 migrations before it starts wrangler dev.
  await assertServedBundleMatches();
  await rm(join(COVERAGE_OUT_DIR, 'lcov.info'), { force: true });
}

async function buildClient(cwd: string, args: string[]): Promise<void> {
  await execFileAsync(process.execPath, ['scripts/build-client.mjs', ...args], { cwd });
}

/**
 * The Worker serves the build of its own repository, without a source map. In a normal run that repository is the tree
 * under test, so the bundle the tests serve must be that same code. A mutator worker runs its own mutated copy on
 * purpose, so there only the served copy is compared with the repository's build.
 */
async function assertServedBundleMatches(): Promise<void> {
  const response = await fetch(`${BASE_URL}/capture.js`);
  if (!response.ok) throw new Error(`/capture.js answered HTTP ${response.status}`);
  const served = await response.text();
  if (served.includes('sourceMappingURL')) throw new Error('The served /capture.js must not carry a source map.');
  const repositoryBundle = await readFile(workerBundlePath(), 'utf8');
  if (served !== repositoryBundle) throw new Error('The served /capture.js differs from the build of this repository. Rebuild with npm run build:client.');
  if (RUN_ROOT !== REPO_ROOT) return;
  const e2eBundle = await readFile(e2eBundlePath(), 'utf8');
  const expected = e2eBundle.slice(0, e2eBundle.lastIndexOf('//# sourceMappingURL='));
  if (repositoryBundle !== expected) throw new Error('The e2e bundle differs from the served /capture.js. Rebuild with npm run build:client.');
}
