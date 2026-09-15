/**
 * The benchmark scenarios in a real browser, with the Web Serial stand-in.
 *
 * The same scenarios as `bench/harness/scenarios.ts`, so that the two tables of the Performance
 * chapter can be read side by side; the differences are what a browser forces. Time between
 * writes is real time, so the write scenarios take as long as their rates say. A simulated hour of
 * traffic is its volume - 3600 chunks and 3600 writes - as fast as the pages take it, because an
 * hour of wall clock is not a benchmark anyone runs. The heap is read through the DevTools
 * protocol after a forced collection; the browser's timers are not observable from outside.
 *
 * A handover after a crash is timed from the moment the renderer is told to crash, in the test
 * runner's clock, to the moment a surviving page reports `open`, in the page's: both are the
 * system clock, and the difference includes the round trip that orders the crash. Everything
 * else is stamped inside the pages.
 *
 * Opt-in only, never in CI: `SERIAL_BROKER_BENCH_BROWSER=1 npm run bench:browser`. See ADR-0037.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, release, version } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { test, type Browser, type BrowserContext, type Page } from '@playwright/test';

import type { SerialBrokerOptions } from '../../src/core/types.js';
import { GRANTED_DEVICE, installStandIn, STAND_IN_DEVICE } from '../../test/browser/support/tab.js';
import { describeCommit } from '../commit.js';
import { BROWSER_EXPECTATIONS } from '../expectations.js';
import {
  farWorse,
  formatMarkdown,
  formatTable,
  judgeScenario,
  percentile,
  type BenchRun,
  type ScenarioResult,
} from '../report.js';

import { CHUNK_BYTES, type BenchPage, type ReceiveStats } from './pages/bench-harness.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = 'Reader';
const OPTIONS: SerialBrokerOptions = {
  device: STAND_IN_DEVICE,
  serial: { baudRate: 9600 },
  remember: false,
};
type Transport = ScenarioResult['transport'];
const TRANSPORTS: readonly Transport[] = ['sharedworker', 'broadcastchannel'];

const WARM_UP_CHUNKS = 20;
const LATENCY_CHUNKS = 300;
const LATENCY_GAP_MS = 10;
const BURST_CHUNKS = 2_000;
const REPEATS = 5;

const optedIn = process.env['SERIAL_BROKER_BENCH_BROWSER'] === '1';
const results: ScenarioResult[] = [];

type BenchWindow = Window & { bench: BenchPage };

/** One benchmark page: `bench.html`, driven through `window.bench`. */
class BenchTab {
  private constructor(readonly page: Page) {}

  static async open(context: BrowserContext, transport: Transport): Promise<BenchTab> {
    const page = await context.newPage();
    await page.goto(`/bench/bench.html?transport=${transport}`);
    await page.waitForFunction(() => 'bench' in window);
    return new BenchTab(page);
  }

  /** Sets the configuration up and returns the milliseconds until it was `open`. */
  async setup(): Promise<number> {
    return await this.page.evaluate(
      ([name, options]) => (window as unknown as BenchWindow).bench.setup(name, options),
      [NAME, OPTIONS] as const,
    );
  }

  async holdsPort(): Promise<boolean> {
    return await this.page.evaluate(() =>
      (window as unknown as BenchWindow).bench.isPortOpenHere(),
    );
  }

  async emitStamped(count: number, gapMs: number): Promise<number> {
    return await this.page.evaluate(
      ([chunks, gap]) => (window as unknown as BenchWindow).bench.emitStamped(chunks, gap),
      [count, gapMs] as const,
    );
  }

  async receiveStats(): Promise<ReceiveStats> {
    return await this.page.evaluate(
      (name) => (window as unknown as BenchWindow).bench.receiveStats(name),
      NAME,
    );
  }

  async resetReceive(): Promise<void> {
    await this.page.evaluate((name) => {
      (window as unknown as BenchWindow).bench.resetReceive(name);
    }, NAME);
  }

  async waitForChunks(count: number): Promise<void> {
    await this.page.waitForFunction(
      ([name, wanted]) =>
        (window as unknown as BenchWindow).bench.receiveStats(name).chunks >= wanted,
      [NAME, count] as const,
      { timeout: 120_000 },
    );
  }

