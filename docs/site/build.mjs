/**
 * Builds the documentation site: the API reference from the source comments, then Sphinx.
 *
 * Run through `npm run docs`. Python is only needed here, so it lives in its own virtual
 * environment at docs/.venv rather than being a requirement of the repository (ADR-0020).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const python = [
  join(root, 'docs', '.venv', 'Scripts', 'python.exe'),
  join(root, 'docs', '.venv', 'bin', 'python'),
].find((candidate) => existsSync(candidate));

if (python === undefined) {
  process.stderr.write(
    [
      'The documentation needs a Python environment at docs/.venv. Create it once with:',
      '',
      '  python -m venv docs/.venv',
      '  docs/.venv/Scripts/python -m pip install -r docs/site/requirements.txt   (Windows)',
      '  docs/.venv/bin/python -m pip install -r docs/site/requirements.txt       (Linux, macOS)',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

run(process.execPath, [
  join(root, 'node_modules', 'typedoc', 'bin', 'typedoc'),
  '--options',
  'typedoc.site.json',
  // TypeDoc's validation - an undocumented export, a {@link} to nothing - only warns on its own,
  // and a warning would pass CI unnoticed while Sphinx below fails on every one of its own.
  '--treatWarningsAsErrors',
]);
// TypeDoc names each module page after its entry file. Readers know them by the import path.
retitle('docs/site/api/reference/index/index.md', 'serial-broker');
retitle('docs/site/api/reference/diagnostics/index.md', 'serial-broker/diagnostics');
tidyReference(join(root, 'docs', 'site', 'api', 'reference'));
run(python, [
  '-m',
  'sphinx',
  '-b',
  'html',
  '--fail-on-warning',
  '--keep-going',
  'docs/site',
  'docs/site/_build/html',
]);

process.stdout.write('\nBuilt docs/site/_build/html/index.html\n');

function retitle(path, title) {
  const file = join(root, path);
  writeFileSync(file, readFileSync(file, 'utf8').replace(/^# .*$/m, `# ${title}`));
}

/**
 * Repairs what TypeDoc's Markdown means for Sphinx, page by page.
 *
 * - **Row anchors.** TypeDoc marks each table row with an HTML anchor and links inherited members
 *   to it, but MyST only resolves anchors it generated itself, so every such link would be a
 *   broken reference. The link points at the page instead.
 * - **The pipe before a union.** A union TypeDoc considers long is written over several lines, so
 *   it starts with a `|`. In a table cell that line becomes one row, and the union reads as if a
 *   stray character stood in front of it.
 */
function tidyReference(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      tidyReference(path);
    } else if (entry.name.endsWith('.md')) {
      const text = readFileSync(path, 'utf8');
      const tidied = text
        .replace(/\.md#(?:property|enumeration-member)-[\w-]+\)/g, '.md)')
        .replaceAll('| \\| ', '| ');
      if (tidied !== text) {
        writeFileSync(path, tidied);
      }
    }
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
