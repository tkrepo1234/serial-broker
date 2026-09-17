import type { TimerHandle } from '../../core/clock.js';
import { DisposalStack } from '../../core/disposable.js';
import { describeUnknown } from '../../core/errors.js';
import { HeldLock } from '../../core/held-lock.js';
import { OnceLog } from '../../core/logger.js';
import { decodeMessage } from '../../protocol/decode.js';
import { HANDSHAKE_DEADLINE_MS } from '../../protocol/handshake.js';
import { warnLimitExceeded } from '../../protocol/limits.js';
import {
  BROKER_ID,
  type ProtocolMessage,
  type WelcomeMessage,
  type WorkerLogMessage,
} from '../../protocol/messages.js';
import {
  brokerChannelName,
  contextLockName,
  PROTOCOL_VERSION,
  workerLockName,
} from '../../protocol/version.js';

import type { Transport, TransportRequest } from './transport.js';

/** The `SharedWorker` surface this transport uses. Narrowed so a fake stays small. */
export interface SharedWorkerLike {
  readonly port: MessagePortLike;
  /** Fires when the worker script itself fails to load or throws during evaluation. */
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
}

/** The `MessagePort` surface this transport uses. */
export interface MessagePortLike {
  postMessage(message: unknown): void;
  start(): void;
  close(): void;
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(type: 'messageerror', listener: (event: unknown) => void): void;
}

/** Constructs a `SharedWorker`. Injected so the harness can substitute one (ADR-0014). */
export type SharedWorkerFactory = (url: string | URL, name: string) => SharedWorkerLike;

/**
 * Why a worker cannot be used, found out before a broker of this version ever answered.
 *
 * - `worker-script-failed`: the browser reported that the script did not load, or threw while it
 *   was evaluated (ADR-0006).
 * - `worker-other-protocol-version`: the script runs another protocol version, and said so in its
 *   answer to `hello` (ADR-0008).
 * - `worker-not-answering`: the worker said nothing within {@link HANDSHAKE_DEADLINE_MS} - a fetch
 *   that hangs, or a script from before the handshake was frozen (ADR-0008, ADR-0041).
 */
export type WorkerLoadFailure =
  'worker-script-failed' | 'worker-other-protocol-version' | 'worker-not-answering';

/** Tells whoever created the transport whether the worker script started (ADR-0006). */
export interface WorkerStartup {
  /** The broker answered `hello`: the script loaded and runs. Called at most once. */
  readonly onReady: () => void;
  /**
   * The worker cannot be used, and no broker of this version ever answered, so nothing sent so far
   * reached anyone. Called instead of reporting the failure as a transport error.
   */
  readonly onLoadFailed: (event: unknown, reason: WorkerLoadFailure) => void;
}

/**
 * Where the transport stands with its worker.
 *
 * - `starting`: the first worker was started, and has not welcomed this context yet.
 * - `ready`: the current worker has welcomed this context, and its lifetime lock is waited on.
 * - `restarting`: a worker ended, or did not answer in time, and a new one has not welcomed this
 *   context yet. Its loss has been reported once.
 * - `other-version`: the worker runs another protocol version, and this transport uses no worker any
 *   more: until the page is reloaded, every worker it could start would run the same script.
 */
type Phase = 'starting' | 'ready' | 'restarting' | 'other-version';

/**
 * Delivers messages through a `SharedWorker` hosting the broker.
 *
 * The transport itself is thin: it owns one `MessagePort`, validates everything arriving on
 * it, and forwards what survives. Routing is the broker's job (ADR-0006).
 *
 * What this context takes part in goes to the broker as a `hello`, sent again whenever it changes.
 * Liveness, in both directions, is Web Locks (ADR-0041): the context holds a lock named after its
 * identity for as long as it lives, which the worker waits on, and says hello only once it holds it;
 * the worker holds a lock for its lifetime, named in its `welcome`, which this transport waits on. A
 * worker that ended - crashed, ended by the browser, terminated - frees it, and the transport starts
 * a new worker and says hello there, which restores all of its part.
 *
 * A worker whose script runs another protocol version answers `hello` and nothing else. A new worker
 * from the same URL would run the same script, so a transport that does not hand such a worker over
 * to a fallback gives up on workers altogether (ADR-0008).
 */
export class SharedWorkerTransport implements Transport {
  readonly kind = 'sharedworker' as const;
  readonly clientId;

  readonly #request: TransportRequest;
  readonly #createWorker: SharedWorkerFactory;
  readonly #url: string | URL;
  readonly #startup: WorkerStartup | undefined;
  readonly #disposal = new DisposalStack();
  readonly #attached = new Set<string>();
  readonly #once: OnceLog;
  /** The port to the current worker. Replaced when the transport gives up on a worker. */
  #port: MessagePortLike;
  #phase: Phase = 'starting';
  /** What was sent before this context held its own lock, and so before its hello (ADR-0041). */
  #unsent: ProtocolMessage[] | undefined = [];
  /** Gives up on a worker that has not welcomed this context in time. */
  #handshakeDeadline: TimerHandle | undefined;
  /** Waits on the lifetime lock of the worker that welcomed this context. */
  #workerWatch: HeldLock | undefined;

