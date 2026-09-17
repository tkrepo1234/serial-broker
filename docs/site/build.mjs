/**
 * Builds the documentation site: the API reference from the source comments, then Sphinx.
 *
 * Run through `npm run docs`. Python is only needed here, so it lives in a virtual environment of
 * its own rather than being a requirement of the repository (ADR-0020): at `docs/.venv`, or - to
 * keep a hundred megabytes out of the working folder - at `~/.serial-broker/docs-venv`, or wherever
 * `SERIAL_BROKER_DOCS_VENV` says.
 *
 * With `--links` (`npm run docs:links`) it checks where the documentation's links lead instead of
 * building the site. That is a separate command rather than part of the build: it goes out to the
 * network, so it is as reliable as the sites it asks about, and CI would fail on their bad days
 * rather than on ours. The links into this repository are skipped while it is private - see
 * `linkcheck_ignore` in conf.py.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const environments = [
  process.env['SERIAL_BROKER_DOCS_VENV'],
  join(root, 'docs', '.venv'),
  join(homedir(), '.serial-broker', 'docs-venv'),
].filter((directory) => directory !== undefined && directory !== '');
const python = environments
  .flatMap((directory) => [
    join(directory, 'Scripts', 'python.exe'),
    join(directory, 'bin', 'python'),
  ])
  .find((candidate) => existsSync(candidate));

if (python === undefined) {
  process.stderr.write(
    [
      'The documentation needs a Python environment, at docs/.venv or at ~/.serial-broker/docs-venv.',
      'Create it once with:',
      '',
      '  python -m venv docs/.venv',
      '  docs/.venv/Scripts/python -m pip install -r docs/site/requirements.txt   (Windows)',
      '  docs/.venv/bin/python -m pip install -r docs/site/requirements.txt       (Linux, macOS)',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

// Checking links needs the pages as they are, not a fresh reference: the last build's output is
// what the reader has, and rebuilding it here would say nothing about the links.
if (process.argv.includes('--links')) {
  run(python, [
    '-m',
    'sphinx',
    '-b',
    'linkcheck',
    '--keep-going',
    'docs/site',
    'docs/site/_build/linkcheck',
  ]);
  process.stdout.write('\nEvery link checked; see docs/site/_build/linkcheck/output.txt\n');
  process.exit(0);
}

run(process.execPath, [
  join(root, 'node_modules', 'typedoc', 'bin', 'typedoc'),
  '--options',
  'config/typedoc.json',
  // TypeDoc's validation - an undocumented export, a {@link} to nothing - only warns on its own,
  // and a warning would pass CI unnoticed while Sphinx below fails on every one of its own.
  '--treatWarningsAsErrors',
]);
// TypeDoc names each module page after its entry file. The main one is what the Interface chapter
// opens with, so it is its introduction; the other is known by its import path.
retitle('docs/site/api/reference/index/index.md', 'Introduction');
retitle('docs/site/api/reference/diagnostics/index.md', 'serial-broker/diagnostics');
// The interface an application actually calls, named for what it is rather than for its file.
retitle('docs/site/api/reference/index/interfaces/SerialBrokerApi.md', 'Application API');
// The interface page is 578 lines of detail with no way to see what it offers; the overview
// gives the reader one line per method before the detail starts.
addMethodOverview('docs/site/api/reference/index/interfaces/SerialBrokerApi.md');
// Each method a section of its own, so the navigation lists them under the page.
liftMethods('docs/site/api/reference/index/interfaces/SerialBrokerApi.md');
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
            // The same anchors without a file in front of them: an interface that extends a class
            // gets a row pointing at its own page (`ErrorWithCode.configName` -> #property-configname)
            // for a member it does not redeclare, so the anchor it names is never written. The
            // reference is dropped and its text kept - the row already says where the member is from.
            .replace(/\[([^\]]+)\]\(#(?:property|enumeration-member)-[\w-]+\)/g, '$1')
            .replaceAll('| \\| ', '| '),
        ),
      );
      if (tidied !== text) {
        writeFileSync(path, tidied);
      }
    }
  }
}

/**
 * Puts a table of the methods at the top of a generated interface page.
 *
 * TypeDoc writes the members one after another, so a reader who wants to know what the interface
 * offers has to scroll through every signature, every parameter table and every example. The
 * overview is built from the page itself - the headings and the first sentence of each member -
 * so it cannot drift from what it lists.
 */
