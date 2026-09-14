/**
 * What the benchmark page offers the browser benchmark, as `window.bench`.
 *
 * Everything that has to be timed precisely is timed here, in the page, with `performance.now()`
 * - never across a `page.evaluate()` round trip, which costs more than most of what is measured.
 * Where a moment in one page has to be compared with a moment in another - a chunk pushed by the
 * device in the page holding the port, received in every other - both are stamped on the same
 * clock: `performance.timeOrigin + performance.now()`, the system clock at sub-millisecond
 * resolution, which the pages of one browser share.
 *
 * Served as JavaScript by `test/browser/server.mjs`, which strips the types (ADR-0035, ADR-0036).
 */

import type { SerialBrokerOptions } from '../../../src/core/types.js';
import type { SerialBrokerApi } from '../../../src/serial-broker.js';
import type { WebSerialStandInControl } from '../../../test/browser/stand-in/web-serial-stand-in.js';

/** Every chunk the device emits: a time stamp, then filler. The stand-in's default read buffer. */
export const CHUNK_BYTES = 255;

/** What the page has received of a configuration, and how long it took. */
export interface ReceiveStats {
  /** Whole chunks of {@link CHUNK_BYTES}, each carrying a stamp. */
  readonly chunks: number;
  readonly bytes: number;
  /** Milliseconds from the device pushing a chunk to `onReceive` here, one per chunk. */
  readonly latencies: readonly number[];
  /** When the last bytes arrived, on the shared clock; `undefined` before anything did. */
  readonly lastReceivedAt: number | undefined;
}

/** The page API the benchmark drives. */
export interface BenchPage {
  /**
   * Sets a configuration up and times it.
   *
   * @returns Milliseconds from the `setup()` call to the status `open`.
   */
  setup(name: string, options: SerialBrokerOptions): Promise<number>;
  status(name: string): string;
  /** When this page last saw the status become `open`, on the shared clock. */
  openedAt(name: string): number | undefined;
  /** Forgets the last `open` moment, so that the next one is the one measured. */
  resetOpenedAt(name: string): void;
  /**
   * Releases the configuration and says when, on the shared clock, the call was made.
   */
  release(name: string): Promise<number>;
  /**
   * Makes the device push `count` stamped chunks, `gapMs` apart; `0` is one burst.
   *
   * Works only in the page holding the port open (the stand-in's read stream is here).
   *
   * @returns When the first chunk was pushed, on the shared clock.
   */
  emitStamped(count: number, gapMs: number): Promise<number>;
  receiveStats(name: string): ReceiveStats;
  resetReceive(name: string): void;
  /**
   * Sends `count` short writes, `gapMs` apart, each timed from `send()` to its promise settling.
   */
  timedWrites(name: string, count: number, gapMs: number): Promise<number[]>;
  /** Sends one write of `byteLength` bytes and times it the same way. */
  timedWrite(name: string, byteLength: number): Promise<number>;
  /** `true` while this page holds the device open. */
  isPortOpenHere(): boolean;
  /** Uncaught errors and unhandled rejections so far; any of them fails the benchmark. */
  errors(): readonly string[];
}

