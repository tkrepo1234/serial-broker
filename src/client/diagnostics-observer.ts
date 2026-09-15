import type { TimerHandle } from '../core/clock.js';
import type {
  DiagnosticsSnapshot,
  LockDiagnostics,
  ObservedEvent,
  ParticipantDiagnostics,
} from '../core/diagnostics.js';
import { SerialBrokerErrorCode } from '../core/error-codes.js';
import {
  deserializeError,
  describeUnknown,
  SerialBrokerError,
  withTimestamp,
} from '../core/errors.js';
import { OnceLog, type ScopedLogger } from '../core/logger.js';
import type { Unsubscribe } from '../core/types.js';
import { invalidArgument, validateName } from '../core/validation.js';
import type { LockInfoLike, SerialBrokerEnvironment } from '../environment/environment.js';
import { describeDecodeFailure } from '../protocol/decode.js';
import {
  MAX_REPORT_CHARACTERS,
  MAX_REPORT_CHARACTERS_PER_COLLECTION,
  MAX_REPORT_VALUES,
  MAX_REPORTS_PER_COLLECTION,
  structureCharacters,
  warnLimitExceeded,
} from '../protocol/limits.js';
import type { ClientId, ProtocolMessage, RequestId } from '../protocol/messages.js';
import { PROTOCOL_VERSION } from '../protocol/version.js';

import type { Transport } from './transport/transport.js';

/**
 * How long a collection waits for answers, in milliseconds, unless told otherwise.
 *
 * Nothing on the bus says how many contexts exist, so a collection cannot know when the last
 * one has answered; it listens for a fixed window instead. Half a second is several orders of
 * magnitude longer than a same-origin `postMessage` takes, and short enough to refresh a view by
 * hand.
 */
export const DEFAULT_COLLECT_WINDOW_MS = 500;

const LIMIT_EVENT = 'diagnostics.limit-exceeded';

/** Every lock this library takes carries this prefix. See `protocol/version.ts`. */
const LOCK_NAME_PREFIX = 'serial-broker/';

/** A collection that is still listening. */
interface Collection {
  readonly reports: ParticipantDiagnostics[];
  /** How many characters and bytes those reports hold, so the collection is bounded in both. */
  characters: number;
  readonly timer: TimerHandle;
  readonly finish: () => void;
}

/**
 * Looks at every context of an origin without taking part (ADR-0018).
 *
 * An observer joins the message bus under an identity of its own, but sets up no
 * configuration, requests no Web Lock and never answers for a port. It can therefore be opened
 * from any page of the origin - including a diagnostics page in a tab of its own - without
 * changing who owns what: closing every application tab still leaves the port with nobody,
 * rather than with the page that was only watching.
 *
 * It does two things. It **collects** a report from every context, which describes what
 * ADR-0011 keeps from the application: roles, the owner's connection, pending writes. And it
 * **watches** a configuration's traffic and ownership changes as they cross the bus.
 */
export class DiagnosticsObserver {
  readonly #environment: SerialBrokerEnvironment;
  readonly #clientId: ClientId;
  readonly #logger: ScopedLogger;
  readonly #transport: Transport;
  readonly #collections = new Map<RequestId, Collection>();
  /** Reports beyond what one collection keeps, logged once (ADR-0031). */
  readonly #once: OnceLog;
  readonly #watchers = new Map<string, Set<(event: ObservedEvent) => void>>();
  #isClosed = false;

