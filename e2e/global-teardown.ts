import { writeCaptureLcov } from './support/coverage.ts';
import { COVERAGE_OUT_DIR, rawCoverageDir } from './support/paths.ts';

export default async function globalTeardown(): Promise<void> {
  await writeCaptureLcov(rawCoverageDir(), COVERAGE_OUT_DIR);
}
