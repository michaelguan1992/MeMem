import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { convert } from 'ast-v8-to-istanbul';
import libCoverage from 'istanbul-lib-coverage';
import libReport from 'istanbul-lib-report';
import reports from 'istanbul-reports';
import { parseAstAsync } from 'vitest/node';
import { RUN_ROOT } from './paths.ts';

/** One page's V8 coverage for /capture.js. `source` is the bundle the browser ran, with its inline source map. */
export interface CaptureScriptCoverage {
  url: string;
  source: string;
  functions: Array<{
    functionName: string;
    isBlockCoverage: boolean;
    ranges: Array<{ startOffset: number; endOffset: number; count: number }>;
  }>;
}

const SOURCE_MAP_PREFIX = '//# sourceMappingURL=data:application/json;base64,';
// Only the DOM file. capture-logic.ts and exif.ts keep vitest's coverage: crapper keeps the later report for a file,
// and browser runs reach far fewer of their error paths than the unit tests do (errorMessageOf and formatOffset would
// score CRAP 20 from browser coverage alone).
const E2E_FILE = 'src/client/capture.ts';

/** Maps one page's V8 coverage of the bundle back to the TypeScript sources in the bundle's source map. */
async function convertCapture(capture: CaptureScriptCoverage) {
  const at = capture.source.lastIndexOf(SOURCE_MAP_PREFIX);
  if (at === -1) throw new Error('The /capture.js coverage has no inline source map; the e2e bundle must carry one.');
  const sourceMap = JSON.parse(Buffer.from(capture.source.slice(at + SOURCE_MAP_PREFIX.length).trim(), 'base64').toString('utf8'));
  return convert({
    code: capture.source,
    sourceMap,
    ast: await parseAstAsync(capture.source),
    // The map's source paths are relative to the tree the bundle was built from. The URL is placed there so that they resolve.
    coverage: { url: pathToFileURL(join(RUN_ROOT, 'capture.js')).href, functions: capture.functions },
    wrapperLength: 0,
  });
}

/** The e2e file only, with a repository-relative path, as the LCOV report and crapper expect it. */
function e2eFileByRepoPath(data: Awaited<ReturnType<typeof convertCapture>>): Record<string, object> {
  const kept: Record<string, object> = {};
  for (const [file, coverage] of Object.entries(data)) {
    const path = relative(RUN_ROOT, file);
    if (path !== E2E_FILE) continue;
    const withJson = coverage as { toJSON?: () => object };
    kept[path] = { ...(typeof withJson.toJSON === 'function' ? withJson.toJSON() : coverage), path };
  }
  return kept;
}

/**
 * Reads every saved page coverage in rawDir, merges the counts of all pages, and writes outDir/lcov.info with the
 * E2E_FILE record. The hit counts of every page are added together.
 */
export async function writeCaptureLcov(rawDir: string, outDir: string): Promise<void> {
  const merged = libCoverage.createCoverageMap({});
  const files = await readdir(rawDir).catch(() => []);
  for (const name of files) {
    const captures = JSON.parse(await readFile(join(rawDir, name), 'utf8')) as CaptureScriptCoverage[];
    for (const capture of captures) merged.merge(e2eFileByRepoPath(await convertCapture(capture)));
  }
  await mkdir(outDir, { recursive: true });
  reports.create('lcovonly').execute(libReport.createContext({ dir: outDir, coverageMap: merged }));
}
