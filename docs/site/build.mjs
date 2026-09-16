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
// The interface an application actually calls, named for what it is rather than for its file.
retitle('docs/site/api/reference/index/interfaces/SerialBrokerApi.md', 'Application API');
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
 * - **A union in a table cell.** Its alternatives run into one line, so a type reads as prose.
 *   Each alternative but the first starts a line of its own, with the pipe in front of it.
 * - **Where a member was inherited from.** That column holds a dotted reference, one word the
 *   browser cannot break, so it takes room from the description beside it. The table is marked,
 *   and the stylesheet lets that one column break; see `_static/serial-broker.css`.
 */
function tidyReference(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      tidyReference(path);
    } else if (entry.name.endsWith('.md')) {
      const text = readFileSync(path, 'utf8');
      const tidied = markInheritedTables(
        breakUnions(
          text
            .replace(/\.md#(?:property|enumeration-member)-[\w-]+\)/g, '.md)')
            .replaceAll('| \\| ', '| '),
        ),
      );
      if (tidied !== text) {
        writeFileSync(path, tidied);
      }
    }
  }
}

/** The cells of a Markdown table row, with escaped pipes left inside the cell they belong to. */
function tableCells(row) {
  const cells = [];
  let current = '';
  let escaped = false;
  for (const character of row) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === '\\') {
      current += character;
      escaped = true;
    } else if (character === '|') {
      cells.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  cells.push(current);
  return cells;
}

/**
 * Starts every alternative of a union on a line of its own, in the columns that hold a type.
 *
 * `number | undefined` reads as prose in a narrow column; one alternative per line, each led by
 * its pipe, reads as a type. Only those columns are touched, so a pipe in a description stays
 * where it is.
 */
function breakUnions(text) {
  // Declared here rather than beside the other constants: this file calls tidyReference() at
  // the top, before a const further down would have been initialised.
  const typeHeadings = new Set(['Type', 'Value', 'Default value']);
  const rows = text.split('\n');
  let typeColumns = [];
  return rows
    .map((row) => {
      if (!row.startsWith('|')) {
        typeColumns = [];
        return row;
      }
      const cells = tableCells(row);
      const headings = cells.map((cell) => cell.trim());
      if (headings.some((heading) => typeHeadings.has(heading))) {
        typeColumns = headings.flatMap((heading, index) =>
          typeHeadings.has(heading) ? [index] : [],
        );
        return row;
      }
      if (typeColumns.length === 0) {
        return row;
      }
      for (const index of typeColumns) {
        if (cells[index] !== undefined) {
          cells[index] = cells[index].replaceAll(' \\| ', '<br>\\| ');
        }
      }
      return cells.join('|');
    })
    .join('\n');
}

/**
 * Marks every table that says which interface a member came from, so that the stylesheet can
 * reach its last column.
 */
function markInheritedTables(text) {
  const rows = text.split('\n');
  const marked = [];
  for (let index = 0; index < rows.length; index += 1) {
    if (!rows[index].endsWith(' | Inherited from |')) {
      marked.push(rows[index]);
      continue;
    }
    const table = [];
    while (index < rows.length && rows[index].startsWith('|')) {
      table.push(rows[index]);
      index += 1;
    }
    index -= 1;
    marked.push(':::{rst-class} inherits-table', ...table, ':::');
  }
  return marked.join('\n');
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
