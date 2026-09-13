/**
 * Starts the emulator, after checking that this Node can run it.
 *
 *     node emulator/launch.mjs [options]
 *
 * The emulator runs straight from its TypeScript sources, on Node's built-in type stripping.
 * Node turns that on by default from 23.6.0, and from 22.18.0 on the 22 line. An older Node
 * fails on the first `.ts` import with ERR_UNKNOWN_FILE_EXTENSION, which says nothing about
 * what to do. This file is plain JavaScript so that any Node can parse it, and it imports the
 * entry point dynamically so that the check runs before Node sees any TypeScript.
 */

import process from 'node:process';

const REQUIREMENT = 'Node 22.18 or newer (23.6 or newer on the 23 line)';

// 'strip' or 'transform' when this Node runs TypeScript, false when it can but was told not
// to (--no-experimental-strip-types), and absent on a Node too old to know about it. Asking
// for the capability instead of comparing version numbers gives the right answer in all three.
const typeStripping = process.features.typescript;

if (typeof typeStripping === 'string') {
  await import('./src/main.ts');
} else {
  process.stderr.write(
    `The emulator needs ${REQUIREMENT}, which runs TypeScript without a flag.\n` +
      `This is Node ${process.version}, where it is unavailable or turned off.\n`,
  );
  process.exitCode = 1;
}
