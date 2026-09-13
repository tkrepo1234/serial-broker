import type { TimerHandle } from '../../core/clock.js';
import { DisposalStack } from '../../core/disposable.js';
import { decodeMessage } from '../../protocol/decode.js';
import { HEARTBEAT_INTERVAL_MS } from '../../protocol/heartbeat.js';
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
 * Why a worker cannot be used, found out before its broker ever answered.
 *
 * - `worker-script-failed`: the browser reported that the script did not load, or threw while it
 *   was evaluated (ADR-0007).
 * - `worker-other-protocol-version`: the script runs another protocol version, and said so in its
 *   answer to `hello` (ADR-0024).
 */
export type WorkerLoadFailure = 'worker-script-failed' | 'worker-other-protocol-version';

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
 */
export class SharedWorkerTransport implements Transport {
  readonly kind = 'sharedworker' as const;
  readonly clientId;

  readonly #port: MessagePortLike;
  readonly #disposal = new DisposalStack();
  readonly #sender: MessageSender;
  readonly #request: TransportRequest;
  readonly #startup: WorkerStartup | undefined;
  #isReady = false;
  readonly #attached = new Set<string>();
  readonly #owned = new Set<string>();
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
    this.#startup = startup;

    const worker = createWorker(url, brokerChannelName());
    this.#port = worker.port;
    this.#sender = new MessageSender(
      request,
      (message) => {
        this.#port.postMessage(message);
      },
      this.#disposal,
    );

    worker.addEventListener('error', (event) => {
      if (this.#disposal.isDisposed) {
        // Nobody is listening for this transport any more, and it may already have been replaced.
        return;
      }
      // The browser fires this when the script cannot be fetched or evaluated, and a port to
      // such a worker silently delivers nothing. Before the broker has answered, that also means
      // nothing sent so far arrived anywhere - which is what makes sending it again elsewhere safe.
      if (!this.#isReady && this.#startup !== undefined) {
        this.#startup.onLoadFailed(event, 'worker-script-failed');
        return;
      }
      request.onTransportError(event);
    });

    this.#port.addEventListener('message', (event: { readonly data: unknown }) => {
      this.#receive(event.data);
    });

    this.#port.addEventListener('messageerror', (event: unknown) => {
      if (this.#disposal.isDisposed) {
        return;
      }
      // Structured cloning failed on the way in. The message is unrecoverable; reporting it
      // is all that can be done, and dropping it silently would hide a real bug.
      request.onTransportError(event);
    });

    this.#port.start();
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

  #scheduleHeartbeat(): void {
    this.#heartbeat = this.#request.clock.setTimer(() => {
      if (this.#disposal.isDisposed) {
        return;
      }
      this.send({
        type: 'heartbeat',
        v: PROTOCOL_VERSION,
        from: this.clientId,
        to: 'all',
        configNames: [...this.#attached],
        ownedConfigNames: [...this.#owned],
      });
      this.#scheduleHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);
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

    if (result.message.type === 'welcome') {
      // Meant for this transport rather than for the client: the script is running.
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
}
