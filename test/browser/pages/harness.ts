/**
 * What a test page offers a browser test, as `window.harness`.
 *
 * The specs drive the library through this rather than through `page.evaluate()` of library
 * calls: the page imports the built package with a static `import`, so nothing depends on a
 * dynamic `import()` inside an evaluation, and the page keeps the event history that the
 * assertions are made of - events that arrive between two evaluations would otherwise be gone.
 *
 * Served as JavaScript by `test/browser/server.mjs`, which strips the types; it is TypeScript so
 * that it is type-checked against the library's public surface like the rest of the suite.
 *
 * See ADR-0035.
 */

import type { LogLevel, SerialBrokerOptions } from '../../../src/core/types.js';
import type { SerialBrokerApi } from '../../../src/serial-broker.js';
import type { WebSerialStandInControl } from '../stand-in/web-serial-stand-in.js';

/** One `onSend` event, reduced to what a test asserts on. */
export interface HarnessSend {
  readonly origin: string;
  readonly byteLength: number;
}

/** One log record the library emitted. */
export interface HarnessLogRecord {
  readonly level: LogLevel;
  readonly event: string;
  readonly message: string;
  /** The record's fields, reduced to what survives being handed to the test runner. */
  readonly fields: Record<string, unknown>;
}

/** The page API the specs drive. */
export interface PageHarness {
  setup(name: string, options: SerialBrokerOptions): Promise<void>;
  release(name: string, forgetDevice?: boolean): Promise<void>;
  dispose(): Promise<void>;
  requestAccess(name: string): Promise<boolean>;
  /**
   * Points the page's "Choose device" button at a configuration.
   *
   * The port picker needs transient activation, which `page.evaluate()` does not have and
   * `page.click()` does, so that path runs through the button rather than through
   * {@link PageHarness.requestAccess}.
   */
  armAccessRequest(name: string): void;
  /** How the last click on that button ended: `granted`, `dismissed` or `error:<code>`. */
  lastAccessRequest(): string | undefined;
  send(name: string, text: string): Promise<void>;
  /**
   * Starts a send without waiting for it, for a scenario that has to act while it is in flight.
   *
   * @returns A handle for {@link PageHarness.sendOutcome}.
   */
  startSend(name: string, text: string): number;
  /** How a send from {@link PageHarness.startSend} ended: `pending`, `sent` or `error:<code>`. */
  sendOutcome(handle: number): string;
  /**
   * Sends `byteLength` bytes of the pattern {@link patternByteAt}, and starts looking for it in
   * what arrives.
   *
   * `seed` picks the sequence. A run gives its own seed where anything else may be on the line -
   * a real device still echoing an earlier payload, for instance - so that only this payload can
   * satisfy {@link PageHarness.receivedPatternLength}.
   */
  sendPattern(name: string, byteLength: number, seed?: number): Promise<void>;
  status(name: string): string;
  /** Every status this page has seen for the configuration, in order. */
  statuses(name: string): readonly string[];
  /** The text received, concatenated. Needs `encoding.decodeText`. */
  receivedText(name: string): string;
  receivedByteCount(name: string): number;
  /** How many `onReceive` events arrived. */
  receiveEventCount(name: string): number;
  /**
   * The longest unbroken run of the pattern that has arrived, in bytes.
   *
   * A run, not a prefix: the stream may begin with anything, and does when a device is still
   * saying something of its own.
   */
  receivedPatternLength(name: string): number;
  sends(name: string): readonly HarnessSend[];
  /** Forgets what was received so far, so that what a device said while settling is not asserted on. */
  clearReceived(name: string): void;
  /**
   * Whether this page is the one holding the port.
   *
   * The one place in the suite that looks at the coordination mechanism rather than at the
   * device: with real hardware there is no stand-in to ask which page has the port open, and
   * `navigator.locks.query()` is how the manual test plan establishes it too. The page compares
   * the holder of the library's owner lock with a lock of its own, because a client id means
   * nothing on its own.
   */
  holdsOwnerLock(name: string): Promise<boolean>;
  /** The codes of every error reported to this page, in order. */
  errorCodes(): readonly string[];
  /** The `event` field of every log record, in order. */
  logEvents(): readonly string[];
  logRecords(): readonly HarnessLogRecord[];
  /** `true` while this page holds the device open. Only with the Web Serial stand-in. */
  isPortOpenHere(): boolean;
  protocolVersion(): number;
  /**
   * Sends `line` every `everyMs` milliseconds until {@link PageHarness.stopTraffic}, from a timer
   * in the page, so that a long run costs the test runner nothing per write. Each send is counted
   * in {@link PageHarness.trafficCounts}; a send that fails is counted, not thrown.
   */
  startTraffic(name: string, everyMs: number, line: string): void;
  stopTraffic(): void;
  /** Sends issued by {@link PageHarness.startTraffic}, and how many of them were refused. */
  trafficCounts(name: string): { readonly sent: number; readonly failed: number };
  /**
   * Forgets everything collected so far for the configuration - text, counts, statuses, sends -
   * and every log record, so that a page's memory over a long run is the library's, not this
   * harness's.
   */
  resetHistory(name: string): void;
}

