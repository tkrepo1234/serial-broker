/**
 * The shape of a benchmark run, and how it is judged and written down.
 *
 * Shared by the harness benchmark (`bench/harness/`) and the browser benchmark
 * (`bench/browser/`), so that both produce the same JSON under `bench/results/` and the same
 * Markdown fragment under `docs/site/_generated/`, which the Performance chapter includes. Every
 * measured value stands next to its expectation and the ratio between them; nothing here decides
 * what the expectation is (see `expectations.ts`).
 */

import type { Direction, Expectation, Expectations } from './expectations.js';

/** One measured value, judged against its expectation. */
export interface MetricResult {
  readonly key: string;
  readonly unit: string;
  readonly measured: number;
  readonly expected: number;
  readonly better: Direction;
  /**
   * How much worse than expected the measurement is: 1 is exactly the expectation, 2 is twice
   * as slow (or half the throughput), and anything at or under 1 is within it. `Infinity` for a
   * measurement of `0` where more was expected.
   */
  readonly ratio: number;
}

/** One scenario, on one transport. */
export interface ScenarioResult {
  readonly id: string;
  readonly transport: 'sharedworker' | 'broadcastchannel';
  /** How many measurements the percentiles are drawn from. */
  readonly samples: number;
  readonly metrics: readonly MetricResult[];
  /** What a reader has to know to read the numbers - what is compressed, what is not observable. */
  readonly note?: string;
}

/** Where a run took place, so that its numbers can be read for what they are. */
export interface Machine {
  readonly os: string;
  readonly cpu: string;
  readonly runtime: string;
  /** The browser and its version, for a browser run. */
  readonly browser?: string;
  /** What stood in for the device: the harness's fake, or the page-level stand-in. */
  readonly device: string;
}

/** A whole benchmark run: what was measured, where, and against which build. */
export interface BenchRun {
  readonly kind: 'harness' | 'browser';
  readonly date: string;
  readonly commit: string;
  readonly machine: Machine;
  readonly scenarios: readonly ScenarioResult[];
}

/** The value at percentile `p` (0-100) of `values`, by nearest rank; `NaN` for no values. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    return Number.NaN;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank] ?? Number.NaN;
}

/** Judges one measurement against its expectation. */
function judge(key: string, measured: number, expectation: Expectation): MetricResult {
  const ratio =
    expectation.better === 'lower'
      ? expectation.value === 0
        ? measured === 0
          ? 1
          : Number.POSITIVE_INFINITY
        : measured / expectation.value
      : measured === 0
        ? Number.POSITIVE_INFINITY
        : expectation.value / measured;
  return {
    key,
    unit: expectation.unit,
    // Rounded to what a reader can use: the JSON is committed, and noise in the tenth digit is
    // not a change worth a diff.
    measured: significant(measured, 4),
    expected: expectation.value,
    better: expectation.better,
    ratio: significant(ratio, 3),
  };
}

/** `value` rounded to `digits` significant digits. */
function significant(value: number, digits: number): number {
  if (!Number.isFinite(value) || value === 0) {
    return value;
  }
  return Number(value.toPrecision(digits));
}

/**
 * Judges every measurement of a scenario against the expectations for it.
 *
 * A measurement without an expectation, or an expectation without a measurement, is a mistake in
 * the benchmark rather than a result, and fails the run.
 */
export function judgeScenario(
  expectations: Expectations,
  id: string,
  transport: ScenarioResult['transport'],
  samples: number,
  measured: Readonly<Record<string, number>>,
  note?: string,
): ScenarioResult {
  const expected = expectations[id];
  if (expected === undefined) {
    throw new Error(`No expectation is written down for the scenario ${id}`);
  }
  const metrics = Object.entries(expected).map(([key, expectation]) => {
    const value = measured[key];
    if (value === undefined) {
      throw new Error(`The scenario ${id} did not measure ${key}`);
    }
    return judge(key, value, expectation);
  });
  for (const key of Object.keys(measured)) {
    if (!(key in expected)) {
      throw new Error(`The scenario ${id} measured ${key}, which has no expectation`);
    }
  }
  return note === undefined
    ? { id, transport, samples, metrics }
    : { id, transport, samples, metrics, note };
}