  async waitForBytes(count: number): Promise<void> {
    await this.page.waitForFunction(
      ([name, wanted]) =>
        (window as unknown as BenchWindow).bench.receiveStats(name).bytes >= wanted,
      [NAME, count] as const,
      { timeout: 120_000 },
    );
  }

  async timedWrites(count: number, gapMs: number): Promise<number[]> {
    return await this.page.evaluate(
      ([name, writes, gap]) =>
        (window as unknown as BenchWindow).bench.timedWrites(name, writes, gap),
      [NAME, count, gapMs] as const,
    );
  }

  async timedWrite(byteLength: number): Promise<number> {
    return await this.page.evaluate(
      ([name, length]) => (window as unknown as BenchWindow).bench.timedWrite(name, length),
      [NAME, byteLength] as const,
    );
  }

  async resetOpenedAt(): Promise<void> {
    await this.page.evaluate((name) => {
      (window as unknown as BenchWindow).bench.resetOpenedAt(name);
    }, NAME);
  }

  async waitForOpenedAt(): Promise<number> {
    await this.page.waitForFunction(
      (name) => (window as unknown as BenchWindow).bench.openedAt(name) !== undefined,
      NAME,
      // A page that lost the worker with the crashed page reconnects once the browser lets go of the
      // worker's lock (ADR-0041); the margin is for a browser that is slow to.
      { timeout: 180_000 },
    );
    const openedAt = await this.page.evaluate(
      (name) => (window as unknown as BenchWindow).bench.openedAt(name),
      NAME,
    );
    if (openedAt === undefined) {
      throw new Error('The page reported open and then forgot when');
    }
    return openedAt;
  }

  /** Releases the configuration; returns when the call was made, on the shared clock. */
  async release(): Promise<number> {
    return await this.page.evaluate(
      (name) => (window as unknown as BenchWindow).bench.release(name),
      NAME,
    );
  }

  async holdReferenceLock(lockName: string): Promise<void> {
    await this.page.evaluate(
      (lock) => (window as unknown as BenchWindow).bench.holdReferenceLock(lock),
      lockName,
    );
  }

  async queueForReferenceLock(lockName: string): Promise<void> {
    await this.page.evaluate((lock) => {
      (window as unknown as BenchWindow).bench.queueForReferenceLock(lock);
    }, lockName);
  }

  async referenceLockGrantedAt(): Promise<number | undefined> {
    return await this.page.evaluate(() =>
      (window as unknown as BenchWindow).bench.referenceLockGrantedAt(),
    );
  }

  /** Kills the renderer, as the browser suite does; returns when it was told to. */
  async crash(): Promise<number> {
    const session = await this.page.context().newCDPSession(this.page);
    const toldAt = Date.now();
    void session.send('Page.crash').catch(() => {
      // The target is gone, which is what was asked for.
    });
    await this.page.waitForEvent('crash');
    return toldAt;
  }

  /** The heap in use after a forced collection, in bytes. */
  async heapUsed(): Promise<number> {
    const session = await this.page.context().newCDPSession(this.page);
    try {
      await session.send('HeapProfiler.collectGarbage');
      await session.send('HeapProfiler.collectGarbage');
      const { usedSize } = await session.send('Runtime.getHeapUsage');
      return usedSize;
    } finally {
      await session.detach();
    }
  }

  async errors(): Promise<readonly string[]> {
    return await this.page.evaluate(() => (window as unknown as BenchWindow).bench.errors());
  }
}

/** A fresh browser context with the device granted, and `count` tabs on the configuration. */
async function openConnected(
  browser: Browser,
  transport: Transport,
  count: number,
): Promise<{ context: BrowserContext; tabs: BenchTab[]; setupMs: number[] }> {
  const context = await browser.newContext();
  await installStandIn(context, GRANTED_DEVICE);
  const tabs: BenchTab[] = [];
  const setupMs: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const tab = await BenchTab.open(context, transport);
    setupMs.push(await tab.setup());
    tabs.push(tab);
  }
  return { context, tabs, setupMs };
}

/** Which tab holds the device open, by index. */
async function holderOf(tabs: readonly BenchTab[]): Promise<number> {
  const holders: number[] = [];
  for (const [index, tab] of tabs.entries()) {
    if (await tab.holdsPort()) {
      holders.push(index);
    }
  }
  const holder = holders[0];
  if (holders.length !== 1 || holder === undefined) {
    throw new Error(`Expected exactly one tab to hold the device, found ${String(holders.length)}`);
  }
  return holder;
}

