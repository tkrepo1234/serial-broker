/**
 * What every benchmark scenario is expected to measure - written down before anything was measured.
 *
 * The expectation is what a result is judged against, so it is data here rather than a number in
 * a report: a result more than ten times worse than its expectation has to become a fix or a
 * documented limit (BACKLOG.md, "Performance"), and an expectation is never adjusted to a result.
 * The reasoning behind each number is in the comment next to it, so that a reader can disagree
 * with the reasoning rather than only with the number.
 *
 * Two sets, because two things are measured. The harness numbers are the library's own cost in
 * one Node process, with no browser and no device: microtasks, structured clones and validation,
 * with every delay simulated. The browser numbers include the platform - a real `SharedWorker`
 * hop, real `postMessage` cloning, real Web Locks and a real renderer crash - and are expected to
 * be an order of magnitude larger. See ADR-0037.
 */

/** Which way a metric is better. */
export type Direction = 'lower' | 'higher';

/** One expected value: the bound a measurement is judged against. */
export interface Expectation {
  /** The bound. A `lower` metric passes at or under it; a `higher` one at or over it. */
  readonly value: number;
  readonly better: Direction;
  readonly unit: string;
}

/** The scenarios, by identifier, and each one's metrics, by key. */
export type Expectations = Readonly<Record<string, Readonly<Record<string, Expectation>>>>;

const lowerMs = (value: number): Expectation => ({ value, better: 'lower', unit: 'ms' });
const higherBytesPerSecond = (value: number): Expectation => ({
  value,
  better: 'higher',
  unit: 'B/s',
});
const lowerKb = (value: number): Expectation => ({ value, better: 'lower', unit: 'KB' });
const exactly = (value: number, unit: string): Expectation => ({ value, better: 'lower', unit });

/**
 * The simulated browser: `test/harness/`, one process, both transports.
 *
 * A chunk from the device crosses the bus once per tab as a structured clone of a few hundred
 * bytes, is validated on arrival and dispatched to the listeners: tens of microseconds a hop. A
 * write from a tab that does not hold the port makes four such hops before its promise settles.
 * Nothing waits on a timer, so every handover and every start is expected to take no simulated
 * time at all.
 */
export const HARNESS_EXPECTATIONS: Expectations = {
  // One chunk of 255 bytes - the default read buffer - per delivery. A single tab on the
  // SharedWorker path is two clones and one validation; at 2 MB/s that is 125 µs per chunk.
  'device-to-tabs/1': {
    throughput: higherBytesPerSecond(2_000_000),
    latencyP50: lowerMs(0.1),
    latencyP95: lowerMs(0.3),
  },
  // Each extra tab is one more clone and one more validation on the worker's side of the hop.
  'device-to-tabs/5': {
    throughput: higherBytesPerSecond(1_000_000),
    latencyP50: lowerMs(0.3),
    latencyP95: lowerMs(0.6),
  },
  'device-to-tabs/10': {
    throughput: higherBytesPerSecond(500_000),
    latencyP50: lowerMs(0.5),
    latencyP95: lowerMs(1),
  },
  // The rate should not matter in the harness: the interval between writes is simulated time,
  // and the only difference between the rates is which of the library's own timers fall due
  // between two writes.
  'tabs-to-device/1-per-second': { latencyP50: lowerMs(0.3), latencyP95: lowerMs(1) },
  'tabs-to-device/10-per-second': { latencyP50: lowerMs(0.3), latencyP95: lowerMs(1) },
  'tabs-to-device/100-per-second': { latencyP50: lowerMs(0.3), latencyP95: lowerMs(1) },
  // A megabyte is cloned to the worker, to the tab holding the port, into 256 chunks of 4 KiB
  // for the device, and back to every tab as `data-sent`: a handful of megabyte copies, each
  // well under a millisecond, and 256 small writes.
  'tabs-to-device/1-mb-write': { wallP50: lowerMs(50) },
  // The browser frees the crashed tab's lock and grants it to the waiting tab, which opens the
  // port: promise chains, no timer.
  'handover/crash': {
    simulated: exactly(0, 'ms'),
    wallP50: lowerMs(2),
    wallP95: lowerMs(5),
  },
  // A release closes the port first, waits for the writes of the term, then lets the lock go:
  // more steps than a crash, still no timer.
  'handover/release': {
    simulated: exactly(0, 'ms'),
    wallP50: lowerMs(3),
    wallP95: lowerMs(6),
  },
  // `setup()` validates, restores from storage, joins the bus, requests the lock, lists the
  // granted ports and opens the matching one.
  'start/first-tab': {
    simulated: exactly(0, 'ms'),
    wallP50: lowerMs(2),
    wallP95: lowerMs(5),
  },
  // A joining tab asks the tab holding the port for its status and is told `open`.
  'start/joining-tab': {
    simulated: exactly(0, 'ms'),
    wallP50: lowerMs(2),
    wallP95: lowerMs(5),
  },
  // After an hour of one chunk and one write a second across three tabs, with the garbage
  // collected, the heap should be where it started, give or take what a collector leaves
  // behind; and every timer that is still scheduled should be one that was scheduled before -
  // the heartbeats, the sweep. The wall time is the harness's own cost and is reported so that
  // the two-minute budget of `npm run bench` stays visible.
  'steady-state/one-hour': {
    heapGrowth: lowerKb(512),
    timerGrowth: exactly(0, 'timers'),
    wall: lowerMs(15_000),
  },
};

