/**
 * Twenty pages sharing one device in a real browser, under traffic, for minutes, with the page
 * holding the port closed every half minute - and their memory read while it happens.
 *
 * The in-process extreme suite (`test/integration/extreme/`) measures what the library holds in
 * a simulated browser. This measures what a real Chromium holds for it: the heap, DOM nodes and
 * event listeners of every page, read over CDP after a garbage collection, at the start, the
 * middle and the end of the run - and of the `SharedWorker`, where Chromium answers for it.
 *
 * **Opt-in**: runs only with `SERIAL_BROKER_EXTREME=1`, never in CI, and takes the minutes it
 * says. Sizes come from the environment; see `RESULTS.md` next to this file for the last run.
 *
 *     SERIAL_BROKER_EXTREME=1 npm run test:browser -- test/browser/extreme --workers=1
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { expect, test, type BrowserContext } from '@playwright/test';

import {
  echoConfiguration,
  GRANTED_DEVICE,
  installStandIn,
  sharedWorkerMemory,
  Tab,
  tabHoldingThePort,
  waitForPortHolder,
  type MemorySample,
  type WorkerMemorySample,
} from '../support/tab.js';

const IS_EXTREME = process.env['SERIAL_BROKER_EXTREME'] === '1';
const PAGES = sizeFromEnvironment('SERIAL_BROKER_EXTREME_PAGES', 20);
const MINUTES = sizeFromEnvironment('SERIAL_BROKER_EXTREME_BROWSER_MINUTES', 5);
const OWNER_CLOSE_EVERY_S = sizeFromEnvironment('SERIAL_BROKER_EXTREME_OWNER_CLOSE_SECONDS', 30);
/** Every page sends a line this often; twenty pages make forty lines a second on the loopback. */
const SEND_EVERY_MS = 500;

/**
 * The bounds. A page's heap after a collection moves by a MiB or two between two readings of the
 * same idle page, so a bound of a few MiB is what tells growth from noise; a leak of one closure
 * per event would cross it within the first minute of forty events a second. Nodes and listeners
 * are counts the library never adds to per event, so they may not grow at all beyond what an
 * ownership change registers once.
 */
const HEAP_GROWTH_BOUND_MIB = 4;
const NODE_GROWTH_BOUND = 10;
const LISTENER_GROWTH_BOUND = 10;

function sizeFromEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, not ${JSON.stringify(raw)}`);
  }
  return value;
}

/** A page of the run, with the readings taken of it. */
interface Participant {
  tab: Tab;
  /** The page's number in the run; a replacement page gets a new one. */
  readonly number: number;
  readonly samples: Map<'start' | 'middle' | 'end', MemorySample>;
}

async function openParticipant(context: BrowserContext, number: number): Promise<Participant> {
  const tab = await Tab.open(context);
  await tab.setup('Echo', echoConfiguration());
  await tab.waitForStatus('Echo', 'open');
  await tab.startTraffic('Echo', SEND_EVERY_MS, `page ${String(number)};`);
  return { tab, number, samples: new Map() };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test.describe('twenty pages under sustained traffic', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(
    !IS_EXTREME,
    'Takes minutes and a browser with twenty pages; set SERIAL_BROKER_EXTREME=1 to run it.',
  );

  test(`${String(PAGES)} pages share the device for ${String(MINUTES)} minutes with the owner closed every ${String(OWNER_CLOSE_EVERY_S)} s, and hold no more at the end than at the start`, async ({
    context,
    browserName,
  }) => {
    test.setTimeout((MINUTES + 5) * 60_000);
    await installStandIn(context, GRANTED_DEVICE);
    const participants: Participant[] = [];
    for (let number = 1; number <= PAGES; number += 1) {
      participants.push(await openParticipant(context, number));
    }
    const closed: Participant[] = [];
    const workerSamples = new Map<'start' | 'middle' | 'end', WorkerMemorySample | undefined>();
    let nextNumber = PAGES + 1;
    const startedAt = Date.now();
    const endsAt = startedAt + MINUTES * 60_000;
    const middleAt = startedAt + (MINUTES * 60_000) / 2;
    /** Half a minute of warm-up: the first readings are of pages that have been busy already. */
    const warmUpMs = Math.min(30_000, (MINUTES * 60_000) / 4);

    async function sampleAll(point: 'start' | 'middle' | 'end'): Promise<void> {
      for (const participant of participants) {
        // What the test page collected is dropped first, so the reading is the library's.
        await participant.tab.resetHistory('Echo');
        participant.samples.set(point, await participant.tab.memory());
      }
      const first = participants[0];
      workerSamples.set(
        point,
        first === undefined ? undefined : await sharedWorkerMemory(first.tab),
      );
    }

    await sleep(warmUpMs);
    await sampleAll('start');
    let nextClose = Date.now() + OWNER_CLOSE_EVERY_S * 1_000;
    let sampledMiddle = false;
    while (Date.now() < endsAt) {
      await sleep(1_000);
      if (!sampledMiddle && Date.now() >= middleAt) {
        await sampleAll('middle');
        sampledMiddle = true;
      }
      if (Date.now() >= nextClose) {
        nextClose = Date.now() + OWNER_CLOSE_EVERY_S * 1_000;
        const holder = await tabHoldingThePort(participants.map((participant) => participant.tab));
        const [leaving] = participants.splice(holder, 1);
        if (leaving !== undefined) {
          await leaving.tab.page.close();
          closed.push(leaving);
        }
        await waitForPortHolder(participants.map((participant) => participant.tab));
        participants.push(await openParticipant(context, nextNumber));
        nextNumber += 1;
      }
    }
    for (const participant of participants) {
      await participant.tab.stopTraffic();
    }
    // What was on its way arrives, and what a closed owner left to its successor is written.
    await sleep(5_000);
    await sampleAll('end');

    // Every page still receives: a line from one of them reaches all of them.
    for (const participant of participants) {
      await participant.tab.clearReceived('Echo');
    }
    await participants[0]?.tab.send('Echo', 'STILL-SHARED-AT-THE-END');
    for (const participant of participants) {
      await participant.tab.waitForReceivedText('Echo', 'STILL-SHARED-AT-THE-END');
    }

    const records = participants.map((participant) => ({
      number: participant.number,
      samples: participant.samples,
    }));
    const failedSends: string[] = [];
    for (const participant of participants) {
      const counts = await participant.tab.trafficCounts('Echo');
      if (counts.failed > 0) {
        failedSends.push(
          `page ${String(participant.number)}: ${String(counts.failed)} of ${String(counts.sent)}`,
        );
      }
      expect(participant.tab.pageErrors, `page ${String(participant.number)}`).toEqual([]);
    }
    writeRecord({
      browserName,
      pages: PAGES,
      minutes: MINUTES,
      ownerCloseEveryS: OWNER_CLOSE_EVERY_S,
      closed: closed.length,
      records,
      worker: workerSamples,
      failedSends,
    });

    // The bound: for every page that was there at the start, what it holds at the end.
    for (const participant of participants) {
      const start = participant.samples.get('start');
      const end = participant.samples.get('end');
      if (start === undefined || end === undefined) {
        continue;
      }
      const page = `page ${String(participant.number)}`;
      expect(end.heapMiB, `${page} heap`).toBeLessThan(start.heapMiB + HEAP_GROWTH_BOUND_MIB);
      expect(end.nodes, `${page} nodes`).toBeLessThanOrEqual(start.nodes + NODE_GROWTH_BOUND);
      expect(end.listeners, `${page} listeners`).toBeLessThanOrEqual(
        start.listeners + LISTENER_GROWTH_BOUND,
      );
    }
    expect(
      participants.filter((participant) => participant.samples.has('start')).length,
    ).toBeGreaterThan(0);
    const workerStart = workerSamples.get('start');
    const workerEnd = workerSamples.get('end');
    if (workerStart !== undefined && workerEnd !== undefined) {
      expect(workerEnd.heapMiB, 'shared worker heap').toBeLessThan(
        workerStart.heapMiB + HEAP_GROWTH_BOUND_MIB,
      );
    }
  });
});

/** Writes the run's record next to this file, as the in-process suite writes its own. */
function writeRecord(run: {
  browserName: string;
  pages: number;
  minutes: number;
  ownerCloseEveryS: number;
  closed: number;
  records: readonly {
    number: number;
    samples: ReadonlyMap<'start' | 'middle' | 'end', MemorySample>;
  }[];
  worker: ReadonlyMap<'start' | 'middle' | 'end', WorkerMemorySample | undefined>;
  failedSends: readonly string[];
}): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const cpu = cpus()[0]?.model?.trim() ?? 'unknown CPU';
  const cell = (sample: MemorySample | undefined): string =>
    sample === undefined
      ? 'n/a'
      : `${String(sample.heapMiB)} / ${String(sample.nodes)} / ${String(sample.listeners)}`;
  const workerCell = (sample: WorkerMemorySample | undefined): string =>
    sample === undefined ? 'n/a' : `${String(sample.heapMiB)} / - / -`;
  const lines = [
    '# Extreme browser run: last run',
    '',
    'Written by `test/browser/extreme/sustained-load.spec.ts`; do not edit by hand. Each cell is',
    '**heap MiB / DOM nodes / event listeners**, read over CDP after a garbage collection.',
    '',
    `- **Run:** ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC on ${run.browserName} (channel ${process.env['SERIAL_BROKER_BROWSER_CHANNEL'] ?? 'msedge'}), ${cpu}`,
    `- **Load:** ${String(run.pages)} pages, ${String(run.minutes)} minutes, a line every ${String(SEND_EVERY_MS)} ms from every page, the page holding the port closed every ${String(run.ownerCloseEveryS)} s (${String(run.closed)} times) and replaced`,
    `- **Bounds:** heap +${String(HEAP_GROWTH_BOUND_MIB)} MiB, nodes +${String(NODE_GROWTH_BOUND)}, listeners +${String(LISTENER_GROWTH_BOUND)} from the first reading of a page to its last`,
    `- **Sends refused:** ${run.failedSends.length === 0 ? 'none' : run.failedSends.join('; ')}`,
    '',
    '| Page | Start | Middle | End |',
    '| --- | --- | --- | --- |',
    ...run.records.map(
      (record) =>
        `| ${String(record.number)} | ${cell(record.samples.get('start'))} | ${cell(record.samples.get('middle'))} | ${cell(record.samples.get('end'))} |`,
    ),
    `| SharedWorker | ${workerCell(run.worker.get('start'))} | ${workerCell(run.worker.get('middle'))} | ${workerCell(run.worker.get('end'))} |`,
    '',
    'A page numbered above the page count replaced one that was closed while holding the port; a',
    'page without a start reading was opened after the first reading was taken. The SharedWorker',
    'has heap only: it has no DOM, and CDP reports no listener count for a worker.',
    '',
  ];
  mkdirSync(here, { recursive: true });
  writeFileSync(join(here, 'RESULTS.md'), lines.join('\n'));
}