async function assertNoErrors(tabs: readonly BenchTab[]): Promise<void> {
  for (const tab of tabs) {
    const errors = await tab.errors();
    if (errors.length > 0) {
      throw new Error(`A page reported errors: ${errors.join('; ')}`);
    }
  }
}

function record(
  id: string,
  transport: Transport,
  samples: number,
  values: Readonly<Record<string, number>>,
  note?: string,
): void {
  results.push(judgeScenario(BROWSER_EXPECTATIONS, id, transport, samples, values, note));
}

async function deviceToTabs(
  browser: Browser,
  transport: Transport,
  tabCount: number,
): Promise<void> {
  const { context, tabs } = await openConnected(browser, transport, tabCount);
  const holder = tabs[await holderOf(tabs)];
  if (holder === undefined) {
    throw new Error('No tab holds the port');
  }

  await holder.emitStamped(WARM_UP_CHUNKS, LATENCY_GAP_MS);
  for (const tab of tabs) {
    await tab.waitForChunks(WARM_UP_CHUNKS);
    await tab.resetReceive();
  }

  await holder.emitStamped(LATENCY_CHUNKS, LATENCY_GAP_MS);
  const latencies: number[] = [];
  for (const tab of tabs) {
    await tab.waitForChunks(LATENCY_CHUNKS);
    latencies.push(...(await tab.receiveStats()).latencies);
    await tab.resetReceive();
  }

  const startedAt = await holder.emitStamped(BURST_CHUNKS, 0);
  let finishedAt = startedAt;
  for (const tab of tabs) {
    await tab.waitForChunks(BURST_CHUNKS);
    const stats = await tab.receiveStats();
    if (stats.chunks !== BURST_CHUNKS) {
      throw new Error(`A tab received ${String(stats.chunks)} chunks of ${String(BURST_CHUNKS)}`);
    }
    finishedAt = Math.max(finishedAt, stats.lastReceivedAt ?? startedAt);
  }
  await assertNoErrors(tabs);
  await context.close();

  record(
    `device-to-tabs/${String(tabCount)}`,
    transport,
    latencies.length,
    {
      throughput: (BURST_CHUNKS * CHUNK_BYTES) / ((finishedAt - startedAt) / 1000),
      latencyP50: percentile(latencies, 50),
      latencyP95: percentile(latencies, 95),
    },
    `${String(CHUNK_BYTES)}-byte chunks pushed by the stand-in in the page holding the port; latency from the push to \`onReceive\` in each page, one chunk every ${String(LATENCY_GAP_MS)} ms; throughput from a burst of ${String(BURST_CHUNKS)} chunks, until the last page has the last one.`,
  );
}

async function tabsToDevice(browser: Browser, transport: Transport): Promise<void> {
  const { context, tabs } = await openConnected(browser, transport, 2);
  const sender = tabs[1 - (await holderOf(tabs))];
  if (sender === undefined) {
    throw new Error('No tab is free to send');
  }
  await sender.timedWrites(20, 10);

  for (const rate of [1, 10, 100]) {
    const count = Math.min(300, Math.max(20, rate * 3));
    const latencies = await sender.timedWrites(count, 1000 / rate);
    record(
      `tabs-to-device/${String(rate)}-per-second`,
      transport,
      count,
      { latencyP50: percentile(latencies, 50), latencyP95: percentile(latencies, 95) },
      'A six-byte write from the page that does not hold the port, timed from `send()` to its promise settling; the interval between writes is real time.',
    );
  }

  const megabyte = 1024 * 1024;
  const durations: number[] = [];
  for (let repeat = 0; repeat < 3; repeat += 1) {
    for (const tab of tabs) {
      await tab.resetReceive();
    }
    durations.push(await sender.timedWrite(megabyte));
    // The stand-in echoes the megabyte back; the next write starts on a quiet line.
    for (const tab of tabs) {
      await tab.waitForBytes(megabyte);
    }
  }
  await assertNoErrors(tabs);
  await context.close();
  record(
    'tabs-to-device/1-mb-write',
    transport,
    durations.length,
    { wallP50: percentile(durations, 50) },
    'One `send()` of 1 MiB from the page that does not hold the port, to its promise settling, with the default 4 KiB write chunk; the stand-in then echoes it back in 255-byte pieces.',
  );
}

