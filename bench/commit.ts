/**
 * Which commit a benchmark run belongs to, for the header of every result.
 *
 * Shared by the harness runner and the browser benchmark, so that both say the same thing in the
 * same words - including that the tree had uncommitted changes in what the numbers depend on,
 * which is the case a reader has to know about.
 */

import { execFileSync } from 'node:child_process';

/** The paths whose uncommitted changes make a run's numbers belong to no commit. */
const MEASURED_PATHS = [
  'src',
  'test/harness',
  'test/browser/stand-in',
  'bench/harness',
  'bench/browser',
  'bench/expectations.ts',
  'bench/report.ts',
];

/** The short hash of `HEAD`, marked when the measured code had uncommitted changes. */
export function describeCommit(root: string): string {
  try {
    const hash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root })
      .toString()
      .trim();
    const dirty =
      execFileSync('git', ['status', '--porcelain', '--', ...MEASURED_PATHS], { cwd: root })
        .toString()
        .trim().length > 0;
    return dirty ? `${hash} (with uncommitted changes)` : hash;
  } catch {
    // Outside a checkout the numbers still stand; they belong to no commit.
    return 'unknown';
  }
}
