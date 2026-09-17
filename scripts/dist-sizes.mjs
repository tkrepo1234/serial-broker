/**
 * The size of every build an application may load, as built and gzipped.
 *
 * Used by `check-dist.mjs`, which prints the sizes after every build - so CI reports them on every
 * run - and by the benchmark, which puts them in the Performance chapter. There is no size budget
 * (BACKLOG.md, standing decisions): the sizes are reported, not enforced.
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

/**
 * The files an application serves or bundles, in the order they are reported.
 *
 * The worker script is one of them: it is served next to the application whatever the entry point
 * (ADR-0006), so its size is part of every installation.
 */
const DIST_FILES = [
  'dist/serial-broker.js',
  'dist/serial-broker.min.js',
  'dist/serial-broker.global.js',
  'dist/serial-broker.diagnostics.js',
  'dist/serial-broker.diagnostics.min.js',
  'dist/serial-broker.diagnostics.global.js',
  'dist/serial-broker.worker.js',
];

/**
 * Measures the builds under `root`.
 *
 * @param {string} root - The repository root.
 * @returns {{ file: string, bytes: number, gzip: number }[]} One entry per file that exists.
 */
export function distSizes(root) {
  const sizes = [];
  for (const file of DIST_FILES) {
    const path = join(root, file);
    let bytes;
    try {
      bytes = statSync(path).size;
    } catch {
      // A missing file is check-dist's finding, reported there; here it has no size.
      continue;
    }
    sizes.push({ file, bytes, gzip: gzipSync(readFileSync(path)).length });
  }
  return sizes;
}

/**
 * @param {number} bytes
 * @returns {string} The size in kilobytes, with one decimal.
 */
export function kilobytes(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}
