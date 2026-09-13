import { assertNever } from '../core/assert.js';
import type { NormalizedConfiguration } from '../core/defaults.js';
import { describeSettings, type ConfigurationDiagnostics } from '../core/diagnostics.js';
import { EventEmitter } from '../core/emitter.js';
import { SerialBrokerErrorCode } from '../core/error-codes.js';
import { deserializeError, SerialBrokerError } from '../core/errors.js';
import type { ScopedLogger } from '../core/logger.js';
import {
  SerialBrokerStatus,
  type SerialBrokerEventMap,
  type SerialBrokerEventName,
  type SerialBrokerStatusSnapshot,
} from '../core/types.js';
import type { SerialBrokerEnvironment } from '../environment/environment.js';
import { OwnershipElection } from '../owner/election.js';
import { PortSupervisor } from '../owner/port-supervisor.js';
import type { ClientId, ProtocolMessage, RequestId } from '../protocol/messages.js';
import { PROTOCOL_VERSION } from '../protocol/version.js';

import { PendingWrites } from './pending-writes.js';
import type { Transport } from './transport/transport.js';

/**
 * How many writes from peers the owner remembers having accepted.
 *
 * A repeat can only come from the moments around an owner change, when a participant hands on
 * the writes it has not yet seen start; a few hundred covers any realistic burst there.
 */
const MAX_REMEMBERED_PEER_WRITES = 1_024;

/**
 * One configuration, in one browsing context.
 *
 * This is where the pieces meet: the election that may make this context the owner, the
 * supervisor that holds the port while it is, the event emitter the application subscribes
 * to, and the lifecycle of writes this context has issued.
 *
 * The shape of it follows from one rule: **a context is either the owner or it is not, and it
 * must behave identically either way as far as the application can tell** (ADR-0011). So
 * `send()` goes to the supervisor directly or across the bus depending on the role, and
 * nothing above this class knows which happened.
 *
 * @remarks
 * Over the 400-line mark that docs/guidelines/coding-style.md flags. What remains is the
 * wiring itself - which of four collaborators handles what, and in which order - and that is
 * only legible in one place. The parts with rules of their own have been lifted out:
 * the delivery guarantee (`pending-writes.ts`), ownership (`../owner/election.ts`), the port
 * lifecycle (`../owner/port-supervisor.ts`) and event dispatch (`../core/emitter.ts`).
 */
export class ConfigurationSession {
  readonly #emitter: EventEmitter;
  readonly #election: OwnershipElection;
  readonly #writes: PendingWrites;
  /**
   * Writes this context has accepted from peers while holding the port, keyed by origin and
   * request, with their outcome once known.
   *
   * A participant can hand the same write to this owner twice. It sends to whoever holds the port,
   * and may learn only afterwards - from `owner-claimed` - that ownership moved, whereupon it hands
   * on every write it has not seen start. Recognising the request is what keeps the write at most
   * once (ADR-0013); answering the repeat with the known outcome lets the participant settle.
   */
  readonly #acceptedPeerWrites = new Map<
    string,
    { isDone: boolean; error: SerialBrokerError | undefined }
  >();

  #supervisor: PortSupervisor | undefined;
  #status: SerialBrokerStatus = SerialBrokerStatus.Idle;
  #statusSince: number;
  #lastErrorCode: SerialBrokerErrorCode | undefined;
  #isReleased = false;

  constructor(
    private readonly environment: SerialBrokerEnvironment,
    private readonly transport: Transport,
    private readonly configuration: NormalizedConfiguration,
    private readonly logger: ScopedLogger,
  ) {
    this.#statusSince = environment.clock.now();

    this.#emitter = new EventEmitter(
      (error) => {
        // Reported in this tab only: the listener is this tab's code, and no other tab can do
        // anything about it.
        this.#emitError(error, { broadcast: false });
      },
      () => environment.clock.now(),
    );

