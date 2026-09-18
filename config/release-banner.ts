import { readFileSync } from 'node:fs';

/** The release, from `package.json`: the working directory is the repository root (ADR-0025). */
const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

/**
 * The first line of every published script, readable without loading it. `/*!` keeps the comment
 * through minification. scripts/check-dist.mjs checks every script in `dist/` begins with it.
 */
export const RELEASE_BANNER = `/*! serial-broker ${version} | MIT */`;
