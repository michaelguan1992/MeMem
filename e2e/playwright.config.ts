import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';
import { BASE_URL, REPO_ROOT } from './support/paths.ts';

// One state directory per run, set before the web server or any worker starts. The workers inherit it. The web server
// wrapper removes it when the server has stopped.
process.env.MEMEM_E2E_STATE ??= join(tmpdir(), `memem-e2e-${randomUUID()}`);
const stateDirectory = process.env.MEMEM_E2E_STATE;

export default defineConfig({
  // Each run uses one browser page at a time, against one shared local database.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: join(REPO_ROOT, 'e2e', 'test-results'),
  reporter: [['list'], ['html', { open: 'never', outputFolder: join(REPO_ROOT, 'e2e', 'playwright-report') }]],
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  use: {
    baseURL: BASE_URL,
    channel: 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chrome', use: { channel: 'chrome' } }],
  webServer: {
    // wrangler dev with the test env file and this run's state directory. See e2e/support/serve.mjs. It runs in the
    // repository, where the Worker's source is; the browser bundle is served by the tests, from RUN_ROOT (paths.ts).
    command: `node e2e/support/serve.mjs '${stateDirectory}'`,
    url: `${BASE_URL}/capture`,
    cwd: REPO_ROOT,
    reuseExistingServer: false,
    timeout: 180_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
