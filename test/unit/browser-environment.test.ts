import { afterEach, describe, expect, it, vi } from 'vitest';

import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import type { SerialBrokerError } from '../../src/core/errors.js';
import { createBrowserEnvironment, isSupported } from '../../src/environment/browser.js';
import type { ClientId } from '../../src/protocol/messages.js';
import { fieldsOfEvent, recordingLogger } from '../harness/recording-logger.js';
import { recordTransportRequest } from '../harness/transport-doubles.js';

/**
 * The composition root, which is the one file allowed to read a global.
 *
 * Everything here is about what happens in an unusual browser: no Web Serial, no
 * `SharedWorker`, a `localStorage` that throws on access. These are the paths that decide
 * whether a user sees a working feature or a broken page, and none of them can be reached
 * through the injected environment the rest of the suite uses.
 */

const globals = globalThis as Record<string, unknown>;

/** The `error` listeners registered on every stubbed `SharedWorker`, to fire a load failure. */
const workerErrorListeners: ((event: unknown) => void)[] = [];

function stubBrowser(
  overrides: {
    hasSerial?: boolean;
    hasLocks?: boolean;
    sharedWorker?: 'working' | 'throwing' | 'absent';
    broadcastChannel?: boolean;
    storage?: 'working' | 'throwing';
  } = {},
): void {
  const {
    hasSerial = true,
    hasLocks = true,
    sharedWorker = 'working',
    broadcastChannel = true,
    storage = 'working',
  } = overrides;

  const navigatorStub: Record<string, unknown> = {};
  if (hasSerial) {
    navigatorStub['serial'] = {
      getPorts: async () => [],
      requestPort: async () => ({}),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
  }
  if (hasLocks) {
    navigatorStub['locks'] = { request: async () => undefined };
  }
  vi.stubGlobal('navigator', navigatorStub);

  if (sharedWorker === 'absent') {
    vi.stubGlobal('SharedWorker', undefined);
  } else {
    vi.stubGlobal(
      'SharedWorker',
      class {
        port = {
          postMessage: () => undefined,
          start: () => undefined,
          close: () => undefined,
          addEventListener: () => undefined,
        };
        addEventListener = (type: string, listener: (event: unknown) => void): void => {
          if (type === 'error') {
            workerErrorListeners.push(listener);
          }
        };
        constructor() {
          if (sharedWorker === 'throwing') {
            throw new Error('Refused to create a worker: CSP');
          }
        }
      },
    );
  }

  vi.stubGlobal(
    'BroadcastChannel',
    broadcastChannel
      ? class {
          postMessage = (): void => undefined;
          close = (): void => undefined;
          addEventListener = (): void => undefined;
        }
      : undefined,
  );

  const entries = new Map<string, string>();
  vi.stubGlobal(
    'localStorage',
    storage === 'working'
      ? {
          getItem: (key: string) => entries.get(key) ?? null,
          setItem: (key: string, value: string) => entries.set(key, value),
          removeItem: (key: string) => entries.delete(key),
        }
      : {
          getItem: () => {
            throw new Error('denied');
          },
          setItem: () => {
            throw new Error('denied');
          },
          removeItem: () => {
            throw new Error('denied');
          },
        },
  );
}

/** Everything a transport needs. Most tests here only look at which transport was built. */
function transportRequest(): Parameters<
  ReturnType<typeof createBrowserEnvironment>['createTransport']
>[0] {
  return recordTransportRequest('c-1' as ClientId).request;
}

afterEach(() => {
  workerErrorListeners.length = 0;
  vi.unstubAllGlobals();
  delete globals['navigator'];
});

describe('isSupported', () => {
  it('is true when the platform has everything the library needs', () => {
    stubBrowser();

    expect(isSupported()).toBe(true);
  });

  it('is false without Web Serial', () => {
    stubBrowser({ hasSerial: false });

    expect(isSupported()).toBe(false);
  });

  it('is false without Web Locks', () => {
    stubBrowser({ hasLocks: false });

    expect(isSupported()).toBe(false);
  });

  it('is true with a SharedWorker and no BroadcastChannel', () => {
    stubBrowser({ broadcastChannel: false });

    // Only the version announcement and the fallback need the channel, and both are optional.
    expect(isSupported()).toBe(true);
  });

  it('is true with a BroadcastChannel and no SharedWorker', () => {
    stubBrowser({ sharedWorker: 'absent' });

    expect(isSupported()).toBe(true);
  });

  it('is false with neither SharedWorker nor BroadcastChannel', () => {
    stubBrowser({ sharedWorker: 'absent', broadcastChannel: false });

    expect(isSupported()).toBe(false);
  });

  it('is true only where a message bus can be built', () => {
    for (const sharedWorker of ['working', 'absent'] as const) {
      for (const broadcastChannel of [true, false]) {
        stubBrowser({ sharedWorker, broadcastChannel });
        const build = (): unknown =>
          createBrowserEnvironment({ workerUrl: 'https://example.test/w.js' }).createTransport(
            transportRequest(),
          );

        if (isSupported()) {
          expect(build).not.toThrow();
        } else {
          expect(build).toThrow(
            expect.objectContaining({ code: SerialBrokerErrorCode.TRANSPORT_UNAVAILABLE }),
          );
        }
        vi.unstubAllGlobals();
      }
    }
  });
});

describe('createBrowserEnvironment', () => {
  it('refuses to build without Web Serial, naming the reason', () => {
    stubBrowser({ hasSerial: false });

    try {
      createBrowserEnvironment();
      expect.unreachable();
    } catch (error) {
      expect((error as SerialBrokerError).code).toBe(SerialBrokerErrorCode.WEB_SERIAL_UNAVAILABLE);
      expect((error as SerialBrokerError).remediation).toContain('secure context');
    }
  });

  it('refuses to build without Web Locks', () => {
    stubBrowser({ hasLocks: false });

    expect(() => createBrowserEnvironment()).toThrow(
      expect.objectContaining({ code: SerialBrokerErrorCode.WEB_LOCKS_UNAVAILABLE }),
    );
  });

  it('prefers the SharedWorker transport', () => {
    stubBrowser();

    const transport = createBrowserEnvironment({
      workerUrl: 'https://example.test/w.js',
    }).createTransport(transportRequest());

    expect(transport.kind).toBe('sharedworker');
  });

  it('falls back to BroadcastChannel when SharedWorker is absent', () => {
    stubBrowser({ sharedWorker: 'absent' });

    // Chrome for Android has no SharedWorker but does have Web Serial. Failing there would
    // mean no device access at all, for a coordination detail the fallback handles (ADR-0007).
    expect(createBrowserEnvironment().createTransport(transportRequest()).kind).toBe(
      'broadcastchannel',
    );
  });

  it('falls back when constructing a SharedWorker throws', () => {
    stubBrowser({ sharedWorker: 'throwing' });

    // A strict script-src CSP produces exactly this.
    expect(createBrowserEnvironment().createTransport(transportRequest()).kind).toBe(
      'broadcastchannel',
    );
  });

  it('says in the log that it fell back because SharedWorker is absent', () => {
    stubBrowser({ sharedWorker: 'absent' });
    const { logger, records } = recordingLogger();

    createBrowserEnvironment().createTransport(
      recordTransportRequest('c-1' as ClientId, logger).request,
    );

    // The selection is automatic, and reported, whatever made it (ADR-0007) - in the tab's own log,
    // where the record carries the tab's clientId.
    expect(fieldsOfEvent(records, 'environment.transport-fallback')).toHaveLength(1);
  });

  it('refuses to fall back when SharedWorker was demanded and the platform has none', () => {
    stubBrowser({ sharedWorker: 'absent' });

    // `transport: 'sharedworker'` never uses the channel; it exists to make a missing worker loud.
    expect(() =>
      createBrowserEnvironment({ transport: 'sharedworker' }).createTransport(transportRequest()),
    ).toThrow(expect.objectContaining({ code: SerialBrokerErrorCode.BROKER_UNAVAILABLE }));
  });

  it('reports a failure instead of falling back when a transport was demanded', () => {
    stubBrowser({ sharedWorker: 'throwing' });

    expect(() =>
      createBrowserEnvironment({ transport: 'sharedworker' }).createTransport(transportRequest()),
    ).toThrow(expect.objectContaining({ code: SerialBrokerErrorCode.BROKER_UNAVAILABLE }));
  });

  it('uses BroadcastChannel when it is demanded', () => {
    stubBrowser();

    expect(
      createBrowserEnvironment({ transport: 'broadcastchannel' }).createTransport(
        transportRequest(),
      ).kind,
    ).toBe('broadcastchannel');
  });

  it('falls back when the worker script fails to load after construction', () => {
    stubBrowser();
    const transport = createBrowserEnvironment({
      workerUrl: 'https://example.test/missing.js',
    }).createTransport(transportRequest());
    expect(transport.kind).toBe('sharedworker');

    // A 404 does not make construction throw; the browser reports it afterwards.
    for (const listener of workerErrorListeners) {
      listener({ type: 'error' });
    }

    expect(transport.kind).toBe('broadcastchannel');
  });

  it('reports a worker script that fails to load when SharedWorker was demanded', () => {
    stubBrowser();
    const { request, transportErrors } = recordTransportRequest('c-1' as ClientId);
    const transport = createBrowserEnvironment({
      transport: 'sharedworker',
      workerUrl: 'https://example.test/missing.js',
    }).createTransport(request);

    for (const listener of workerErrorListeners) {
      listener({ type: 'error' });
    }

    expect(transport.kind).toBe('sharedworker');
    expect(transportErrors).toHaveLength(1);
  });

  it('reports that no transport is available when neither exists', () => {
    stubBrowser({ sharedWorker: 'absent', broadcastChannel: false });

    expect(() => createBrowserEnvironment().createTransport(transportRequest())).toThrow(
      expect.objectContaining({ code: SerialBrokerErrorCode.TRANSPORT_UNAVAILABLE }),
    );
  });

  it('degrades to in-memory storage rather than failing when localStorage throws', () => {
    stubBrowser({ storage: 'throwing' });

    const environment = createBrowserEnvironment();
    environment.storage.setItem('k', 'v');

    // A private window or a sandboxed iframe costs the application persistence, not the
    // device. Everything keeps working; only a reload forgets.
    expect(environment.storage.getItem('k')).toBe('v');
  });

  it('produces identifiers that do not repeat', () => {
    stubBrowser();
    const environment = createBrowserEnvironment();

    const ids = new Set([1, 2, 3, 4, 5].map(() => environment.newId('c')));

    expect(ids.size).toBe(5);
  });

  it('produces a clock that measures real time and cancels its timers', async () => {
    stubBrowser();
    const clock = createBrowserEnvironment().clock;

    expect(clock.now()).toBeGreaterThan(1_600_000_000_000);

    let fired = false;
    const handle = clock.setTimer(() => {
      fired = true;
    }, 1);
    clock.clearTimer(handle);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(fired).toBe(false);
  });

  it('produces jitter within the documented range', () => {
    stubBrowser();
    const environment = createBrowserEnvironment();

    for (let round = 0; round < 20; round += 1) {
      const value = environment.random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});