  /**
   * Joins the bus.
   *
   * @param environment - The platform. Only its bus, clock, locks, identifiers and logger are
   *   used: an observer never touches Web Serial.
   */
  constructor(environment: SerialBrokerEnvironment) {
    this.#environment = environment;
    this.#clientId = environment.newId('d') as ClientId;
    this.#logger = environment.logger.child({ clientId: this.#clientId, role: 'observer' });
    this.#once = new OnceLog(this.#logger);
    this.#transport = environment.createTransport({
      clientId: this.#clientId,
      onMessage: (message) => {
        this.#handleMessage(message);
      },
      onDecodeFailure: (failure) => {
        this.#logger.warn('dropped a malformed message', {
          event: 'diagnostics.malformed-message',
          reason: describeDecodeFailure(failure),
        });
      },
      onTransportError: (error) => {
        this.#logger.warn('the message bus reported a failure', {
          event: 'diagnostics.transport-error',
          reason: describeUnknown(error),
        });
      },
      logger: this.#logger,
      clock: environment.clock,
      newSecret: () => environment.newSecret(),
    });
  }

  /** This observer's identity on the bus. */
  get clientId(): string {
    return this.#clientId;
  }

  /** Which message bus the observer is on. Contexts on the other one cannot be seen. */
  get transportKind(): 'sharedworker' | 'broadcastchannel' {
    return this.#transport.kind;
  }

  /**
   * Asks every context on the bus for a report, and lists this library's Web Locks.
   *
   * @param windowMs - How long to listen for answers. See {@link DEFAULT_COLLECT_WINDOW_MS}.
   * @returns Every report that arrived within the window. Resolves early, with what has
   *   arrived, if the observer is closed meanwhile.
   * @throws A {@link SerialBrokerError} with code `INVALID_ARGUMENT` for a window that is not a
   *   non-negative integer, or `CONFIGURATION_RELEASED` once the observer is closed.
   */
  async collect(windowMs: number = DEFAULT_COLLECT_WINDOW_MS): Promise<DiagnosticsSnapshot> {
    this.#assertOpen();
    if (!Number.isInteger(windowMs) || windowMs < 0) {
      throw withTimestamp(
        invalidArgument('windowMs', 'a non-negative integer', windowMs),
        this.#environment.clock.now(),
      );
    }

    const requestId = this.#environment.newId('diag') as RequestId;
    const reports: ParticipantDiagnostics[] = [];
    const windowClosed = new Promise<void>((resolve) => {
      const timer = this.#environment.clock.setTimer(() => {
        this.#finishCollection(requestId);
      }, windowMs);
      this.#collections.set(requestId, { reports, characters: 0, timer, finish: resolve });
    });

    this.#transport.send({
      type: 'diagnostics-request',
      v: PROTOCOL_VERSION,
      from: this.#clientId,
      to: 'all',
      requestId,
    });

    // Queried alongside the window, not before it: a browser slow to list its locks would otherwise
    // hold the collection past its window, and past `close()`. A list that has not arrived when the
    // window closes is reported as unavailable.
    const locksQueried = this.#queryLocks();
    await windowClosed;
    const locks = await Promise.race([locksQueried, Promise.resolve(undefined)]);

    return {
      collectedAt: this.#environment.clock.now(),
      observerClientId: this.#clientId,
      participants: reports,
      locks,
    };
  }

  /**
   * Streams a configuration's traffic, status changes, errors and ownership changes.
   *
   * Events are those that cross the bus, from whichever context produced them. The observer
   * joins the configuration's broadcasts to hear them, which is all it joins: it does not set
   * the configuration up and cannot be handed its port.
   *
   * @param configName - The configuration to watch. It need not be set up anywhere yet.
   * @param listener - Receives each event. An exception from it is logged, not rethrown.
   * @returns A function that stops this listener. Idempotent.
   * @throws A {@link SerialBrokerError} with code `INVALID_ARGUMENT` for an invalid name or a
   *   listener that is not a function, or `CONFIGURATION_RELEASED` once the observer is closed.
   */
  watch(configName: string, listener: (event: ObservedEvent) => void): Unsubscribe {
    this.#assertOpen();
    let name: string;
    try {
      name = validateName(configName, 'configName');
    } catch (error) {
      throw withTimestamp(error, this.#environment.clock.now());
    }
    if (typeof listener !== 'function') {
      throw withTimestamp(
        invalidArgument('listener', 'a function', listener, { configName: name }),
        this.#environment.clock.now(),
      );
    }

    let listeners = this.#watchers.get(name);
    if (listeners === undefined) {
      listeners = new Set();
      this.#watchers.set(name, listeners);
      this.#transport.attach(name);
    }
    listeners.add(listener);

    return () => {
      const current = this.#watchers.get(name);
      if (!current?.delete(listener)) {
        return;
      }
      if (current.size === 0) {
        this.#watchers.delete(name);
        if (!this.#isClosed) {
          this.#transport.detach(name);
        }
      }
    };
  }

  /** Leaves the bus. Collections still listening resolve with what they have. Idempotent. */
  close(): void {
    if (this.#isClosed) {
      return;
    }
    this.#isClosed = true;

    for (const requestId of [...this.#collections.keys()]) {
      this.#finishCollection(requestId);
    }
    this.#watchers.clear();
    this.#transport.close();
  }

  #handleMessage(message: ProtocolMessage): void {
    if (this.#isClosed) {
      return;
    }

    switch (message.type) {
      case 'diagnostics-report': {
        const collection = this.#collections.get(message.requestId);
        // A context answers once, but a bus is not obliged to deliver once; and an answer that
        // arrives after its window has closed belongs to nothing.
        if (
          collection === undefined ||
          collection.reports.some((report) => report.clientId === message.report.clientId)
        ) {
          return;
        }
        if (collection.reports.length >= MAX_REPORTS_PER_COLLECTION) {
          // Every report is kept until the window closes, and each may be a megabyte
          // (`MAX_REPORT_CHARACTERS`). A request id is broadcast, so anything on the bus can
          // answer one - as many times as it invents client ids (ADR-0031).
          warnLimitExceeded(this.#once, LIMIT_EVENT, 'MAX_REPORTS_PER_COLLECTION', {
            requestId: message.requestId,
          });
          return;
        }
        // Bounded in what the reports hold as well as in how many there are: the count alone would
        // leave a collection a gigabyte of invented reports (ADR-0031).
        const characters = structureCharacters(message.report, {
          values: MAX_REPORT_VALUES,
          characters: MAX_REPORT_CHARACTERS,
        });
        if (collection.characters + characters > MAX_REPORT_CHARACTERS_PER_COLLECTION) {
          warnLimitExceeded(this.#once, LIMIT_EVENT, 'MAX_REPORT_CHARACTERS_PER_COLLECTION', {
            requestId: message.requestId,
          });
          return;
        }
        collection.characters += characters;
        collection.reports.push(message.report);
        return;
      }

      case 'data-received':
        this.#emit(message.configName, {
          kind: 'received',
          configName: message.configName,
          from: message.from,
          timestamp: message.timestamp,
          data: message.payload,
          text: message.text,
        });
        return;

      case 'data-sent':
        this.#emit(message.configName, {
          kind: 'sent',
          configName: message.configName,
          from: message.from,
          timestamp: message.timestamp,
          data: message.payload,
          originClientId: message.originClientId,
        });
        return;

      case 'status':
        this.#emit(message.configName, {
          kind: 'status',
          configName: message.configName,
          from: message.from,
          timestamp: message.timestamp,
          status: message.status,
        });
        return;

      case 'error':
        this.#emit(message.configName, {
          kind: 'error',
          configName: message.configName,
          from: message.from,
          timestamp: message.timestamp,
          error: deserializeError(message.error),
        });
        return;

      case 'owner-claimed':
      case 'owner-released':
        this.#emit(message.configName, {
          kind: message.type,
          configName: message.configName,
          from: message.from,
          timestamp: this.#environment.clock.now(),
        });
        return;

      default:
        // Write requests and results pass between participants and say nothing an operator
        // needs that the `sent` event does not; presence messages say nothing at all.
        return;
    }
  }

  /** Delivers an event to the watchers of its configuration, or to all of them if it has none. */
  #emit(configName: string | undefined, event: ObservedEvent): void {
    const targets =
      configName === undefined
        ? [...this.#watchers.values()].flatMap((listeners) => [...listeners])
        : [...(this.#watchers.get(configName) ?? [])];

    for (const listener of targets) {
      // A watcher stopped earlier in this delivery - by another watcher, or by `close()` - has been
      // told it hears nothing more, as a configuration's own listeners are (`core/emitter.ts`).
      if (!this.#isWatching(configName, listener)) {
        continue;
      }
      try {
        listener(event);
      } catch (error) {
        // A listener runs inside a `postMessage` handler, which must never throw. There is no
        // application `onError` here to report it to; the log is the channel.
        this.#logger.warn('a diagnostics listener threw', {
          event: 'diagnostics.listener-threw',
          reason: describeUnknown(error),
        });
      }
    }
  }

  /** `true` while `listener` watches `configName`, or any configuration when there is no name. */
  #isWatching(configName: string | undefined, listener: (event: ObservedEvent) => void): boolean {
    if (configName !== undefined) {
      return this.#watchers.get(configName)?.has(listener) === true;
    }
    return [...this.#watchers.values()].some((listeners) => listeners.has(listener));
  }

  async #queryLocks(): Promise<DiagnosticsSnapshot['locks']> {
    const locks = this.#environment.locks;
    if (locks.query === undefined) {
      return undefined;
    }
    try {
      const snapshot = await locks.query();
      return { held: ownLocks(snapshot.held), pending: ownLocks(snapshot.pending) };
    } catch (error) {
      this.#logger.warn('could not list the Web Locks', {
        event: 'diagnostics.locks-unavailable',
        reason: describeUnknown(error),
      });
      return undefined;
    }
  }

  #finishCollection(requestId: RequestId): void {
    const collection = this.#collections.get(requestId);
    if (collection === undefined) {
      return;
    }
    this.#collections.delete(requestId);
    this.#environment.clock.clearTimer(collection.timer);
    collection.finish();
  }

  #assertOpen(): void {
    if (this.#isClosed) {
      throw new SerialBrokerError(
        SerialBrokerErrorCode.CONFIGURATION_RELEASED,
        'This diagnostics observer has been closed',
        { timestamp: this.#environment.clock.now() },
      );
    }
  }
}

/** Keeps only this library's locks, in the report's shape. */
function ownLocks(entries: readonly LockInfoLike[] | undefined): LockDiagnostics[] {
  const own: LockDiagnostics[] = [];
  for (const entry of entries ?? []) {
    if (entry.name?.startsWith(LOCK_NAME_PREFIX) === true) {
      own.push({
        name: entry.name,
        mode: entry.mode ?? 'exclusive',
        browserClientId: entry.clientId,
      });
    }
  }
  return own;
}