  /**
   * @param startup - When given, a script that fails to load before the broker answers is
   *   reported to it rather than as a transport error, and so is the broker's answer.
   */
  constructor(
    request: TransportRequest,
    createWorker: SharedWorkerFactory,
    url: string | URL,
    startup?: WorkerStartup,
  ) {
    this.clientId = request.clientId;
    this.#request = request;
    this.#createWorker = createWorker;
    this.#url = url;
    this.#startup = startup;
    this.#once = new OnceLog(request.logger);

    this.#port = this.#connect();
    this.#startHandshakeDeadline();

    // Held for as long as this context lives: the browser lets it go when the context goes, however
    // it goes, and the worker waiting on it forgets this context then.
    const contextLock = new HeldLock({
      locks: request.locks,
      clock: request.clock,
      name: contextLockName(this.clientId),
      mode: 'exclusive',
      hold: async (released) => {
        this.#sayHelloFirst();
        await released;
      },
      onFailed: (error) => {
        this.#once.warn('context-lock', 'could not take the lock that shows this tab is there', {
          event: 'transport.context-lock-failed',
          reason: describeUnknown(error),
        });
        // Better heard and forgotten by the worker than never heard at all.
        this.#sayHelloFirst();
      },
    });
    contextLock.start();

    this.#disposal.add(() => {
      this.#port.close();
    });
    this.#disposal.add(() => {
      void contextLock.stop();
      void this.#workerWatch?.stop();
      this.#clearHandshakeDeadline();
    });
  }

  /** {@inheritDoc Transport.send} */
  send(message: ProtocolMessage): void {
    if (this.#disposal.isDisposed) {
      return;
    }
    if (this.#unsent !== undefined) {
      this.#unsent.push(message);
      return;
    }
    try {
      this.#port.postMessage(message);
    } catch (error) {
      // A closed port, or a payload that cannot be cloned: reported, never thrown into the caller.
      this.#request.onTransportError(error);
    }
  }

  /** {@inheritDoc Transport.attach} */
  attach(configName: string): void {
    this.#attached.add(configName);
    this.#sendHello();
  }

  /** {@inheritDoc Transport.detach} */
  detach(configName: string): void {
    this.#attached.delete(configName);
    this.#sendHello();
  }

  /** {@inheritDoc Transport.close} */
  close(): void {
    if (this.#disposal.isDisposed) {
      return;
    }
    // Nothing to say: letting go of this context's lock tells the worker at once.
    for (const failure of this.#disposal.disposeAll()) {
      this.#request.logger.warn('a cleanup step failed while closing the bus', {
        event: 'transport.dispose-failed',
        reason: failure,
      });
    }
  }

  /**
   * Starts a worker - the first, or one replacing a worker given up on - and listens to it.
   *
   * Whatever a worker says once it has been replaced, or once the transport is closed, is ignored:
   * nobody is listening for it any more.
   */
  #connect(): MessagePortLike {
    const worker = this.#createWorker(this.#url, brokerChannelName());
    const port = worker.port;
    const isCurrent = (): boolean => !this.#disposal.isDisposed && this.#port === port;

    worker.addEventListener('error', (event) => {
      if (!isCurrent() || this.#phase === 'other-version' || this.#phase === 'restarting') {
        // A worker given up on for its version has nothing left to report: the mismatch was. One
        // started in place of a lost worker was reported with the loss; its deadline tries again.
        return;
      }
      // The browser fires this when the script cannot be fetched or evaluated, and a port to
      // such a worker silently delivers nothing. Before the broker has answered, that also means
      // nothing sent so far arrived anywhere - which is what makes sending it again elsewhere safe.
      if (this.#phase === 'starting' && this.#startup !== undefined) {
        this.#startup.onLoadFailed(event, 'worker-script-failed');
        return;
      }
      this.#request.onTransportError(event);
    });

    port.addEventListener('message', (event: { readonly data: unknown }) => {
      if (isCurrent()) {
        this.#receive(event.data);
      }
    });

    port.addEventListener('messageerror', (event: unknown) => {
      if (!isCurrent()) {
        return;
      }
      // Structured cloning failed on the way in. The message is unrecoverable; reporting it
      // is all that can be done, and dropping it silently would hide a real bug.
      this.#request.onTransportError(event);
    });

    port.start();
    return port;
  }

  /** This context holds its lock, or could not take it: its hello goes first, then what waited. */
  #sayHelloFirst(): void {
    const unsent = this.#unsent;
    if (unsent === undefined) {
      return;
    }
    this.#unsent = undefined;
    this.#sendHello();
    for (const message of unsent) {
      // Every hello that waited is said by the one above, which names what this context takes part in
      // now.
      if (message.type !== 'hello') {
        this.send(message);
      }
    }
  }

  /** Says who this context is and what it takes part in: always the first message on a port. */
  #sendHello(): void {
    this.send({
      type: 'hello',
      v: PROTOCOL_VERSION,
      from: this.clientId,
      to: 'all',
      configNames: [...this.#attached],
    });
  }

  #startHandshakeDeadline(): void {
    this.#clearHandshakeDeadline();
    this.#handshakeDeadline = this.#request.clock.setTimer(() => {
      this.#handshakeDeadline = undefined;
      this.#handshakeMissed();
    }, HANDSHAKE_DEADLINE_MS);
  }

  #clearHandshakeDeadline(): void {
    if (this.#handshakeDeadline !== undefined) {
      this.#request.clock.clearTimer(this.#handshakeDeadline);
      this.#handshakeDeadline = undefined;
    }
  }

  /** The worker did not welcome this context in time. */
  #handshakeMissed(): void {
    if (this.#disposal.isDisposed || this.#phase === 'ready' || this.#phase === 'other-version') {
      return;
    }
    if (this.#phase === 'starting' && this.#startup !== undefined) {
      // No broker of this version ever answered: a fetch that hangs, or a script from before the
      // handshake was frozen (ADR-0008). As when the script does not load, nothing sent reached
      // anyone, so whoever created the transport can send it elsewhere.
      this.#startup.onLoadFailed(
        new Error(`The SharedWorker did not answer within ${String(HANDSHAKE_DEADLINE_MS)} ms`),
        'worker-not-answering',
      );
      return;
    }
    if (this.#phase === 'starting') {
      this.#reportLoss(
        `The SharedWorker did not answer within ${String(HANDSHAKE_DEADLINE_MS)} ms`,
      );
    }
    // A worker started in place of a lost one did not answer either: try another.
    this.#reconnect();
  }

  /** The lifetime lock of the worker that welcomed this context was granted: that worker ended. */
  #workerEnded(): void {
    this.#reportLoss('The SharedWorker ended');
    this.#reconnect();
  }

  /** Reports a lost worker once, as one being replaced without the application (ADR-0041). */
  #reportLoss(reason: string): void {
    this.#phase = 'restarting';
    this.#request.logger.warn('lost the SharedWorker; starting a new one', {
      event: 'transport.broker-lost',
      reason,
    });
    this.#request.onTransportError(new Error(reason), true);
  }

  /**
   * Leaves the worker given up on, and starts a new one.
   *
   * A worker that ended is gone, and a `SharedWorker` with the same URL and name starts a new one:
   * the one every other tab reaches when its own wait ends too, and the one tabs opened since have
   * already started. Its broker learns about this context from `hello`, which restores what the
   * context takes part in. No `owner-claimed` is sent: the port did not change hands.
   */
  #reconnect(): void {
    if (this.#disposal.isDisposed) {
      // The loss just reported reached the application, which may have closed the bus.
      return;
    }
    void this.#workerWatch?.stop();
    this.#workerWatch = undefined;
    try {
      this.#port.close();
    } catch {
      // A port to a dead worker has nothing left to release.
    }
    // Whether the worker starts or not, the deadline tries again.
    this.#startHandshakeDeadline();
    try {
      this.#port = this.#connect();
    } catch (error) {
      // Starting a worker failed outright, as a policy that changed since can make it.
      this.#request.logger.warn('could not start a new SharedWorker', {
        event: 'transport.worker-restart-failed',
        reason: describeUnknown(error),
      });
      return;
    }
    this.#request.logger.info('started a new SharedWorker', {
      event: 'transport.worker-restarted',
    });
    this.#sendHello();
  }

  #receive(raw: unknown): void {
    const result = decodeMessage(raw);
    if (!result.ok && result.failure.reason === 'limit-exceeded') {
      // A broker of this build passes on nothing beyond the limits, so this is another build's, or a
      // broker's bug. Logged once, not reported per message, and never taken for another version.
      warnLimitExceeded(this.#once, 'transport.limit-exceeded', result.failure.limit, {
        messageType: result.failure.type,
        field: result.failure.field,
      });
      return;
    }
    if (!result.ok) {
      this.#request.onDecodeFailure(result.failure);
      if (this.#disposal.isDisposed) {
        // The report reached the application, which may react by closing the bus.
        return;
      }
      // Only the worker speaks on this port, and a broker passes on nothing but messages in its own
      // version. A message in another version is therefore the worker's own answer to hello: the
      // script runs another protocol version and drops everything this context says. Before a
      // welcome of this version, that means nothing sent so far reached anyone - as when the script
      // does not load at all, and with the same remedy (ADR-0008).
      if (result.failure.reason === 'version-mismatch') {
        this.#workerRunsOtherVersion(result.failure.theirVersion);
      }
      return;
    }

    const message = result.message;
    if (message.type === 'welcome') {
      // Meant for this transport rather than for the client: the script is running, and its broker
      // has heard this context.
      this.#welcomed(message);
      return;
    }

    if (message.type === 'worker-log') {
      // Meant for this tab's logger, not for the client. Only the worker sends one: the broker
      // passes none on, and no port may speak as the broker (ADR-0018).
      if (message.from === BROKER_ID) {
        this.#logWorkerRecord(message);
      }
      return;
    }

    // The broker has already resolved addressing, so anything arriving here is for us. The
    // one thing still worth checking is that it is not our own message coming back, which
    // would double-deliver every local event.
    if (message.from === this.clientId) {
      return;
    }

    this.#request.onMessage(message);
  }

  /** The current worker answered a hello. Only its first answer changes anything. */
  #welcomed(welcome: WelcomeMessage): void {
    if (this.#phase === 'ready' || this.#phase === 'other-version' || welcome.from !== BROKER_ID) {
      return;
    }
    const wasRestarting = this.#phase === 'restarting';
    this.#phase = 'ready';
    this.#clearHandshakeDeadline();
    this.#watchWorker(welcome.worker);

    if (wasRestarting) {
      this.#request.logger.info('the SharedWorker answers again', {
        event: 'transport.broker-restored',
      });
      // Told only now, so that what the client says in answer reaches a broker that knows it.
      this.#request.onReconnected?.();
    } else {
      this.#startup?.onReady();
    }
  }

  /**
   * Waits on the lifetime lock of the worker that welcomed this context (ADR-0041).
   *
   * The worker holds it before it starts any port, so the request queues behind it; the browser
   * grants it the moment the worker has ended.
   */
  #watchWorker(workerId: string): void {
    const port = this.#port;
    const watch = new HeldLock({
      locks: this.#request.locks,
      clock: this.#request.clock,
      name: workerLockName(workerId),
      mode: 'shared',
      hold: () => {
        if (!this.#disposal.isDisposed && this.#port === port && this.#workerWatch === watch) {
          this.#workerEnded();
        }
        return Promise.resolve();
      },
      onFailed: (error) => {
        this.#once.warn('worker-watch', 'could not wait on the lock of the SharedWorker', {
          event: 'transport.worker-watch-failed',
          reason: describeUnknown(error),
        });
      },
    });
    this.#workerWatch = watch;
    watch.start();
  }

  /**
   * Writes one of the worker's records to this tab's logger (ADR-0018).
   *
   * The record is logged as the worker wrote it: its own `event`, its own message, its own fields.
   * `clientId` is the identity the worker's record concerns - often another tab's, and absent where
   * the record concerns none - so it replaces this transport's own rather than being merged with
   * it, and `reportedBy` names the tab that wrote this copy. Every connected tab logs a copy.
   */
  #logWorkerRecord(record: WorkerLogMessage): void {
    const fields = {
      ...record.fields,
      clientId: record.fields.clientId,
      reportedBy: this.clientId,
    };
    if (record.level === 'error') {
      this.#request.logger.error(record.message, fields);
      return;
    }
    this.#request.logger.warn(record.message, fields);
  }

  /**
   * Acts on a worker that said it runs another protocol version.
   *
   * Before a welcome of this version, whoever created the transport may send what it sent elsewhere,
   * and then closes it. Where it cannot - `transport: 'sharedworker'`, a fallback that could not be
   * built, or a worker started in place of one that died - the transport gives up on workers: it
   * closes the port, so the stale worker can end once no tab holds one. The mismatch itself has been
   * reported by then, once (ADR-0008).
   */
  #workerRunsOtherVersion(theirVersion: unknown): void {
    if (this.#phase === 'other-version') {
      return;
    }
    if (this.#phase === 'starting' && this.#startup !== undefined) {
      this.#startup.onLoadFailed(
        new Error(
          `The SharedWorker script runs protocol version ${String(theirVersion)}, not ${String(PROTOCOL_VERSION)}`,
        ),
        'worker-other-protocol-version',
      );
      if (this.#disposal.isDisposed) {
        return;
      }
    }

    this.#phase = 'other-version';
    this.#clearHandshakeDeadline();
    void this.#workerWatch?.stop();
    try {
      this.#port.close();
    } catch {
      // Nothing is sent on the port or heard from it any more either way.
    }
    this.#request.logger.warn(
      'the SharedWorker script runs another protocol version; this tab uses no worker until it is reloaded',
      { event: 'transport.worker-other-protocol-version', theirVersion },
    );
  }
}
