import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test as base, expect, type Page } from '@playwright/test';
import type { CaptureScriptCoverage } from './coverage.ts';
import { e2eBundlePath, rawCoverageDir } from './paths.ts';

/**
 * Every test's page runs the e2e bundle in place of the Worker's /capture.js body. The Worker's response headers are kept,
 * and the body is the same code plus an inline source map, which the coverage step needs. global-setup checks that the
 * two bodies match. Chromium JS coverage for /capture.js is saved per test, and global-teardown turns it into LCOV.
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    const bundle = await readFile(e2eBundlePath(), 'utf8');
    await page.route('**/capture.js', async (route) => {
      const served = await route.fetch();
      await route.fulfill({ response: served, body: bundle });
    });
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await use(page);
    await saveCaptureCoverage(page);
  },
});
export { expect };

async function saveCaptureCoverage(page: Page): Promise<void> {
  let entries: Awaited<ReturnType<Page['coverage']['stopJSCoverage']>>;
  try {
    entries = await page.coverage.stopJSCoverage();
  } catch {
    return; // the page closed before the test ended, so there is nothing to collect
  }
  const captures: CaptureScriptCoverage[] = entries
    .filter((entry) => new URL(entry.url).pathname === '/capture.js' && entry.source !== undefined)
    .map((entry) => ({ url: entry.url, source: entry.source ?? '', functions: entry.functions }));
  if (captures.length === 0) return;
  await mkdir(rawCoverageDir(), { recursive: true });
  await writeFile(join(rawCoverageDir(), `${randomUUID()}.json`), JSON.stringify(captures));
}
