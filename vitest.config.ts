import { createHash } from 'node:crypto';
import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';

const testPassphrase = 'test-only-owner-secret-never-used-in-production';
const salt = Buffer.from('test-salt-123456');
const digest = createHash('sha256').update(salt).update(testPassphrase, 'utf8').digest('base64url');
// The `.` form that setup writes now. The deployed `$` form is covered by tests/owner-password.test.ts.
const ownerPasswordHash = `sha256-v1.${salt.toString('base64url')}.${digest}`;

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      // The browser's capture.ts and photo-upload.ts are measured by the e2e run, which writes coverage/e2e/lcov.info.
      // crapper keeps one report per file, so vitest must not list them too. history.ts is only exercised by e2e and has
      // no coverage run.
      exclude: ['src/client/capture.ts', 'src/client/photo-upload.ts', 'src/client/history.ts'],
    },
    projects: [
      {
        test: {
          name: 'core',
          include: ['tests/memory.test.ts', 'tests/media.test.ts', 'tests/schema.test.ts', 'tests/mcp-tools.test.ts', 'tests/capture-client.test.ts', 'tests/capture-logic.test.ts', 'tests/history-logic.test.ts', 'tests/owner-password.test.ts'],
          exclude: ['e2e/**'],
        },
      },
      {
        plugins: [cloudflareTest({
          main: 'src/worker.ts',
          wrangler: { configPath: './wrangler.json' },
          miniflare: {
            r2Buckets: ['MEDIA'],
            bindings: {
              APP_ENV: 'test',
              MCP_RESOURCE_URL: 'http://localhost:8787/mcp',
              OAUTH_ISSUER: 'http://localhost:8787',
              OWNER_PASSWORD_HASH: ownerPasswordHash,
            },
          },
        })],
        test: {
          name: 'worker',
          include: ['tests/worker.integration.test.ts', 'tests/capture.integration.test.ts', 'tests/api.integration.test.ts'],
          exclude: ['e2e/**'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
