import { join, resolve } from 'node:path';

/** The repository root. */
export const ROOT = resolve(import.meta.dirname, '..', '..');
/** The e2e server. It is not the development server on 8787. */
export const BASE_URL = 'http://127.0.0.1:8788';
export const EXIF_PHOTO = resolve(import.meta.dirname, '..', 'fixtures', 'exif-photo.jpg');
/** The LCOV file for the browser's /capture.js, which crapper reads next to vitest's report. */
export const COVERAGE_OUT_DIR = resolve(ROOT, 'coverage', 'e2e');

/**
 * This run's temporary state directory: the D1 database, the raw browser coverage and the e2e bundle. The Playwright
 * config sets MEMEM_E2E_STATE before any worker starts, and the workers inherit it.
 */
export function runStateDir(): string {
  const directory = process.env.MEMEM_E2E_STATE;
  if (!directory) throw new Error('MEMEM_E2E_STATE is not set. Run the suite through e2e/playwright.config.ts.');
  return directory;
}
export function rawCoverageDir(): string {
  return join(runStateDir(), 'coverage-raw');
}
/** The /capture.js bundle with an inline source map, which the tests serve in place of the Worker's copy. */
export function e2eBundlePath(): string {
  return join(runStateDir(), 'capture.e2e.js');
}
