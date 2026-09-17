import { BroadcastChannelTransport } from '../client/transport/broadcast-channel-transport.js';
import { FallbackTransport } from '../client/transport/fallback-transport.js';
import {
  SharedWorkerTransport,
  type SharedWorkerFactory,
} from '../client/transport/shared-worker-transport.js';
import type { Transport, TransportRequest } from '../client/transport/transport.js';
import type { Clock } from '../core/clock.js';
import { SerialBrokerErrorCode } from '../core/error-codes.js';
import { describeUnknown, SerialBrokerError } from '../core/errors.js';
import { NOOP_LOGGER, ScopedLogger } from '../core/logger.js';
import type { Logger, TransportKind } from '../core/types.js';

import type {
  KeyValueStorage,
  LockManagerLike,
  SerialLike,
  SerialBrokerEnvironment,
} from './environment.js';

/** Settings the application can influence. */
export interface BrowserEnvironmentOptions {
  /** {@inheritDoc SerialBrokerGlobalOptions.workerUrl} */
  readonly workerUrl?: string | URL | undefined;
  /** Forces a transport instead of selecting one automatically. @defaultValue 'auto' */
  readonly transport?: TransportKind | undefined;
  /** Receives diagnostics. Nothing is logged unless one is supplied. */
  readonly logger?: Logger | undefined;
  /** {@inheritDoc SerialBrokerGlobalOptions.logPayloads} */
  readonly logPayloads?: boolean | undefined;
}

/**
 * `true` if this context has everything the library needs: Web Serial, Web Locks and a message bus.
 *
 * Browsers offer Web Serial and Web Locks only in a secure context, so their presence is the check
 * for one. Either bus is enough: `setup()` works on a `SharedWorker` alone, and a `BroadcastChannel`
 * is otherwise needed only for the version announcement and the fallback, both of which a tab does
 * without (ADR-0006, ADR-0008). Where neither exists, `setup()` raises `TRANSPORT_UNAVAILABLE`.
 *
 * Nothing is constructed, so the answer is for the default `transport: 'auto'` and a worker the
 * browser lets the page create; see `TRANSPORT_UNAVAILABLE` and `BROKER_UNAVAILABLE` in
 * docs/site/errors.md.
 */
export function isSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serial' in navigator &&
    'locks' in navigator &&
    !hasOpaqueOrigin() &&
    (typeof SharedWorker !== 'undefined' || typeof BroadcastChannel !== 'undefined')
  );
}

/**
 * `true` in a context whose origin is opaque: a sandboxed iframe without `allow-same-origin`, for
 * one. `navigator.locks` exists there, but rejects every request with a `SecurityError`, so no tab
 * could ever hold the port, and the status would stay `idle` with nothing said.
 */
function hasOpaqueOrigin(): boolean {
  return (globalThis as { readonly origin?: unknown }).origin === 'null';
}

/**
 * Builds the environment from the real platform.
 *
 * The only place in the library that reads a global. Everything it produces is an ordinary
 * object that a test can replace wholesale.
 */
export function createBrowserEnvironment(
  options: BrowserEnvironmentOptions = {},
): SerialBrokerEnvironment {
  const logger = new ScopedLogger(options.logger ?? NOOP_LOGGER, {});

  return {
    serial: requireSerial(),
    locks: requireLocks(),
    storage: createStorage(),
    createTransport: (request) => createTransport(request, options),
    createBroadcastChannel:
      typeof BroadcastChannel === 'undefined' ? undefined : (name) => new BroadcastChannel(name),
    clock: BROWSER_CLOCK,
    random: () => Math.random(),
    newId: createIdGenerator(),
    logger,
    logPayloads: options.logPayloads ?? false,
  };
}

/**
 * The platform's clock. Exported for the facade, which checks arguments before any environment
 * exists and must still give the errors it throws the time they arose.
 */
export const BROWSER_CLOCK: Clock = {
  now: () => Date.now(),
  // `performance.now()` rather than `Date.now()`: it counts on regardless of the system clock, so a
  // duration measured with it cannot be turned into a negative or an hour-long one by a time zone
  // change or an NTP step (ADR-0014). It exists in every context this library runs in - a window, a
  // worker - and needs no permission.
  monotonicNow: () => performance.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (handle) => {
    clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
  },
};

function requireSerial(): SerialLike {
  if (typeof navigator === 'undefined' || !('serial' in navigator)) {
    throw new SerialBrokerError(
      SerialBrokerErrorCode.WEB_SERIAL_UNAVAILABLE,
      'This context does not expose navigator.serial',
      { context: { hasNavigator: typeof navigator !== 'undefined' }, timestamp: Date.now() },
    );
  }
  return navigator.serial;
}

function requireLocks(): LockManagerLike {
  if (typeof navigator === 'undefined' || !('locks' in navigator)) {
    throw new SerialBrokerError(
      SerialBrokerErrorCode.WEB_LOCKS_UNAVAILABLE,
      'This context does not expose navigator.locks',
      { timestamp: Date.now() },
    );
  }
  if (hasOpaqueOrigin()) {
    throw new SerialBrokerError(
      SerialBrokerErrorCode.WEB_LOCKS_UNAVAILABLE,
      'This context has an opaque origin, such as a sandboxed iframe without allow-same-origin, where navigator.locks refuses every request',
      { context: { opaqueOrigin: true }, timestamp: Date.now() },
    );
  }
  return navigator.locks;
}