/** The results that are more than ten times worse than expected: each one needs a fix or a limit. */
export function farWorse(run: BenchRun): readonly (MetricResult & { scenario: ScenarioResult })[] {
  return run.scenarios.flatMap((scenario) =>
    scenario.metrics
      .filter((metric) => metric.ratio > 10)
      .map((metric) => ({ ...metric, scenario })),
  );
}

/** A number with the precision its unit deserves. */
function formatValue(value: number, unit: string): string {
  if (!Number.isFinite(value)) {
    return String(value);
  }
  switch (unit) {
    case 'B/s':
      return value >= 1_000_000
        ? `${(value / 1_000_000).toFixed(2)} MB/s`
        : `${(value / 1_000).toFixed(0)} KB/s`;
    case 'ms':
      return value >= 1000
        ? `${(value / 1000).toFixed(2)} s`
        : value >= 10
          ? `${value.toFixed(1)} ms`
          : `${value.toFixed(3)} ms`;
    case 'KB':
      return `${value.toFixed(0)} KB`;
    default:
      return `${String(value)} ${unit}`;
  }
}

/** How a ratio reads in a table. */
function formatRatio(ratio: number): string {
  if (!Number.isFinite(ratio)) {
    return 'far worse';
  }
  if (ratio <= 1) {
    return 'within';
  }
  return ratio > 10 ? `${ratio.toFixed(0)}x worse` : `${ratio.toFixed(1)}x worse`;
}

/** The comparison as words: what was expected, in the direction it was expected. */
function formatExpected(metric: MetricResult): string {
  const bound = formatValue(metric.expected, metric.unit);
  if (metric.better === 'lower' && metric.expected === 0) {
    return bound;
  }
  return metric.better === 'lower' ? `<= ${bound}` : `>= ${bound}`;
}

/** The rows every table is made of, one per metric. */
function rows(run: BenchRun): string[][] {
  return run.scenarios.flatMap((scenario) =>
    scenario.metrics.map((metric) => [
      scenario.id,
      scenario.transport,
      metric.key,
      formatValue(metric.measured, metric.unit),
      formatExpected(metric),
      formatRatio(metric.ratio),
    ]),
  );
}

const HEADER = ['Scenario', 'Transport', 'Metric', 'Measured', 'Expected', 'Verdict'];

/** The results as a plain-text table for the terminal. */
export function formatTable(run: BenchRun): string {
  const body = rows(run);
  const table = [HEADER, ...body];
  const widths = HEADER.map((_, column) =>
    Math.max(...table.map((row) => (row[column] ?? '').length)),
  );
  const line = (row: readonly string[]): string =>
    row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  ');
  return [line(HEADER), widths.map((width) => '-'.repeat(width)).join('  '), ...body.map(line)]
    .join('\n')
    .concat('\n');
}

/**
 * The results as the Markdown fragment the documentation includes.
 *
 * Generated, and committed with the results it is made from, so that the documentation builds
 * without a benchmark run and the numbers a reader sees are the numbers that were measured.
 */
export function formatMarkdown(run: BenchRun): string {
  const lines: string[] = [
    `<!-- Generated by \`npm run ${run.kind === 'harness' ? 'bench' : 'bench:browser'}\`. Do not edit; run it again. -->`,
    '',
    `Measured on ${run.date} at commit \`${run.commit}\`: ${run.machine.os}, ${run.machine.cpu},`,
    `${run.machine.runtime}${run.machine.browser === undefined ? '' : `, ${run.machine.browser}`}; the device was ${run.machine.device}.`,
    '',
    `| ${HEADER.join(' | ')} |`,
    `| ${HEADER.map(() => '---').join(' | ')} |`,
    ...rows(run).map((row) => `| ${row.map(markdownCell).join(' | ')} |`),
  ];
  const notes = run.scenarios
    .filter((scenario) => scenario.note !== undefined)
    .filter(
      (scenario, index, all) => all.findIndex((other) => other.note === scenario.note) === index,
    );
  if (notes.length > 0) {
    lines.push('');
    for (const scenario of notes) {
      lines.push(`- **${scenario.id}**: ${scenario.note ?? ''}`);
    }
  }
  return lines.join('\n').concat('\n');
}

function markdownCell(text: string): string {
  return text.replace(/\|/g, '\\|');
}