function addMethodOverview(path) {
  // Declared here rather than beside the other constants: this file calls the tidying at the
  // top, before a const further down would have been initialised.
  //
  // A method missing here still appears, under 'More', so adding one to the interface can never
  // drop it silently from the overview.
  const METHOD_GROUPS = [
    ['Connecting', ['setup', 'requestAccess', 'restore']],
    ['Sending and receiving', ['send', 'subscribe', 'unsubscribe']],
    ['Asking what is going on', ['getStatus', 'exists', 'names', 'isSupported']],
    ['Giving the device up', ['release', 'releaseAll', 'dispose']],
    ['Before anything else', ['configure']],
  ];
  const file = join(root, path);
  const lines = readFileSync(file, 'utf8').split('\n');
  const start = lines.indexOf('## Methods');
  if (start === -1) {
    return;
  }

  const summaries = new Map();
  for (let index = start; index < lines.length; index += 1) {
    if (!lines[index].startsWith('### ')) {
      continue;
    }
    const name = lines[index].slice(4).trim().replace(/\(\)$/, '');
    summaries.set(name, firstSentenceAfter(lines, index));
  }
  if (summaries.size === 0) {
    return;
  }

  const listed = new Set();
  const overview = ['## The methods', ''];
  for (const [heading, names] of METHOD_GROUPS) {
    const rows = names.filter((name) => summaries.has(name));
    if (rows.length === 0) {
      continue;
    }
    overview.push(`**${heading}**`, '', '| Method | What it does |', '| ------ | ------ |');
    for (const name of rows) {
      listed.add(name);
      overview.push(`| [\`${name}()\`](#${name.toLowerCase()}) | ${summaries.get(name)} |`);
    }
    overview.push('');
  }
  const rest = [...summaries.keys()].filter((name) => !listed.has(name));
  if (rest.length > 0) {
    overview.push('**More**', '', '| Method | What it does |', '| ------ | ------ |');
    for (const name of rest) {
      overview.push(`| [\`${name}()\`](#${name.toLowerCase()}) | ${summaries.get(name)} |`);
    }
    overview.push('');
  }

  lines.splice(start, 0, ...overview);
  writeFileSync(file, lines.join('\n'));
}

/**
 * Lifts every method to a section of its own, and drops the `Methods` heading that grouped them.
 *
 * The theme shows three levels (`navigation_depth` in conf.py): the reference page, this page,
 * and this page's sections. TypeDoc writes each method as `###` under a `## Methods` heading,
 * which puts them a level deeper than that - so the navigation showed the page and nothing of
 * what is on it. Lifting everything below that heading by one makes every method a section the
 * sidebar lists, and leaves `#### Parameters` and `#### Returns` one level below it, out of the
 * navigation and in the page where they belong. Anchors are unchanged: they follow the heading's
 * text, not its level, so every link to `#setup` still lands.
 */
function liftMethods(path) {
  const file = join(root, path);
  const lines = readFileSync(file, 'utf8').split('\n');
  const start = lines.indexOf('## Methods');
  if (start === -1) {
    return;
  }
  // The blank line that followed the heading goes with it; the one before it separates the
  // overview table from the first method.
  const from = lines[start + 1] === '' ? start + 2 : start + 1;
  let fenced = false;
  const lifted = lines.slice(from).map((line) => {
    if (line.startsWith('```')) {
      fenced = !fenced;
      return line;
    }
    // Only inside prose: a fenced example may well start a line with hashes of its own.
    return !fenced && /^####? /.test(line) ? line.slice(1) : line;
  });
  writeFileSync(file, [...lines.slice(0, start), ...lifted].join('\n'));
}

/** The first sentence of the prose that follows a member's heading and its signature. */
function firstSentenceAfter(lines, headingIndex) {
  let index = headingIndex + 1;
  // Skip the blank line and the fenced signature.
  while (index < lines.length && !lines[index].startsWith('```')) {
    index += 1;
  }
  index += 1;
  while (index < lines.length && !lines[index].startsWith('```')) {
    index += 1;
  }
  index += 1;
  while (index < lines.length && lines[index].trim() === '') {
    index += 1;
  }
  const paragraph = [];
  while (index < lines.length && lines[index].trim() !== '') {
    paragraph.push(lines[index].trim());
    index += 1;
  }
  const text = paragraph.join(' ');
  const stop = text.indexOf('. ');
  return stop === -1 ? text : `${text.slice(0, stop)}.`;
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
