import { createHash } from 'node:crypto';
import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';

const testPassphrase = 'test-only-owner-secret-never-used-in-production';
const salt = Buffer.from('test-salt-123456');
const digest = createHash('sha256').update(salt).update(testPassphrase, 'utf8').digest('base64url');
const ownerPasswordHash = `sha256-v1$${salt.toString('base64url')}$${digest}`;

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
    },
    projects: [
      {
        test: {
          name: 'core',
          include: ['tests/memory.test.ts', 'tests/media.test.ts', 'tests/capture-client.test.ts'],
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
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