    this.#election = new OwnershipElection(
      environment.locks,
      configuration.name,
      {
        onAcquired: () => {
          this.#becomeOwner();
        },
        onLost: () => {
          void this.#stopBeingOwner();
        },
      },
      logger,
      environment.clock,
    );

    this.#writes = new PendingWrites({
      clock: environment.clock,
      configName: configuration.name,
      writeTimeoutMs: configuration.connection.writeTimeoutMs,
      dispatch: (requestId, payload) => {
        this.#dispatchWrite(requestId, payload);
      },
      // A write can only go anywhere while there is a connection to write to. Asking here
      // rather than tracking it in two places keeps one source of truth for the answer.
      canDispatch: () => this.#status === SerialBrokerStatus.Open,
    });
  }

  /** The configuration this session serves. */
  get definition(): NormalizedConfiguration {
    return this.configuration;
  }

  /** Joins the bus and the election. */
  start(): void {
    this.transport.attach(this.configuration.name);

    // Ask whoever owns the port to restate its status. Without this, a tab joining an
    // already-open configuration would sit at `idle` until the next status change, which on a
    // healthy connection could be hours away. Asking here rather than letting the broker do it
    // keeps both transports on one code path - the fallback has no broker to ask (ADR-0007).
    this.transport.send({
      type: 'status-request',
      v: PROTOCOL_VERSION,
      from: this.transport.clientId,
      to: 'owner',
      configName: this.configuration.name,
    });

    this.#election.start();
  }

  /**
   * Stops everything and releases the port if this context holds it.
   *
   * Pending writes are rejected rather than left hanging: the application asked for the
   * configuration to go away, and a promise that never settles is the worst possible answer.
   */
  async release(): Promise<void> {
    if (this.#isReleased) {
      return;
    }
    this.#isReleased = true;

    this.#writes.failAll(
      new SerialBrokerError(
        SerialBrokerErrorCode.CONFIGURATION_RELEASED,
        'The configuration was released while this write was pending',
        { configName: this.configuration.name, timestamp: this.environment.clock.now() },
      ),
    );

    // Order is load-bearing: the port must be closed *before* the lock is released. The lock
    // is what guarantees only one context has the device open, so releasing it first lets the
    // successor call `open()` while this context still holds it - which fails with
    // InvalidStateError and drops the successor straight into a reconnect loop.
    await this.#stopBeingOwner();
    this.#election.stop();

    this.transport.detach(this.configuration.name);
    this.#setStatus(SerialBrokerStatus.Released);
    this.#emitter.clear();
  }

  // --- Application-facing ------------------------------------------------------------------

  /** Registers an event listener. */
  subscribe<TEvent extends SerialBrokerEventName>(
    event: TEvent,
    listener: (payload: SerialBrokerEventMap[TEvent]) => void,
  ): void {
    this.#emitter.add(event, listener);
  }

  /** Removes an event listener. */
  unsubscribe<TEvent extends SerialBrokerEventName>(
    event: TEvent,
    listener: (payload: SerialBrokerEventMap[TEvent]) => void,
  ): void {
    this.#emitter.remove(event, listener);
  }

  /**
   * Reports an error that originated outside this session.
   *
   * Used for failures that are not tied to one configuration - an unusable message bus, a
   * protocol version mismatch, storage that cannot be written - which still have to reach the
   * application, and `onError` is the only channel it has. Not re-broadcast: every context
   * observes such failures for itself.
   */
  reportExternalError(error: SerialBrokerError): void {
    this.#emitError(error, { broadcast: false });
  }

  /** `true` if the application listens for `event` on this configuration. */
  hasListener(event: SerialBrokerEventName): boolean {
    return this.#emitter.has(event);
  }

  /** A point-in-time view of this configuration. */
  getStatus(): SerialBrokerStatusSnapshot {
    return Object.freeze({
      name: this.configuration.name,
      status: this.#status,
      vendorId:
        this.configuration.device.kind === 'usb' ? this.configuration.device.vendorId : undefined,
      productId:
        this.configuration.device.kind === 'usb' ? this.configuration.device.productId : undefined,
      serialOptions: this.configuration.serial,
      since: this.#statusSince,
      observedAt: this.environment.clock.now(),
      lastErrorCode: this.#lastErrorCode,
    });
  }

  /**
   * Describes this configuration in this context, for a diagnostics report.
   *
   * Everything {@link getStatus} deliberately withholds is here - the role, the pending writes,
   * the owner's connection - because this goes to an operator's diagnostics view, never to the
   * application's code (ADR-0018).
   */
  diagnostics(): ConfigurationDiagnostics {
    return {
      name: this.configuration.name,
      role: this.#election.isOwner ? 'owner' : 'participant',
      status: this.#status,
      statusSince: this.#statusSince,
      lastErrorCode: this.#lastErrorCode,
      settings: describeSettings(this.configuration),
      listeners: this.#emitter.listenerCounts(),
      pendingWrites: this.#writes.diagnostics(),
      connection: this.#supervisor?.diagnostics(),
    };
  }

  /**
   * Writes to the device, wherever the port happens to live.
   *
   * @returns A promise that settles when the owner reports the outcome. The delivery guarantee
   *   is in {@link PendingWrites}.
   */
  async send(payload: Uint8Array): Promise<void> {
    if (this.#isReleased) {
      throw new SerialBrokerError(
        SerialBrokerErrorCode.CONFIGURATION_RELEASED,
        'This configuration has been released',
        { configName: this.configuration.name, timestamp: this.environment.clock.now() },
      );
    }

    await this.#writes.add(this.environment.newId('w') as RequestId, payload);
  }

  /** Shows the port picker. Must be called from a user gesture. */
  async requestAccess(): Promise<void> {
    const supervisor = this.#supervisor;
    if (supervisor === undefined) {
      // Another context owns the port. If it is open, there is nothing to ask for; if it is
      // waiting for permission, that context has to be the one to prompt, because only it can
      // act on the result.
      if (this.#status === SerialBrokerStatus.Open) {
        return;
      }
      throw new SerialBrokerError(
        SerialBrokerErrorCode.PERMISSION_REQUIRED,
        'Another tab currently owns this configuration and must be the one to request access',
        {
          configName: this.configuration.name,
          context: { status: this.#status },
          timestamp: this.environment.clock.now(),
        },
      );
    }

    await supervisor.requestAccess();
  }

  // --- Bus ----------------------------------------------------------------------------------

  /** Handles a message addressed to this context. */
  handleMessage(message: ProtocolMessage): void {
    if (this.#isReleased) {
      return;
    }

    switch (message.type) {
      case 'owner-claimed':
        // While this context holds the lock, any other claim is stale - the lock cannot be held
        // twice (ADR-0005) - and acting on it would hand this context's own writes out again.
        if (!this.#election.isOwner) {
          this.#writes.handleOwnerChanged();
        }
        return;

      case 'owner-released':
        // The successor's `owner-claimed` is what actually resolves pending writes; this only
        // records that the port is momentarily unowned so the status reflects it.
        if (!this.#election.isOwner) {
          this.#setStatus(SerialBrokerStatus.Reconnecting);
        }
        return;

      case 'write-request':
        this.#performWriteForPeer(message.from, message.requestId, message.payload);
        return;

      case 'write-started':
        this.#writes.markStarted(message.requestId);
        return;

      case 'write-result': {
        const error =
          message.ok || message.error === undefined ? undefined : deserializeError(message.error);

        // A context that stopped owning the port between receiving a write and performing it
        // says so rather than failing it. The write never started, so handing it to whoever
        // owns the port now is not a repeat - and failing the caller because two tabs swapped
        // roles mid-request would be an error about nothing.
        this.#settleWrite(message.requestId, error);
        return;
      }

      case 'data-received':
        this.#emitter.emit('onReceive', {
          name: this.configuration.name,
          data: message.payload,
          text: message.text,
          timestamp: message.timestamp,
        });
        return;

      case 'data-sent':
        this.#emitter.emit('onSend', {
          name: this.configuration.name,
          data: message.payload,
          origin: message.originClientId === this.transport.clientId ? 'local' : 'remote',
          timestamp: message.timestamp,
        });
        return;

      case 'status':
        this.#setStatus(message.status);
        return;

      case 'status-request':
        if (this.#election.isOwner) {
          this.#broadcastStatus(this.#status);
        }
        return;

      case 'error':
        this.#emitError(deserializeError(message.error), { broadcast: false });
        return;

      case 'hello':
      case 'welcome':
      case 'heartbeat':
      case 'goodbye':
      case 'attach':
      case 'detach':
        // Presence bookkeeping, handled by the broker or the transport. Nothing to do here.
        return;

      case 'diagnostics-request':
      case 'diagnostics-report':
        // Addressed to a context rather than to a configuration: the client answers requests
        // itself, and reports go to observers, which have no sessions (ADR-0018).
        return;

      default:
        // Unreachable: the decoder rejects any type this switch does not name, and adding a
        // message type without handling it here stops compiling.
        assertNever(message, 'protocol message');
    }
  }

  /** The configured device was plugged in. */
  handleDeviceConnected(): void {
    this.#supervisor?.handleDeviceConnected();
  }

  /**
   * A port matching the configured device was unplugged.
   *
   * @param port - The event's target. The supervisor decides whether it is the port it holds:
   *   matching the filter is not enough, since an `any` filter or two identical adapters match
   *   ports this configuration never opened.
   */
  handleDeviceDisconnected(port: SerialPort | null): void {
    this.#supervisor?.handleDeviceDisconnected(port);
  }

  // --- Ownership ----------------------------------------------------------------------------

  #becomeOwner(): void {
    if (this.#isReleased) {
      return;
    }

    this.transport.setOwnership(this.configuration.name, true);
    this.transport.send({
      type: 'owner-claimed',
      v: PROTOCOL_VERSION,
      from: this.transport.clientId,
      to: 'all',
      configName: this.configuration.name,
    });

    const supervisor = new PortSupervisor(
      this.environment,
      this.configuration,
      {
        onStatus: (status) => {
          // A supervisor being stopped still reports its last statuses. They describe a
          // connection this context has already given up, so no tab should see them.
          if (this.#supervisor !== supervisor) {
            return;
          }
          // Told to the other tabs before this tab's listeners hear it: a listener may react by
          // releasing the configuration, and the other tabs must not learn `owner-released`
          // before the status it supersedes.
          this.#broadcastStatus(status);
          this.#setStatus(status);
        },
        onData: (data, text) => {
          this.#emitter.emit('onReceive', {
            name: this.configuration.name,
            data,
            text,
            timestamp: this.environment.clock.now(),
          });
          this.transport.send({
            type: 'data-received',
            v: PROTOCOL_VERSION,
            from: this.transport.clientId,
            to: 'all',
            configName: this.configuration.name,
            payload: data,
            text,
            timestamp: this.environment.clock.now(),
          });
        },
        onError: (error) => {
          this.#emitError(error);
        },
      },
      this.logger,
    );

    this.#supervisor = supervisor;
    supervisor.start();

    // Becoming the owner is also a change of owner, and has to resolve pending writes exactly
    // as an announcement from a peer would. Whoever held the port before is gone - that is what
    // freed the lock - so a write already in progress there is unknowable, and one that never
    // started can now proceed here.
    this.#writes.handleOwnerChanged();
  }

  async #stopBeingOwner(): Promise<void> {
    const supervisor = this.#supervisor;
    this.#supervisor = undefined;
    // A later term as owner starts with its own record: a write accepted now is either finished or
    // failed by the time this context could hold the port again.
    this.#acceptedPeerWrites.clear();

    if (supervisor === undefined) {
      // Not holding the port, so there is no ownership to give up. This matters: the election
      // reports the lock lost after `release()` has already stopped being owner, and by then a
      // session set up again under the same name may hold the port - clearing the transport's
      // ownership for the name here would cut that session off from every write.
      return;
    }

    this.transport.setOwnership(this.configuration.name, false);

    this.transport.send({
      type: 'owner-released',
      v: PROTOCOL_VERSION,
      from: this.transport.clientId,
      to: 'all',
      configName: this.configuration.name,
    });

    await supervisor.stop();
  }

  // --- Writes ---------------------------------------------------------------------------------

  /**
   * Hands a write to whoever can perform it.
   *
   * Called by {@link PendingWrites} once it has decided the request may be sent - whether that
   * is the first attempt or a re-dispatch after ownership moved. The decision lives there;
   * this method only knows *how* to send, not *whether* to.
   */
  #dispatchWrite(requestId: RequestId, payload: Uint8Array): void {
    const supervisor = this.#supervisor;
    if (this.#election.isOwner && supervisor !== undefined) {
      this.#writeLocally(supervisor, requestId, payload);
      return;
    }

    this.transport.send({
      type: 'write-request',
      v: PROTOCOL_VERSION,
      from: this.transport.clientId,
      to: 'owner',
      configName: this.configuration.name,
      requestId,
      payload,
    });
  }

  /** The owner path: straight to the supervisor, with no round trip across the bus. */
  #writeLocally(supervisor: PortSupervisor, requestId: RequestId, payload: Uint8Array): void {
    void supervisor
      .write(payload, () => {
        this.#writes.markStarted(requestId);
      })
      .then(
        () => {
          this.#announceSent(payload, this.transport.clientId);
          this.#writes.settle(requestId, undefined);
        },
        (error: unknown) => {
          this.#settleWrite(requestId, toSerialBrokerError(error, this.configuration.name));
        },
      );
  }

  /**
   * Settles a write this context issued, wherever it was performed.
   *
   * A write that found no open connection never started, so it goes back to wait for the next
   * connection instead of failing - in the tab holding the port exactly as in any other.
   */
  #settleWrite(requestId: RequestId, error: SerialBrokerError | undefined): void {
    if (error?.code === SerialBrokerErrorCode.NOT_CONNECTED) {
      if (this.#writes.redispatch(requestId)) {
        return;
      }
      // `NOT_CONNECTED` means its sender never began the write. If it has begun all the same, it did
      // so with another owner - this answer came late from a former one - and that owner's answer
      // is what settles it.
      if (this.#writes.isStarted(requestId)) {
        return;
      }
    }
    this.#writes.settle(requestId, error);
  }

  /** The owner path for someone else's write. */
  #performWriteForPeer(origin: ClientId, requestId: RequestId, payload: Uint8Array): void {
    const supervisor = this.#supervisor;
    if (supervisor === undefined) {
      // Ownership moved between the peer sending and this message arriving. Saying so lets
      // the originator re-send to whoever owns it now, rather than waiting out its deadline.
      this.#sendWriteResult(
        origin,
        requestId,
        new SerialBrokerError(
          SerialBrokerErrorCode.NOT_CONNECTED,
          'This context no longer owns the port',
          { configName: this.configuration.name, timestamp: this.environment.clock.now() },
        ),
      );
      return;
    }

    const key = `${origin} ${requestId}`;
    const accepted = this.#acceptedPeerWrites.get(key);
    if (accepted !== undefined) {
      // A repeat of a write already accepted. While it is still being written, its own answer is
      // on the way; once done, the known outcome is sent again for a participant that may have
      // missed it. Writing it a second time is never the answer (ADR-0013).
      if (accepted.isDone) {
        this.#sendWriteResult(origin, requestId, accepted.error);
      }
      return;
    }
    const record = { isDone: false, error: undefined as SerialBrokerError | undefined };
    this.#acceptedPeerWrites.set(key, record);
    if (this.#acceptedPeerWrites.size > MAX_REMEMBERED_PEER_WRITES) {
      // Maps iterate in insertion order, so the first key is the oldest.
      const oldest = this.#acceptedPeerWrites.keys().next().value;
      if (oldest !== undefined) {
        this.#acceptedPeerWrites.delete(oldest);
      }
    }

    void supervisor
      .write(payload, () => {
        this.transport.send({
          type: 'write-started',
          v: PROTOCOL_VERSION,
          from: this.transport.clientId,
          to: origin,
          configName: this.configuration.name,
          requestId,
        });
      })
      .then(
        () => {
          record.isDone = true;
          this.#announceSent(payload, origin);
          this.#sendWriteResult(origin, requestId, undefined);
        },
        (error: unknown) => {
          const failure = toSerialBrokerError(error, this.configuration.name);
          record.isDone = true;
          record.error = failure;
          this.#sendWriteResult(origin, requestId, failure);
        },
      );
  }

  #sendWriteResult(
    origin: ClientId,
    requestId: RequestId,
    error: SerialBrokerError | undefined,
  ): void {
    this.transport.send({
      type: 'write-result',
      v: PROTOCOL_VERSION,
      from: this.transport.clientId,
      to: origin,
      configName: this.configuration.name,
      requestId,
      ok: error === undefined,
      error: error?.toJSON(),
    });
  }

  /** Tells everyone - including this context - that bytes reached the device. */
  #announceSent(payload: Uint8Array, originClientId: ClientId): void {
    const timestamp = this.environment.clock.now();

    this.#emitter.emit('onSend', {
      name: this.configuration.name,
      data: payload,
      origin: originClientId === this.transport.clientId ? 'local' : 'remote',
      timestamp,
    });

    this.transport.send({
      type: 'data-sent',
      v: PROTOCOL_VERSION,
      from: this.transport.clientId,
      to: 'all',
      configName: this.configuration.name,
      payload,
      originClientId,
      timestamp,
    });
  }

  // --- Status and errors -----------------------------------------------------------------------

  #setStatus(status: SerialBrokerStatus): void {
    // `released` is the one status a released configuration still reports, and the last.
    if (this.#status === status || (this.#isReleased && status !== SerialBrokerStatus.Released)) {
      return;
    }

    const previousStatus = this.#status;
    this.#status = status;
    this.#statusSince = this.environment.clock.now();

    this.#emitter.emit('onStatusChange', {
      name: this.configuration.name,
      status,
      previousStatus,
      timestamp: this.#statusSince,
    });

    if (status === SerialBrokerStatus.Open) {
      this.#writes.dispatchWaiting();
    }
  }

  #broadcastStatus(status: SerialBrokerStatus): void {
    this.transport.send({
      type: 'status',
      v: PROTOCOL_VERSION,
      from: this.transport.clientId,
      to: 'all',
      configName: this.configuration.name,
      status,
      timestamp: this.environment.clock.now(),
    });
  }

  /**
   * Reports an error locally and, unless it came from the bus, to every other context.
   *
   * The `broadcast: false` case is what stops an error from bouncing: a context that receives
   * an error over the bus reports it to its own listeners and there the chain ends.
   */
  #emitError(
    error: SerialBrokerError,
    options: { broadcast: boolean } = { broadcast: true },
  ): void {
    this.#lastErrorCode = error.code;

    this.#emitter.emit('onError', {
      name: this.configuration.name,
      error,
      timestamp: error.timestamp === 0 ? this.environment.clock.now() : error.timestamp,
    });

    if (options.broadcast) {
      this.transport.send({
        type: 'error',
        v: PROTOCOL_VERSION,
        from: this.transport.clientId,
        to: 'all',
        configName: this.configuration.name,
        error: error.toJSON(),
        timestamp: this.environment.clock.now(),
      });
    }
  }
}

/** Wraps anything thrown by the supervisor that is not already a library error. */
function toSerialBrokerError(error: unknown, configName: string): SerialBrokerError {
  return error instanceof SerialBrokerError
    ? error
    : new SerialBrokerError(SerialBrokerErrorCode.WRITE_FAILED, 'The write failed', {
        configName,
        cause: error,
      });
}