async function handover(
  browser: Browser,
  transport: Transport,
  kind: 'crash' | 'release',
): Promise<void> {
  const first: number[] = [];
  const every: number[] = [];
  const library: number[] = [];
  for (let repeat = 0; repeat < REPEATS; repeat += 1) {
    const { context, tabs } = await openConnected(browser, transport, 3);
    // The first page opened holds the port, and on the SharedWorker transport it is also the page
    // that started the worker - as in an application whose first tab is the one opened first.
    const holderIndex = await holderOf(tabs);
    const holder = tabs[holderIndex];
    const survivors = tabs.filter((_, index) => index !== holderIndex);
    const reference = survivors[survivors.length - 1];
    if (holder === undefined || reference === undefined) {
      throw new Error('No tab holds the port');
    }
    for (const tab of survivors) {
      await tab.resetOpenedAt();
    }
    const referenceLock = `bench-reference-${String(repeat)}`;
    if (kind === 'crash') {
      await holder.holdReferenceLock(referenceLock);
      await reference.queueForReferenceLock(referenceLock);
    }

    const from = kind === 'crash' ? await holder.crash() : await holder.release();
    // Each page stamps its own moment, so waiting for them one after the other biases nothing.
    const openedAt: number[] = [];
    for (const tab of survivors) {
      openedAt.push(await tab.waitForOpenedAt());
    }
    await holderOf(survivors);
    await assertNoErrors(survivors);
    first.push(Math.min(...openedAt) - from);
    every.push(Math.max(...openedAt) - from);
    if (kind === 'crash') {
      const grantedAt = await reference.referenceLockGrantedAt();
      if (grantedAt === undefined) {
        throw new Error('The reference lock was not granted after the crash');
      }
      library.push(Math.min(...openedAt) - grantedAt);
    }
    await context.close();
  }
  const timed = {
    wallP50: percentile(first, 50),
    wallP95: percentile(first, 95),
    everyTabP50: percentile(every, 50),
    everyTabP95: percentile(every, 95),
  };
  if (kind === 'crash') {
    record(
      'handover/crash',
      transport,
      REPEATS,
      { ...timed, libraryP50: percentile(library, 50), libraryP95: percentile(library, 95) },
      'Three pages; the renderer of the one holding the port - the first page opened, which on the SharedWorker transport also started the worker - is crashed through the DevTools protocol. `wall` times the first surviving page to report `open`, `everyTab` the last, both from the moment the crash was ordered; `library` times the first against a plain Web Lock the crashed page held, granted to a surviving page in the same crash.',
    );
  } else {
    record(
      'handover/release',
      transport,
      REPEATS,
      timed,
      'Three pages; the one holding the port releases the configuration. `wall` times the first surviving page to report `open`, `everyTab` the last, both from the call.',
    );
  }
}

async function start(
  browser: Browser,
  transport: Transport,
  kind: 'first-tab' | 'joining-tab',
): Promise<void> {
  const walls: number[] = [];
  for (let repeat = 0; repeat < REPEATS; repeat += 1) {
    const count = kind === 'first-tab' ? 1 : 2;
    const { context, tabs, setupMs } = await openConnected(browser, transport, count);
    const measured = setupMs[count - 1];
    if (measured === undefined) {
      throw new Error('No setup was timed');
    }
    walls.push(measured);
    await assertNoErrors(tabs);
    await context.close();
  }
  record(
    `start/${kind}`,
    transport,
    REPEATS,
    { wallP50: percentile(walls, 50), wallP95: percentile(walls, 95) },
    kind === 'first-tab'
      ? 'A fresh browser context with the device granted: from `setup()` to the page reporting `open`.'
      : 'A page joining a configuration another page already holds open: from `setup()` to `open`.',
  );
}

