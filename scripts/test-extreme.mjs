/**
 * Runs the extreme suite and records its numbers.
 *
 * `npm run test:extreme`. It runs `test/integration/extreme/` with `SERIAL_BROKER_EXTREME=1` and
 * `--expose-gc` - the suite measures the heap after a garbage collection and refuses to run
 * without one - on one worker, so that one scenario's memory is not another's, and turns what the
 * scenarios record into `test/integration/extreme/RESULTS.md`, committed as the record of the
 * last run. Arguments after the script name go to Vitest, so one scenario can be run alone:
 *
 *     npm run test:extreme -- sustained-traffic
 *
 * The sizes are the suite's defaults unless `SERIAL_BROKER_EXTREME_*` variables say otherwise
 * (`test/integration/extreme/support/extreme.ts`). Never run in CI: minutes long by design.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, totalmem, version as osVersion, type as osType } from 'node:os';
import { dirname, join, relative } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const report = join(root, 'test-results', 'extreme', 'results.jsonl');
const results = join(root, 'test', 'integration', 'extreme', 'RESULTS.md');

rmSync(report, { force: true });
mkdirSync(dirname(report), { recursive: true });

const nodeOptions = [process.env['NODE_OPTIONS'], '--expose-gc'].filter(Boolean).join(' ');
// Plain arguments pick scenario files; anything starting with `--` goes to Vitest as it is. An
// option with a value is therefore written `--option=value`: a value on its own would be read as
// a scenario file.
const filters = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
const options = process.argv.slice(2).filter((argument) => argument.startsWith('--'));
const startedAt = new Date();
const run = spawnSync(
  process.execPath,
  [
    join(root, 'node_modules', 'vitest', 'vitest.mjs'),
    'run',
    // The configuration lives in config/ (ADR-0025), where Vitest does not look on its own.
    '--config',
    'config/vitest.config.ts',
    '--maxWorkers=1',
    ...options,
    ...(filters.length > 0 ? filters : ['test/integration/extreme']),
  ],
  {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_OPTIONS: nodeOptions,
      SERIAL_BROKER_EXTREME: '1',
      SERIAL_BROKER_EXTREME_REPORT: report,
    },
  },
);

const rows = [];
let isReportComplete = true;
for (const line of existsSync(report) ? readFileSync(report, 'utf8').split('\n') : []) {
  if (line.trim() === '') {
    continue;
  }
  try {
    rows.push(JSON.parse(line));
  } catch {
    // A scenario killed while writing leaves half a row. The rest of the run is still worth its
    // record, and the exit code says that the record is not whole.
    isReportComplete = false;
    process.stderr.write(`Skipped a row of ${relative(root, report)} that is not JSON: ${line}\n`);
  }
}

if (rows.length > 0) {
  const markdown = render(rows, startedAt, run.status === 0);
  writeFileSync(results, markdown);
  process.stdout.write(`\n${markdown}\nWritten to ${relative(root, results)}\n`);
} else {
  process.stdout.write('\nNo scenario recorded a result.\n');
}

process.exit(isReportComplete ? (run.status ?? 1) : run.status || 1);

/** The Markdown record of one run: where it ran, what it ran, and what it measured. */
function render(rows, startedAt, passed) {
  const cpu = cpus()[0]?.model?.trim() ?? 'unknown CPU';
  const memoryGiB = Math.round(totalmem() / 1024 ** 3);
  const durationS = Math.round(rows.reduce((sum, row) => sum + row.wallMs, 0) / 1000);
  const lines = [
    '# Extreme suite: last run',
    '',
    'Written by `npm run test:extreme` (`scripts/test-extreme.mjs`); do not edit by hand. What each',
    'scenario does and what its bounds are is in the scenario files next to this one, and in',
    'docs/guidelines/testing.md, "The extreme suite".',
    '',
    `- **Run:** ${startedAt.toISOString().slice(0, 19).replace('T', ' ')} UTC, ${passed ? 'every bound held' : '**a bound failed** (see the test output)'}`,
    `- **Machine:** ${cpu}, ${String(memoryGiB)} GiB, ${osType()} ${osVersion()}`,
    `- **Runtime:** Node ${process.version}, one Vitest worker, \`--expose-gc\``,
    `- **Scenarios:** ${String(rows.length)}, ${String(durationS)} s of measured load in total`,
    '',
    '## Load and cost',
    '',
    'Messages are counted at the transport of every tab: sent is what tabs handed to the bus,',
    'delivered is what the bus handed to tabs - each delivery a structured clone in a browser.',
    'Each is shown with its budget, the most the scenario allows for its load.',
    '',
    '| Scenario | Transport | Load | Wall | Messages sent (budget) | Messages delivered (budget) |',
    '| --- | --- | --- | ---: | ---: | ---: |',
    ...rows.map(
      (row) =>
        `| ${row.scenario} | ${row.transport} | ${describeLoad(row.load)} | ${seconds(row.wallMs)} | ${count(row.messagesSent)} (${count(row.budget.sent)}) | ${count(row.messagesDelivered)} (${count(row.budget.delivered)}) |`,
    ),
    '',
    '## Footprint before and after the load',
    '',
    'Heap and buffers are MiB after a full garbage collection. Every other column is a count, and',
    'must be the same before and after: what the load left behind is the difference.',
    '',
    '| Scenario | Transport | Heap | Buffers | Timers | Bus timers | Device listeners | Listeners | Locks held | Locks pending | Pending writes | Queued at port | Worker clients |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows.map(
      (row) =>
        `| ${row.scenario} | ${row.transport} | ${pair(row, 'heapMiB')} | ${pair(row, 'arrayBufferMiB')} | ${pair(row, 'timers')} | ${pair(row, 'busTimers')} | ${pair(row, 'deviceListeners')} | ${pair(row, 'listeners')} | ${pair(row, 'locksHeld')} | ${pair(row, 'locksPending')} | ${pair(row, 'pendingWrites')} | ${pair(row, 'queuedWritesAtPort')} | ${pair(row, 'workerClients')} |`,
    ),
    '',
  ];
  return lines.join('\n');
}

function describeLoad(load) {
  return Object.entries(load)
    .map(([key, value]) => `${key} ${typeof value === 'number' ? count(value) : String(value)}`)
    .join(', ');
}

function pair(row, key) {
  const before = row.before[key];
  const after = row.after[key];
  return before === after ? String(before) : `${String(before)} → ${String(after)}`;
}

function count(value) {
  return Number(value).toLocaleString('en-US');
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)} s`;
}