/**
 * Wraps `localStorage` so that a context where it is unavailable still works.
 *
 * Accessing `localStorage` throws outright in a sandboxed iframe and in some privacy
 * configurations - not on use, but on the property access itself. Everything here therefore
 * degrades to an in-memory store: configurations last as long as the page, and nothing is
 * reported, because nothing the application could do would change it (docs/site/errors.md).
 */
function createStorage(): KeyValueStorage {
  try {
    const probe = globalThis.localStorage;
    // Reading is not enough: some configurations allow the access and refuse the write.
    const probeKey = 'serial-broker/probe';
    probe.setItem(probeKey, '1');
    probe.removeItem(probeKey);
    return probe;
  } catch {
    const memory = new Map<string, string>();
    return {
      getItem: (key) => memory.get(key) ?? null,
      setItem: (key, value) => {
        memory.set(key, value);
      },
      removeItem: (key) => {
        memory.delete(key);
      },
    };
  }
}

/**
 * Chooses and constructs the message bus.
 *
 * `SharedWorker` first, because point-to-point routing is cheaper (ADR-0006). `BroadcastChannel`
 * when it is unavailable, when its construction throws, or when its script fails to load -
 * realistic outcomes of an enterprise policy, a strict CSP, an unusual bundler setup, or a worker
 * file that was not deployed (ADR-0006). Every such switch is logged. `transport: 'sharedworker'`
 * never switches: it exists to make a missing worker loud.
 *
 * Logged through the tab's own logger, as the switch after a failed script load is
 * (`FallbackTransport`), so the record carries the tab's `clientId` like every other.
 */
function createTransport(request: TransportRequest, options: BrowserEnvironmentOptions): Transport {
  const preference = options.transport ?? 'auto';

  if (preference !== 'broadcastchannel' && typeof SharedWorker === 'undefined') {
    if (preference === 'sharedworker') {
      throw new SerialBrokerError(
        SerialBrokerErrorCode.BROKER_UNAVAILABLE,
        'The SharedWorker transport was requested, but this context has no SharedWorker',
        { timestamp: Date.now() },
      );
    }
    if (typeof BroadcastChannel !== 'undefined') {
      request.logger.warn('SharedWorker unavailable; falling back to BroadcastChannel', {
        event: 'environment.transport-fallback',
        reason: 'this context has no SharedWorker',
      });
    }
  }

  if (preference !== 'broadcastchannel' && typeof SharedWorker !== 'undefined') {
    try {
      const url = options.workerUrl ?? defaultWorkerUrl();
      // The one place where the platform's `SharedWorker` meets the narrowed interface the
      // transport works against.
      const createWorker: SharedWorkerFactory = (scriptUrl, name) =>
        new SharedWorker(scriptUrl, { name, type: 'module' });

      if (preference === 'sharedworker' || typeof BroadcastChannel === 'undefined') {
        return new SharedWorkerTransport(request, createWorker, url);
      }

      // A script that cannot be fetched does not make construction throw: the browser creates
      // the worker and reports the failure afterwards. A transport that can still switch then
      // keeps such a tab connected to the others (ADR-0006).
      return new FallbackTransport(
        request,
        (workerRequest, startup) =>
          new SharedWorkerTransport(workerRequest, createWorker, url, startup),
        (fallbackRequest) =>
          new BroadcastChannelTransport(fallbackRequest, (name) => new BroadcastChannel(name)),
      );
    } catch (error) {
      if (preference === 'sharedworker') {
        throw new SerialBrokerError(
          SerialBrokerErrorCode.BROKER_UNAVAILABLE,
          'The SharedWorker transport was requested but could not be constructed',
          { cause: error, timestamp: Date.now() },
        );
      }
      request.logger.warn('SharedWorker unavailable; falling back to BroadcastChannel', {
        event: 'environment.transport-fallback',
        reason: describeUnknown(error),
      });
    }
  }

  if (typeof BroadcastChannel === 'undefined') {
    throw new SerialBrokerError(
      SerialBrokerErrorCode.TRANSPORT_UNAVAILABLE,
      'Neither SharedWorker nor BroadcastChannel is available in this context',
      { timestamp: Date.now() },
    );
  }

  return new BroadcastChannelTransport(request, (name) => new BroadcastChannel(name));
}

/**
 * Resolves the broker script next to this module.
 *
 * A `Blob` URL cannot be used here: `SharedWorker` identity is its script URL, so each tab
 * would create a *different* worker and nothing would be shared. See ADR-0006.
 */
function defaultWorkerUrl(): URL {
  return new URL('./serial-broker.worker.js', import.meta.url);
}

/**
 * Produces identifiers that are unique within this context.
 *
 * `crypto.randomUUID` where available, a counter plus a random suffix otherwise - these are
 * routing labels, not secrets, and uniqueness across a handful of tabs is all that is needed.
 */
function createIdGenerator(): (prefix: string) => string {
  let counter = 0;

  return (prefix) => {
    counter += 1;

    const unique =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

    return `${prefix}-${String(counter)}-${unique}`;
  };
}