async function steadyState(browser: Browser, transport: Transport): Promise<void> {
  const { context, tabs } = await openConnected(browser, transport, 3);
  const holderIndex = await holderOf(tabs);
  const holder = tabs[holderIndex];
  const sender = tabs[(holderIndex + 1) % tabs.length];
  if (holder === undefined || sender === undefined) {
    throw new Error('Not enough tabs');
  }
  const hour = 3600;

  // A minute of warm-up, then the readings.
  await Promise.all([holder.emitStamped(60, 1), sender.timedWrites(60, 1)]);
  for (const tab of tabs) {
    await tab.waitForChunks(60);
    await tab.resetReceive();
  }
  const before = await Promise.all(tabs.map((tab) => tab.heapUsed()));

  await Promise.all([holder.emitStamped(hour, 1), sender.timedWrites(hour, 1)]);
  for (const tab of tabs) {
    await tab.waitForChunks(hour);
  }
  const after = await Promise.all(tabs.map((tab) => tab.heapUsed()));
  await assertNoErrors(tabs);
  await context.close();

  const growth = Math.max(...after.map((bytes, index) => bytes - (before[index] ?? bytes)));
  record(
    'steady-state/one-hour',
    transport,
    tabs.length,
    { heapGrowth: growth / 1024 },
    "An hour's traffic - 3600 chunks and 3600 writes across three pages - as fast as the pages take it; the largest growth of any page's heap, read through the DevTools protocol after a forced collection before and after.",
  );
}

for (const transport of TRANSPORTS) {
  test(`every scenario over ${transport}`, async ({ browser }) => {
    test.skip(
      !optedIn,
      'Opt in with SERIAL_BROKER_BENCH_BROWSER=1; the benchmark never runs in CI',
    );
    const steps: readonly (readonly [string, () => Promise<void>])[] = [
      ['device-to-tabs/1', () => deviceToTabs(browser, transport, 1)],
      ['device-to-tabs/5', () => deviceToTabs(browser, transport, 5)],
      ['device-to-tabs/10', () => deviceToTabs(browser, transport, 10)],
      ['tabs-to-device', () => tabsToDevice(browser, transport)],
      ['handover/crash', () => handover(browser, transport, 'crash')],
      ['handover/release', () => handover(browser, transport, 'release')],
      ['start/first-tab', () => start(browser, transport, 'first-tab')],
      ['start/joining-tab', () => start(browser, transport, 'joining-tab')],
      ['steady-state/one-hour', () => steadyState(browser, transport)],
    ];
    for (const [id, step] of steps) {
      const startedAt = Date.now();
      await step();
      // So that a slow run shows where its time went; the numbers themselves are in the results.
      process.stderr.write(
        `${id} (${transport}): ${((Date.now() - startedAt) / 1000).toFixed(1)} s\n`,
      );
    }
  });
}

test.afterAll(async ({ browser }) => {
  if (results.length === 0) {
    return;
  }
  const run: BenchRun = {
    kind: 'browser',
    date: new Date().toISOString().slice(0, 10),
    commit: describeCommit(ROOT),
    machine: {
      os: `${version()} (${release()})`,
      cpu: cpus()[0]?.model.trim() ?? 'unknown CPU',
      runtime: `Node ${process.versions.node}, Playwright ${playwrightVersion()}`,
      browser: `${process.env['SERIAL_BROKER_BROWSER_CHANNEL'] ?? 'msedge'} ${browser.version()}`,
      device:
        'the Web Serial stand-in (`test/browser/stand-in/web-serial-stand-in.ts`), a loopback',
    },
    scenarios: results,
  };
  mkdirSync(join(ROOT, 'bench', 'results'), { recursive: true });
  mkdirSync(join(ROOT, 'docs', 'site', '_generated'), { recursive: true });
  writeFileSync(
    join(ROOT, 'bench', 'results', 'browser.json'),
    `${JSON.stringify(run, null, 2)}\n`,
  );
  writeFileSync(
    join(ROOT, 'docs', 'site', '_generated', 'browser-benchmark.md'),
    formatMarkdown(run),
  );
  const worst = farWorse(run);
  process.stdout.write(
    `\n${formatTable(run)}\n${
      worst.length === 0
        ? 'No result is more than ten times worse than its expectation.'
        : `${String(worst.length)} result(s) more than ten times worse than expected - each needs a fix or a documented limit (docs/site/performance.md).`
    }\nResults in bench/results/browser.json and docs/site/_generated/browser-benchmark.md.\n`,
  );
  await Promise.resolve();
});

/** The pinned Playwright, from the root package.json: the one that drove the browser. */
function playwrightVersion(): string {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    devDependencies?: Record<string, string>;
  };
  return manifest.devDependencies?.['@playwright/test'] ?? 'unknown';
}
