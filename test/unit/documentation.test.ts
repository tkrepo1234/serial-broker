import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CONNECTION_SETTINGS,
  DEFAULT_ENCODING_SETTINGS,
  DEFAULT_MAX_TABS,
  DEFAULT_RECEIVE_SETTINGS,
  DEFAULT_REMEMBER,
  DEFAULT_SERIAL_SETTINGS,
} from '../../src/core/defaults.js';
import { normalizeConfiguration } from '../../src/core/validation.js';
import { VERSION } from '../../src/core/version.js';

/**
 * The documentation states defaults, ranges and log events that the source decides. These tests
 * read the chapters and hold every such statement against the source, so the two cannot drift.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

/** Every option `setup()` has a default for, by the section of configuration.md documenting it. */
const DEFAULTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  serial: { baudRate: undefined, ...DEFAULT_SERIAL_SETTINGS },
  connection: { ...DEFAULT_CONNECTION_SETTINGS },
  receive: { ...DEFAULT_RECEIVE_SETTINGS },
  encoding: { ...DEFAULT_ENCODING_SETTINGS },
  remember: { remember: DEFAULT_REMEMBER },
  maxTabs: { maxTabs: DEFAULT_MAX_TABS },
};

interface OptionRow {
  readonly section: string;
  readonly option: string;
  readonly range: string;
  readonly defaultValue: string;
}

/** The rows of every `| Option | Type and range | Default |` table, with the section they are in. */
function optionRows(markdown: string): OptionRow[] {
  const rows: OptionRow[] = [];
  let section: string | undefined;
  let inTable = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      section = /^## `(\w+)`$/.exec(line)?.[1];
      inTable = false;
    } else if (/^\|\s*Option\s*\|\s*Type and range\s*\|\s*Default\s*\|$/.test(line)) {
      inTable = true;
    } else if (!line.startsWith('|')) {
      inTable = false;
    } else if (inTable && section !== undefined && !/^\|\s*-/.test(line)) {
      const [option = '', range = '', defaultValue = ''] = line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim());
      rows.push({ section, option: option.replaceAll('`', ''), range, defaultValue });
    }
  }
  return rows;
}