/**
 * A real Chromium with the Web Serial stand-in: `bench/browser/`.
 *
 * Every hop is now a real `postMessage` between processes, a few hundred microseconds each, and
 * a handover after a crash waits for the browser to notice that a renderer is gone. The rates are
 * real time, so the write scenarios take as long as they say.
 */
export const BROWSER_EXPECTATIONS: Expectations = {
  // Two real hops per chunk - holder to worker, worker to tab - at a few hundred microseconds
  // each. The throughput is what the holder's read loop and the bus keep up with in a burst.
  'device-to-tabs/1': {
    throughput: higherBytesPerSecond(500_000),
    latencyP50: lowerMs(1),
    latencyP95: lowerMs(3),
  },
  'device-to-tabs/5': {
    throughput: higherBytesPerSecond(300_000),
    latencyP50: lowerMs(2),
    latencyP95: lowerMs(5),
  },
  'device-to-tabs/10': {
    throughput: higherBytesPerSecond(200_000),
    latencyP50: lowerMs(3),
    latencyP95: lowerMs(8),
  },
  // Four hops and a write to the stand-in, which answers at once.
  'tabs-to-device/1-per-second': { latencyP50: lowerMs(3), latencyP95: lowerMs(8) },
  'tabs-to-device/10-per-second': { latencyP50: lowerMs(3), latencyP95: lowerMs(8) },
  'tabs-to-device/100-per-second': { latencyP50: lowerMs(3), latencyP95: lowerMs(8) },
  // The megabyte crosses process boundaries three times and is echoed back in 255-byte pieces
  // by the stand-in, which is the expensive part: four thousand chunks fanned out to every tab.
  'tabs-to-device/1-mb-write': { wallP50: lowerMs(2_000) },
  // Chromium has to notice that the renderer is gone before it frees the lock.
  //
  // `wallP50`/`wallP95` time the first surviving page to report `open`, which is the page that
  // takes the port over. The other metrics were added on 2026-09-14, after the first run, because
  // that first page hides the rest of them: `everyTab` times the last surviving page to report
  // `open`, and `library` the first one against a plain Web Lock the crashed page held, granted
  // to a waiting page in the same crash - the platform's part taken out. Their values were not
  // taken from a result: `everyTab` is the bound written above for the same handover, since a page
  // that does not hold the port hears of the new holder one hop later; `library` is the bound
  // written for a release below, which reasoned from the same steps from a free lock to `open`.
  'handover/crash': {
    wallP50: lowerMs(250),
    wallP95: lowerMs(500),
    everyTabP50: lowerMs(250),
    everyTabP95: lowerMs(500),
    libraryP50: lowerMs(50),
    libraryP95: lowerMs(100),
  },
  'handover/release': {
    wallP50: lowerMs(50),
    wallP95: lowerMs(100),
    everyTabP50: lowerMs(50),
    everyTabP95: lowerMs(100),
  },
  'start/first-tab': { wallP50: lowerMs(50), wallP95: lowerMs(100) },
  'start/joining-tab': { wallP50: lowerMs(50), wallP95: lowerMs(100) },
  // An hour's worth of traffic, compressed into as many seconds as it takes, with the garbage
  // collected before and after through the DevTools protocol. A renderer's heap is coarser than
  // Node's - the measurement is per page, and `performance.memory` counts what V8 has mapped.
  'steady-state/one-hour': { heapGrowth: lowerKb(2_048) },
};
