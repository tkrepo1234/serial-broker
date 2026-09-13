import type { TimerHandle } from '../../core/clock.js';
import { DisposalStack } from '../../core/disposable.js';
import { decodeMessage } from '../../protocol/decode.js';
import { HEARTBEAT_INTERVAL_MS, MAX_UNANSWERED_HEARTBEATS } from '../../protocol/heartbeat.js';
import type { ProtocolMessage } from '../../protocol/messages.js';
import { brokerChannelName, PROTOCOL_VERSION } from '../../protocol/version.js';

import { MessageSender } from './message-sender.js';
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
 *   was evaluated (ADR-0007).
 * - `worker-other-protocol-version`: the script runs another protocol version, and said so in its
 *   answer to `hello` (ADR-0024).
 * - `worker-not-answering`: the worker said nothing at all while {@link MAX_UNANSWERED_HEARTBEATS}
 *   heartbeats went out - a fetch that hangs, or a script from before the handshake was frozen
 *   (ADR-0021, ADR-0024).
 */
export type WorkerLoadFailure =
  'worker-script-failed' | 'worker-other-protocol-version' | 'worker-not-answering';

/** Tells whoever created the transport whether the worker script started (ADR-0007). */
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
 * Delivers messages through a `SharedWorker` hosting the broker.
 *
 * The transport itself is thin: it owns one `MessagePort`, validates everything arriving on
 * it, and forwards what survives. Routing is the broker's job (ADR-0006).
 *
 * `attach` and `detach` become messages, because the broker is the thing that needs to know. A
 * heartbeat repeats both, with what this context owns, so the broker can forget a context that
 * died and restore one it forgot while it was only silent (ADR-0021).
 *
 * The worker can die as well, and a port to a dead worker reports nothing. The broker therefore
 * answers every heartbeat, and a transport whose heartbeats go unanswered starts a new worker and
 * restores its part there with a heartbeat (ADR-0021, amended).
 */
export class SharedWorkerTransport implements Transport {
  readonly kind = 'sharedworker' as const;
  readonly clientId;