/** A value written as one code span: `8`, `'none'`, `true`, `Infinity`, or `required`. */
function parseLiteral(cell: string): unknown {
  const text = /^`([^`]+)`$/.exec(cell)?.[1];
  if (text === undefined) {
    throw new Error(`"${cell}" is not a single code span`);
  }
  if (text === 'required') {
    return undefined;
  }
  if (text === 'Infinity') {
    return Number.POSITIVE_INFINITY;
  }
  if (text === 'true' || text === 'false') {
    return text === 'true';
  }
  const quoted = /^'(.*)'$/.exec(text)?.[1];
  if (quoted !== undefined) {
    return quoted;
  }
  const number = Number(text.replaceAll('_', ''));
  if (Number.isNaN(number)) {
    throw new Error(`"${cell}" is not a literal`);
  }
  return number;
}

const UNITS: Readonly<Record<string, number>> = {
  '': 1,
  byte: 1,
  bytes: 1,
  KiB: 1024,
  MiB: 1 << 20,
};

/** A quantity such as `3,600,000`, `1 byte` or `16 MiB`. */
function parseQuantity(text: string): number {
  const match = /^([\d,]+)(?: (\w+))?$/.exec(text.trim());
  const unit = UNITS[match?.[2] ?? ''];
  if (match?.[1] === undefined || unit === undefined) {
    throw new Error(`"${text}" is not a quantity`);
  }
  return Number(match[1].replaceAll(',', '')) * unit;
}

type Range =
  | {
      readonly kind: 'integer' | 'number';
      readonly min: number;
      readonly max: number;
      readonly infinity: boolean;
    }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'one-of'; readonly values: readonly unknown[] }
  | { readonly kind: 'label' };

function parseRange(cell: string): Range {
  if (cell === 'boolean') {
    return { kind: 'boolean' };
  }
  if (cell.startsWith('a label')) {
    return { kind: 'label' };
  }
  const numeric = /^(integer|number), (.+?) – (.+?)(, or `Infinity`)?$/.exec(cell);
  if (numeric !== null) {
    return {
      kind: numeric[1] === 'integer' ? 'integer' : 'number',
      min: parseQuantity(numeric[2] ?? ''),
      max: parseQuantity(numeric[3] ?? ''),
      infinity: numeric[4] !== undefined,
    };
  }
  const values = [...cell.matchAll(/`[^`]+`/g)].map((match) => parseLiteral(match[0]));
  if (values.length >= 2 && /^(?:`[^`]+`|,|or|\s)+$/.test(cell)) {
    return { kind: 'one-of', values };
  }
  throw new Error(`"${cell}" is not a range these tests understand`);
}

/** Whether `setup()` accepts the documented option set to `value`, everything else valid. */
function accepts(row: OptionRow, value: unknown): boolean {
  const serial = { baudRate: 9600 };
  // `remember` and `maxTabs` are options of their own; every other section is a group of options.
  const options =
    row.section === 'remember' || row.section === 'maxTabs'
      ? { serial, [row.option]: value }
      : row.section === 'serial'
        ? { serial: { ...serial, [row.option]: value } }
        : { serial, [row.section]: { [row.option]: value } };
  try {
    normalizeConfiguration('Documented', options);
    return true;
  } catch {
    // Rejected: every rejection is INVALID_ARGUMENT, which validation.test.ts pins.
    return false;
  }
}

describe('configuration.md', () => {
  const rows = optionRows(read('docs/site/configuration.md'));

  it('documents every option that has a default, and no other', () => {
    const documented = rows.map((row) => `${row.section}.${row.option}`).sort();
    const expected = Object.entries(DEFAULTS)
      .flatMap(([section, options]) => Object.keys(options).map((option) => `${section}.${option}`))
      .sort();
    expect(documented).toEqual(expected);
  });

  it.each(rows.map((row) => [`${row.section}.${row.option}`, row] as const))(
    'states the default of %s',
    (_, row) => {
      expect(parseLiteral(row.defaultValue)).toBe(DEFAULTS[row.section]?.[row.option]);
      expect(accepts(row, undefined)).toBe(parseLiteral(row.defaultValue) !== undefined);
    },
  );

  it.each(rows.map((row) => [`${row.section}.${row.option}`, row] as const))(
    'states the range of %s',
    (_, row) => {
      const range = parseRange(row.range);
      switch (range.kind) {
        case 'integer':
          expect([accepts(row, range.min), accepts(row, range.max)]).toEqual([true, true]);
          expect([accepts(row, range.min - 1), accepts(row, range.max + 1)]).toEqual([
            false,
            false,
          ]);
          expect(accepts(row, range.min + 0.5)).toBe(false);
          expect(accepts(row, Number.POSITIVE_INFINITY)).toBe(range.infinity);
          break;
        case 'number':
          expect([accepts(row, range.min), accepts(row, range.max)]).toEqual([true, true]);
          expect([accepts(row, range.min - 0.001), accepts(row, range.max + 0.001)]).toEqual([
            false,
            false,
          ]);
          expect(accepts(row, Number.POSITIVE_INFINITY)).toBe(range.infinity);
          break;
        case 'boolean':
          expect([accepts(row, true), accepts(row, false), accepts(row, 'true')]).toEqual([
            true,
            true,
            false,
          ]);
          break;
        case 'one-of':
          for (const value of range.values) {
            expect(accepts(row, value), String(value)).toBe(true);
          }
          expect(accepts(row, typeof range.values[0] === 'number' ? 9 : 'undocumented')).toBe(
            false,
          );
          break;
        case 'label':
          expect(accepts(row, parseLiteral(row.defaultValue))).toBe(true);
          break;
      }
    },
  );
});

/** Every source file of the library, as text, by path. */
function sources(): Map<string, string> {
  const files = readdirSync(join(ROOT, 'src'), { recursive: true, encoding: 'utf8' });
  return new Map(
    files.filter((file) => file.endsWith('.ts')).map((file) => [file, read(join('src', file))]),
  );
}

describe('diagnostics.md', () => {
  const table = read('docs/site/diagnostics.md')
    .split(/\r?\n/)
    .filter((line) => /^\| `[a-z]+\.[a-z0-9-]+`/.test(line));
  const events = table.map((line) => /^\| `([^`]+)`/.exec(line)?.[1] ?? '');
  const files = [...sources().values()];

  it('lists log events', () => {
    expect(events.length).toBeGreaterThan(40);
  });

  it.each(events)('lists %s, which the source logs', (event) => {
    // Written out as a string, or put together from a prefix and a quoted suffix in one file, as
    // `supervisor.${direction}` is.
    const dot = event.lastIndexOf('.');
    const prefix = `\`${event.slice(0, dot)}.\${`;
    const suffix = `'${event.slice(dot + 1)}'`;
    const logged = files.some(
      (text) => text.includes(`'${event}'`) || (text.includes(prefix) && text.includes(suffix)),
    );
    expect(logged).toBe(true);
  });
});

describe('the release', () => {
  it('is the one package.json names', () => {
    const { version } = JSON.parse(read('package.json')) as { version: string };
    expect(VERSION).toBe(version);
  });
});