/**
 * The byte at `index` of the pattern the large-payload tests send.
 *
 * A hash of the index rather than a counter, and seeded: two runs with different seeds share no
 * long run of bytes, so a payload cannot be confused with what was on the line before it. A
 * counter would fail at exactly that - every stretch of a counter matches every other one.
 */
export function patternByteAt(index: number, seed: number): number {
  let value = Math.imul(index + 1, 2_654_435_761) + Math.imul(seed + 1, 40_503);
  value ^= value >>> 15;
  value = Math.imul(value, 2_246_822_519);
  value ^= value >>> 13;
  return (value >>> 0) % 256;
}

interface Collected {
  statuses: string[];
  text: string;
  byteCount: number;
  receiveEvents: number;
  patternSeed: number;
  patternRun: number;
  patternLongestRun: number;
  sends: HarnessSend[];
}

/**
 * Installs the harness and applies the settings in the page's query string.
 *
 * - `transport=broadcastchannel|sharedworker|auto` - forces a transport.
 * - `workerUrl=<url>` - where the broker script is served from.
 *
 * Called while the page is loading, so that `configure()` runs before anything builds a client.
 */
export function installHarness(
  api: SerialBrokerApi,
  protocolVersion: number,
  standIn?: WebSerialStandInControl,
): void {
  const parameters = new URLSearchParams(location.search);
  const records: HarnessLogRecord[] = [];
  const errorCodes: string[] = [];
  const sendOutcomes: string[] = [];
  const collected = new Map<string, Collected>();
  const traffic = new Map<string, { sent: number; failed: number }>();
  let trafficTimer: ReturnType<typeof setInterval> | undefined;
  let accessRequestName = '';
  let lastAccessRequest: string | undefined;

  const transport = parameters.get('transport');
  const workerUrl = parameters.get('workerUrl');
  api.configure({
    ...(transport === 'auto' || transport === 'sharedworker' || transport === 'broadcastchannel'
      ? { transport }
      : {}),
    ...(workerUrl === null ? {} : { workerUrl }),
    logger: {
      log: (level, message, fields) => {
        const event = fields.event;
        let plainFields: Record<string, unknown> = {};
        try {
          // A record may carry anything an error brought with it; only what crosses the bridge
          // to the test runner is kept.
          plainFields = JSON.parse(JSON.stringify(fields)) as Record<string, unknown>;
        } catch {
          // A field that cannot be serialised leaves the record without fields rather than
          // without the record.
        }
        records.push({
          level,
          message,
          event: typeof event === 'string' ? event : '',
          fields: plainFields,
        });
      },
    },
  });

  function collect(name: string): Collected {
    let entry = collected.get(name);
    if (entry === undefined) {
      entry = {
        statuses: [],
        text: '',
        byteCount: 0,
        receiveEvents: 0,
        patternSeed: 0,
        patternRun: 0,
        patternLongestRun: 0,
        sends: [],
      };
      collected.set(name, entry);
    }
    return entry;
  }

  const harness: PageHarness = {
    setup: async (name, options) => {
      const entry = collect(name);
      await api.setup(name, options);

      api.subscribe(name, 'onStatusChange', (event) => {
        // The current status a new listener is told once is already the first entry below.
        if (event.previousStatus === event.status) {
          return;
        }
        entry.statuses.push(event.status);
      });
      api.subscribe(name, 'onReceive', (event) => {
        entry.text += event.text ?? '';
        for (const byte of event.data) {
          // A run that breaks starts again where it can: the byte that broke it may itself be
          // the first byte of the payload.
          if (byte === patternByteAt(entry.patternRun, entry.patternSeed)) {
            entry.patternRun += 1;
          } else {
            entry.patternRun = byte === patternByteAt(0, entry.patternSeed) ? 1 : 0;
          }
          entry.patternLongestRun = Math.max(entry.patternLongestRun, entry.patternRun);
        }
        entry.byteCount += event.data.byteLength;
        entry.receiveEvents += 1;
      });
      api.subscribe(name, 'onSend', (event) => {
        entry.sends.push({ origin: event.origin, byteLength: event.data.byteLength });
      });
      api.subscribe(name, 'onError', (event) => {
        errorCodes.push(event.error.code);
      });

      entry.statuses.push(api.getStatus(name).status);
    },
    release: async (name, forgetDevice) => {
      await api.release(name, { forgetDevice: forgetDevice ?? false });
    },
    dispose: async () => {
      await api.dispose();
    },
    requestAccess: async (name) => {
      return await api.requestAccess(name);
    },
    armAccessRequest: (name) => {
      accessRequestName = name;
      lastAccessRequest = undefined;
    },
    lastAccessRequest: () => lastAccessRequest,
    send: async (name, text) => {
      await api.send(name, text);
    },
    startSend: (name, text) => {
      const handle = sendOutcomes.push('pending') - 1;
      void api.send(name, text).then(
        () => {
          sendOutcomes[handle] = 'sent';
        },
        (error: unknown) => {
          const code = (error as { code?: unknown }).code;
          sendOutcomes[handle] = `error:${typeof code === 'string' ? code : String(error)}`;
        },
      );
      return handle;
    },
    sendOutcome: (handle) => sendOutcomes[handle] ?? 'unknown',
    sendPattern: async (name, byteLength, seed) => {
      const entry = collect(name);
      entry.patternSeed = seed ?? 0;
      entry.patternRun = 0;
      entry.patternLongestRun = 0;

      const payload = new Uint8Array(byteLength);
      for (let index = 0; index < byteLength; index += 1) {
        payload[index] = patternByteAt(index, entry.patternSeed);
      }
      await api.send(name, payload);
    },
    status: (name) => api.getStatus(name).status,
    statuses: (name) => [...collect(name).statuses],
    receivedText: (name) => collect(name).text,
    receivedByteCount: (name) => collect(name).byteCount,
    receiveEventCount: (name) => collect(name).receiveEvents,
    receivedPatternLength: (name) => collect(name).patternLongestRun,
    sends: (name) => [...collect(name).sends],
    clearReceived: (name) => {
      const entry = collect(name);
      entry.text = '';
      entry.byteCount = 0;
      entry.receiveEvents = 0;
      entry.patternRun = 0;
      entry.patternLongestRun = 0;
    },
    holdsOwnerLock: async (name) => {
      const probeName = `harness/probe/${name}`;
      return await navigator.locks.request(probeName, async () => {
        const snapshot = await navigator.locks.query();
        const held = snapshot.held ?? [];
        const mine = held.find((lock) => lock.name === probeName)?.clientId;
        const owner = held.find(
          (lock) =>
            lock.name?.startsWith('serial-broker/owner/') === true &&
            lock.name.endsWith(`/${name}`),
        )?.clientId;
        return mine !== undefined && mine === owner;
      });
    },
    errorCodes: () => [...errorCodes],
    logEvents: () => records.map((record) => record.event),
    logRecords: () => [...records],
    isPortOpenHere: () => standIn?.isOpenHere() === true,
    protocolVersion: () => protocolVersion,
    startTraffic: (name, everyMs, line) => {
      if (trafficTimer !== undefined) {
        clearInterval(trafficTimer);
      }
      const counts = traffic.get(name) ?? { sent: 0, failed: 0 };
      traffic.set(name, counts);
      trafficTimer = setInterval(() => {
        counts.sent += 1;
        api.send(name, line).catch(() => {
          counts.failed += 1;
        });
      }, everyMs);
    },
    stopTraffic: () => {
      if (trafficTimer !== undefined) {
        clearInterval(trafficTimer);
        trafficTimer = undefined;
      }
    },
    trafficCounts: (name) => ({ ...(traffic.get(name) ?? { sent: 0, failed: 0 }) }),
    resetHistory: (name) => {
      const entry = collect(name);
      entry.statuses.length = 0;
      entry.text = '';
      entry.byteCount = 0;
      entry.receiveEvents = 0;
      entry.patternRun = 0;
      entry.patternLongestRun = 0;
      entry.sends.length = 0;
      records.length = 0;
    },
  };

  // Called synchronously from the click, so that the gesture is not spent before the picker is
  // asked for - the mistake the library's USER_GESTURE_REQUIRED exists for.
  document.querySelector('#request-access')?.addEventListener('click', () => {
    void api.requestAccess(accessRequestName).then(
      (granted) => {
        lastAccessRequest = granted ? 'granted' : 'dismissed';
      },
      (error: unknown) => {
        const code = (error as { code?: unknown }).code;
        lastAccessRequest = `error:${typeof code === 'string' ? code : String(error)}`;
      },
    );
  });

  Object.defineProperty(window, 'harness', { configurable: true, value: harness });
}
