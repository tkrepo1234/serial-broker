/**
 * Decides whether a version tag gets a release, and prints its release notes.
 *
 * Every version tag gets a release. A stable version, `vX.Y.Z`, gets an ordinary one; a tag with a
 * pre-release part, such as `v1.2.0-alpha.1`, gets one marked as a pre-release. Before anything is
 * published the tag has to match the version in package.json, and CHANGELOG.md has to have a
 * section for that version - the notes are taken from it, so a release can never go out without
 * them.
 *
 * Usage: `node scripts/release-notes.mjs v0.1.0`, or `npm run release:check` for the version in
 * package.json. Prints the notes on stdout. In GitHub Actions it also writes `stable` and `version`
 * to `$GITHUB_OUTPUT`. Exits with 1, naming the problem, when the tag, the version or the
 * changelog is not right.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packageVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
// Without an argument, the tag the version in package.json would get: what `npm run release:check`
// checks, on every platform - a `$npm_package_version` in the script would not expand on Windows.
const tag = process.argv[2] ?? `v${packageVersion}`;

const parsed = /^v(\d+\.\d+\.\d+)(-[0-9A-Za-z.-]+)?$/.exec(tag);
if (parsed === null) {
  fail(`"${tag}" is not a version tag such as v1.2.3 or v1.2.3-rc.1.`);
}
const [, core, prerelease] = parsed;
const version = `${core}${prerelease ?? ''}`;

if (packageVersion !== version) {
  fail(`The tag ${tag} is version ${version}, but package.json says ${packageVersion}.`);
}

const notes = changelogSection(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), version);
if (notes === undefined) {
  fail(
    `CHANGELOG.md has no section "## [${version}]". Move the entries under [Unreleased] into one, dated, before tagging.`,
  );
}
if (notes.trim() === '') {
  fail(`The CHANGELOG.md section for ${version} is empty.`);
}

output({ stable: prerelease === undefined ? 'true' : 'false', version });
process.stdout.write(`${notes.trim()}\n`);

/** The body of `## [version]` (optionally followed by a date), up to the next `## ` heading. */
function changelogSection(changelog, wanted) {
  const lines = changelog.split(/\r?\n/);
  const heading = new RegExp(`^## \\[${wanted.replaceAll('.', '\\.')}\\](\\s|$)`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) {
    return undefined;
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

function output(values) {
  const file = process.env.GITHUB_OUTPUT;
  if (file !== undefined && file !== '') {
    appendFileSync(
      file,
      Object.entries(values)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(''),
    );
  }
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