  readonly #request: TransportRequest;
  readonly #createWorker: SharedWorkerFactory;
  readonly #url: string | URL;
  readonly #startup: WorkerStartup | undefined;
  readonly #disposal = new DisposalStack();
  readonly #sender: MessageSender;
  readonly #attached = new Set<string>();
  readonly #owned = new Set<string>();
  /** The port to the current worker. Replaced when the transport gives up on a worker. */
  #port: MessagePortLike;
  /** A broker of this protocol version has answered at least once. */
  #isReady = false;
  /** A valid message arrived from the broker since the last heartbeat went out. */
  #heardSinceHeartbeat = false;
  #unansweredHeartbeats = 0;
  /** A lost broker was reported, and no broker has answered since. */
  #isBrokerLost = false;
  #heartbeat: TimerHandle | undefined;

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
    this.#sender = new MessageSender(
      request,
      (message) => {
        this.#port.postMessage(message);
      },
      this.#disposal,
    );

    this.#port = this.#connect();
    this.#disposal.add(() => {
      this.#port.close();
    });

    this.#sender.sendHello();

    this.#scheduleHeartbeat();
    this.#disposal.add(() => {
      if (this.#heartbeat !== undefined) {
        request.clock.clearTimer(this.#heartbeat);
      }
    });
  }

  /** {@inheritDoc Transport.send} */
  send(message: ProtocolMessage): void {
    this.#sender.send(message);
  }

  /** {@inheritDoc Transport.attach} */
  attach(configName: string): void {
    this.#attached.add(configName);
    this.#sender.sendAttach(configName);
  }

  /** {@inheritDoc Transport.detach} */
  detach(configName: string): void {
    this.#attached.delete(configName);
    this.#owned.delete(configName);
    this.#sender.sendDetach(configName);
  }

  /** {@inheritDoc Transport.setOwnership} */
  setOwnership(configName: string, isOwner: boolean): void {
    // No message: the broker learns of ownership from the `owner-claimed` and `owner-released`
    // messages the client already sends. It is only remembered for the heartbeat.
    if (isOwner) {
      this.#owned.add(configName);
    } else {
      this.#owned.delete(configName);
    }
  }

  /** {@inheritDoc Transport.close} */
  close(): void {
    if (this.#disposal.isDisposed) {
      return;
    }

    this.#sender.sendGoodbye();

    this.#disposal.disposeAll();
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
      if (!isCurrent()) {
        return;
      }
      // The browser fires this when the script cannot be fetched or evaluated, and a port to
      // such a worker silently delivers nothing. Before the broker has answered, that also means
      // nothing sent so far arrived anywhere - which is what makes sending it again elsewhere safe.
      if (!this.#isReady && this.#startup !== undefined) {
        this.#startup.onLoadFailed(event, 'worker-script-failed');
        return;
      }
      if (this.#isBrokerLost) {
        // A worker started to replace a lost one failed as well. The loss has been reported once;
        // the next unanswered heartbeats try again.
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

  #scheduleHeartbeat(): void {
    this.#heartbeat = this.#request.clock.setTimer(() => {
      if (this.#disposal.isDisposed) {
        return;
      }
      // Scheduled before acting: giving up on a worker can close this transport, and closing clears
      // whichever heartbeat is pending.
      this.#scheduleHeartbeat();
      if (this.#brokerStoppedAnswering()) {
        this.#giveUpOnWorker();
      } else {
        this.#sendHeartbeat();
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Whether the broker left the last {@link MAX_UNANSWERED_HEARTBEATS} heartbeats unanswered.
   *
   * Counted per heartbeat, never measured in time, so that a hidden tab whose timers the browser
   * holds back is not taken for one whose worker died: it sends fewer heartbeats, and each is still
   * answered.
   */
  #brokerStoppedAnswering(): boolean {
    this.#unansweredHeartbeats = this.#heardSinceHeartbeat ? 0 : this.#unansweredHeartbeats + 1;
    this.#heardSinceHeartbeat = false;
    if (this.#unansweredHeartbeats < MAX_UNANSWERED_HEARTBEATS) {
      return false;
    }
    this.#unansweredHeartbeats = 0;
    return true;
  }

  /** Acts on a broker that stopped answering (ADR-0021, amended). */
  #giveUpOnWorker(): void {
    if (!this.#isReady && this.#startup !== undefined && !this.#isBrokerLost) {
      // No broker of this version ever answered: a fetch that hangs, or a script from before the
      // handshake was frozen (ADR-0024). As when the script does not load, nothing sent reached
      // anyone, so whoever created the transport can send it elsewhere.
      this.#isBrokerLost = true;
      this.#startup.onLoadFailed(
        new Error(
          `The SharedWorker did not answer ${String(MAX_UNANSWERED_HEARTBEATS)} heartbeats in a row`,
        ),
        'worker-not-answering',
      );
      return;
    }

    if (!this.#isBrokerLost) {
      this.#isBrokerLost = true;
      this.#request.logger.warn('the SharedWorker stopped answering; starting a new one', {
        event: 'transport.broker-lost',
        unansweredHeartbeats: MAX_UNANSWERED_HEARTBEATS,
      });
      this.#request.onTransportError(
        new Error(
          `The SharedWorker stopped answering: ${String(MAX_UNANSWERED_HEARTBEATS)} heartbeats in a row went unanswered`,
        ),
      );
      if (this.#disposal.isDisposed) {
        return;
      }
    }

    this.#reconnect();
  }

  /**
   * Leaves the worker given up on, and starts a new one.
   *
   * A worker that crashed or was ended is gone, and a `SharedWorker` with the same URL and name
   * starts a new one: the one every other tab reaches when it gives up too, and the one tabs opened
   * since have already started. Its broker learns about this context from `hello` and from a
   * heartbeat sent at once, which restores what the context takes part in and owns, as it restores
   * a tab the broker forgot. No `owner-claimed` is sent: the port did not change hands, and other
   * tabs take a claim as the previous owner's death (ADR-0013).
   */
  #reconnect(): void {
    try {
      this.#port.close();
    } catch {
      // A port to a dead worker has nothing left to release.
    }

    try {
      this.#port = this.#connect();
    } catch (error) {
      // Starting a worker failed outright, as a policy that changed since can make it. The loss is
      // reported; the next unanswered heartbeats try again.
      this.#request.logger.warn('could not start a new SharedWorker', {
        event: 'transport.worker-restart-failed',
        reason: String(error),
      });
      return;
    }

    this.#request.logger.info('started a new SharedWorker', {
      event: 'transport.worker-restarted',
    });
    this.#sender.sendHello();
    this.#sendHeartbeat();
  }

  #sendHeartbeat(): void {
    this.send({
      type: 'heartbeat',
      v: PROTOCOL_VERSION,
      from: this.clientId,
      to: 'all',
      configNames: [...this.#attached],
      ownedConfigNames: [...this.#owned],
    });
  }

  #receive(raw: unknown): void {
    const result = decodeMessage(raw);
    if (!result.ok) {
      this.#request.onDecodeFailure(result.failure);
      // Only the worker speaks on this port, and a broker passes on nothing but messages in its own
      // version. A message in another version is therefore the worker's own answer to hello: the
      // script runs another protocol version and drops everything this context says. Before a
      // welcome of this version, that means nothing sent so far reached anyone - as when the script
      // does not load at all, and with the same remedy (ADR-0024).
      if (
        result.failure.reason === 'version-mismatch' &&
        !this.#isReady &&
        this.#startup !== undefined
      ) {
        this.#startup.onLoadFailed(
          new Error(
            `The SharedWorker script runs protocol version ${String(result.failure.theirVersion)}, not ${String(PROTOCOL_VERSION)}`,
          ),
          'worker-other-protocol-version',
        );
      }
      return;
    }

    this.#heardFromBroker();

    if (result.message.type === 'welcome') {
      // Meant for this transport rather than for the client: the script is running, and its broker
      // has heard this context.
      if (!this.#isReady) {
        this.#isReady = true;
        this.#startup?.onReady();
      }
      return;
    }

    // The broker has already resolved addressing, so anything arriving here is for us. The
    // one thing still worth checking is that it is not our own message coming back, which
    // would double-deliver every local event.
    if (result.message.from === this.clientId) {
      return;
    }

    this.#request.onMessage(result.message);
  }

  /** Records that the broker is there. Ends a reported loss, so that a later one is reported too. */
  #heardFromBroker(): void {
    this.#heardSinceHeartbeat = true;
    if (this.#isBrokerLost) {
      this.#isBrokerLost = false;
      this.#request.logger.info('the SharedWorker answers again', {
        event: 'transport.broker-restored',
      });
    }
  }
}