/** The shared clock: the system time at the resolution of `performance.now()`. */
function sharedNow(): number {
  return performance.timeOrigin + performance.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface Collected {
  chunks: number;
  bytes: number;
  latencies: number[];
  lastReceivedAt: number | undefined;
  /** Bytes of a chunk that has not arrived whole yet. */
  partial: Uint8Array;
  openedAt: number | undefined;
}

/**
 * Installs the harness and applies the settings in the page's query string: `transport` forces a
 * transport, as the test pages do.
 */
export function installBenchHarness(api: SerialBrokerApi, standIn?: WebSerialStandInControl): void {
  const parameters = new URLSearchParams(location.search);
  const transport = parameters.get('transport');
  api.configure({
    ...(transport === 'auto' || transport === 'sharedworker' || transport === 'broadcastchannel'
      ? { transport }
      : {}),
  });

  const collected = new Map<string, Collected>();
  const errors: string[] = [];
  window.addEventListener('error', (event) => {
    errors.push(event.message);
  });
  window.addEventListener('unhandledrejection', (event) => {
    errors.push(String(event.reason));
  });

  function collect(name: string): Collected {
    let entry = collected.get(name);
    if (entry === undefined) {
      entry = {
        chunks: 0,
        bytes: 0,
        latencies: [],
        lastReceivedAt: undefined,
        partial: new Uint8Array(0),
        openedAt: undefined,
      };
      collected.set(name, entry);
    }
    return entry;
  }

  /** Takes every whole chunk out of what arrived, reading the stamp at the front of each. */
  function consume(entry: Collected, data: Uint8Array, arrivedAt: number): void {
    entry.bytes += data.byteLength;
    entry.lastReceivedAt = arrivedAt;
    let buffer = data;
    if (entry.partial.byteLength > 0) {
      buffer = new Uint8Array(entry.partial.byteLength + data.byteLength);
      buffer.set(entry.partial, 0);
      buffer.set(data, entry.partial.byteLength);
    }
    let offset = 0;
    while (buffer.byteLength - offset >= CHUNK_BYTES) {
      const stamp = new DataView(buffer.buffer, buffer.byteOffset + offset, 8).getFloat64(0);
      entry.chunks += 1;
      entry.latencies.push(arrivedAt - stamp);
      offset += CHUNK_BYTES;
    }
    entry.partial = buffer.slice(offset);
  }

  function stampedChunk(): Uint8Array {
    const chunk = new Uint8Array(CHUNK_BYTES);
    new DataView(chunk.buffer).setFloat64(0, sharedNow());
    for (let index = 8; index < CHUNK_BYTES; index += 1) {
      chunk[index] = index & 0xff;
    }
    return chunk;
  }

  async function timed(name: string, payload: string | Uint8Array<ArrayBuffer>): Promise<number> {
    const startedAt = performance.now();
    await api.send(name, payload);
    return performance.now() - startedAt;
  }

  const bench: BenchPage = {
    setup: async (name, options) => {
      const entry = collect(name);
      let opened: ((ms: number) => void) | undefined;
      const openWait = new Promise<number>((resolve) => {
        opened = resolve;
      });
      const startedAt = performance.now();
      await api.setup(name, options);
      api.subscribe(name, 'onStatusChange', (event) => {
        if (event.status === 'open') {
          entry.openedAt = sharedNow();
          opened?.(performance.now() - startedAt);
        }
      });
      api.subscribe(name, 'onReceive', (event) => {
        consume(entry, event.data, sharedNow());
      });
      if (api.getStatus(name).status === 'open') {
        entry.openedAt = sharedNow();
        return performance.now() - startedAt;
      }
      return await openWait;
    },
    status: (name) => api.getStatus(name).status,
    openedAt: (name) => collect(name).openedAt,
    resetOpenedAt: (name) => {
      collect(name).openedAt = undefined;
    },
    release: async (name) => {
      const calledAt = sharedNow();
      await api.release(name);
      return calledAt;
    },
    emitStamped: async (count, gapMs) => {
      if (standIn === undefined) {
        throw new Error('The benchmark page has no Web Serial stand-in');
      }
      const startedAt = sharedNow();
      for (let index = 0; index < count; index += 1) {
        if (!standIn.emit(stampedChunk())) {
          throw new Error('Only the page holding the port can make the device speak');
        }
        if (gapMs > 0) {
          await sleep(gapMs);
        }
      }
      return startedAt;
    },
    receiveStats: (name) => {
      const entry = collect(name);
      return {
        chunks: entry.chunks,
        bytes: entry.bytes,
        latencies: [...entry.latencies],
        lastReceivedAt: entry.lastReceivedAt,
      };
    },
    resetReceive: (name) => {
      const entry = collect(name);
      entry.chunks = 0;
      entry.bytes = 0;
      entry.latencies = [];
      entry.lastReceivedAt = undefined;
      entry.partial = new Uint8Array(0);
    },
    timedWrites: async (name, count, gapMs) => {
      const latencies: number[] = [];
      for (let index = 0; index < count; index += 1) {
        latencies.push(await timed(name, 'PING\r\n'));
        if (gapMs > 0) {
          await sleep(gapMs);
        }
      }
      return latencies;
    },
    timedWrite: async (name, byteLength) => {
      const payload = new Uint8Array(byteLength);
      for (let index = 0; index < byteLength; index += 1) {
        payload[index] = index & 0xff;
      }
      return await timed(name, payload);
    },
    isPortOpenHere: () => standIn?.isOpenHere() === true,
    errors: () => [...errors],
  };

  Object.defineProperty(window, 'bench', { configurable: true, value: bench });
}
