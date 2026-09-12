import type { TimerHandle } from '../core/clock.js';
import { createSignal, type Signal } from '../core/deadline.js';
import type { NormalizedConfiguration } from '../core/defaults.js';
import { DisposalStack } from '../core/disposable.js';
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

import type { Transport } from './transport/transport.js';

/** A write this context has issued and is still waiting on. */
interface PendingWrite {
  readonly requestId: RequestId;
  readonly payload: Uint8Array;
  readonly deferred: Signal;
  /**
   * Set when the owner reports it has begun writing.
   *
   * The line between replayable and not. Before it, the bytes demonstrably never reached the
   * device and the request can be re-sent to a new owner. After it, whether they arrived is
   * unknowable and the request must never be repeated. See ADR-0013.
   */
  started: boolean;
  /**
   * Set while the request sits with an owner that has not answered yet.
   *
   * Prevents the same command being queued twice at the owner when a status change or an
   * ownership announcement retriggers dispatch. Cleared only when the owner it was handed to
   * is known to be gone.
   */
  isDispatched: boolean;
  timer: TimerHandle | undefined;
}

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
 */
export class ConfigurationSession {
  readonly #emitter: EventEmitter;
  readonly #election: OwnershipElection;
  readonly #disposal = new DisposalStack();
  readonly #pending = new Map<RequestId, PendingWrite>();

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
        this.#emitError(error);
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
    );
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

    this.#failAllPending(
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
    this.#disposal.disposeAll();
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

  /** A point-in-time view of this configuration. */
  getStatus(): SerialBrokerStatusSnapshot {
    return Object.freeze({
      name: this.configuration.name,
      status: this.#status,
      vendorId: this.configuration.device.vendorId,
      productId: this.configuration.device.productId,
      serialOptions: this.configuration.serial,
      since: this.#statusSince,
      observedAt: this.environment.clock.now(),
      lastErrorCode: this.#lastErrorCode,
    });
  }

  /**
   * Writes to the device, wherever the port happens to live.
   *
   * @returns A promise that settles when the owner reports the outcome.
   */
  async send(payload: Uint8Array): Promise<void> {
    if (this.#isReleased) {
      throw new SerialBrokerError(
        SerialBrokerErrorCode.CONFIGURATION_RELEASED,
        'This configuration has been released',
        { configName: this.configuration.name, timestamp: this.environment.clock.now() },
      );
    }

    const requestId = this.environment.newId('w') as RequestId;
    const pending: PendingWrite = {
      requestId,
      payload,
      deferred: createSignal(),
      started: false,
      isDispatched: false,
      timer: undefined,
    };

    // The deadline covers the whole journey - waiting for an owner, crossing the bus, and the
    // device accepting the bytes - because from the caller's point of view that is one wait.
    pending.timer = this.environment.clock.setTimer(() => {
      this.#settlePending(
        requestId,
        new SerialBrokerError(
          SerialBrokerErrorCode.WRITE_TIMEOUT,
          'The write did not complete within the configured deadline',
          {
            configName: this.configuration.name,
            context: {
              requestId,
              byteLength: payload.byteLength,
              started: pending.started,
              status: this.#status,
            },
            timestamp: this.environment.clock.now(),
          },
        ),
      );
    }, this.configuration.connection.writeTimeoutMs);

    this.#pending.set(requestId, pending);
    this.#dispatchWrite(pending);

    await pending.deferred.promise;
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
        this.#handleOwnerChanged();
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

      case 'write-started': {
        const pending = this.#pending.get(message.requestId);
        if (pending !== undefined) {
          pending.started = true;
        }
        return;
      }

      case 'write-result': {
        const error =
          message.ok || message.error === undefined ? undefined : deserializeError(message.error);

        // A context that stopped owning the port between receiving a write and performing it
        // says so rather than failing it. The write never started, so re-dispatching it to
        // whoever owns the port now is not a repeat - and failing the caller because two tabs
        // swapped roles mid-request would be an error about nothing.
        const pending = this.#pending.get(message.requestId);
        if (
          error?.code === SerialBrokerErrorCode.NOT_CONNECTED &&
          pending !== undefined &&
          !pending.started
        ) {
          pending.isDispatched = false;
          this.#dispatchWrite(pending);
          return;
        }

        this.#settlePending(message.requestId, error);
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
      case 'goodbye':
      case 'attach':
      case 'detach':
        return;
    }
  }

  /** The configured device was plugged in. */
  handleDeviceConnected(): void {
    this.#supervisor?.handleDeviceConnected();
  }

  /** The configured device was unplugged. */
  handleDeviceDisconnected(): void {
    this.#supervisor?.handleDeviceDisconnected();
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
          this.#setStatus(status);
          this.#broadcastStatus(status);
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
    this.#handleOwnerChanged();
  }

  async #stopBeingOwner(): Promise<void> {
    const supervisor = this.#supervisor;
    this.#supervisor = undefined;

    this.transport.setOwnership(this.configuration.name, false);

    if (supervisor === undefined) {
      return;
    }

    this.transport.send({
      type: 'owner-released',
      v: PROTOCOL_VERSION,
      from: this.transport.clientId,
      to: 'all',
      configName: this.configuration.name,
    });

    await supervisor.stop();
  }

  /**
   * Reacts to some other context announcing itself as the owner.
   *
   * This doubles as the death notice for the previous owner: the Web Lock is granted to a
   * successor only once the holder has released it or its context has gone, so a new owner
   * announcing itself is proof that the old one is no longer writing. That is what makes it
   * safe - and necessary - to resolve pending writes here. See ADR-0013.
   */
  #handleOwnerChanged(): void {
    for (const pending of [...this.#pending.values()]) {
      if (pending.started) {
        this.#settlePending(
          pending.requestId,
          new SerialBrokerError(
            SerialBrokerErrorCode.OWNER_LOST_DURING_WRITE,
            'The tab that owned the port went away while this write was in progress',
            {
              configName: this.configuration.name,
              context: { requestId: pending.requestId, byteLength: pending.payload.byteLength },
              timestamp: this.environment.clock.now(),
            },
          ),
        );
      } else {
        // Never started, so the bytes demonstrably never reached the device - and the context
        // it was handed to is gone, so handing it to the new owner is not a duplicate.
        pending.isDispatched = false;
        this.#dispatchWrite(pending);
      }
    }
  }

  // --- Writes ---------------------------------------------------------------------------------

  /**
   * Sends a write to whoever can perform it, or holds it until someone can.
   *
   * Holding rather than failing is what makes `send()` usable during the seconds after a page
   * loads, while the port is still opening, and during a handover. The caller's deadline
   * bounds the wait, so nothing waits forever.
   */
  #dispatchWrite(pending: PendingWrite): void {
    if (pending.isDispatched) {
      // Already handed to an owner that has not answered yet. Sending it again would put the
      // same command in that owner's queue twice.
      return;
    }

    if (this.#status !== SerialBrokerStatus.Open) {
      // No connection to write to. The write stays queued here and is dispatched by
      // `#setStatus` the moment the port opens.
      return;
    }

    pending.isDispatched = true;

    if (this.#election.isOwner && this.#supervisor !== undefined) {
      this.#writeLocally(this.#supervisor, pending);
      return;
    }

    this.transport.send({
      type: 'write-request',
      v: PROTOCOL_VERSION,
      from: this.transport.clientId,
      to: 'owner',
      configName: this.configuration.name,
      requestId: pending.requestId,
      payload: pending.payload,
    });
  }

  #dispatchWaitingWrites(): void {
    for (const pending of [...this.#pending.values()]) {
      this.#dispatchWrite(pending);
    }
  }

  /** The owner path: straight to the supervisor, with no round trip across the bus. */
  #writeLocally(supervisor: PortSupervisor, pending: PendingWrite): void {
    void supervisor
      .write(pending.payload, () => {
        pending.started = true;
      })
      .then(
        () => {
          this.#announceSent(pending.payload, this.transport.clientId);
          this.#settlePending(pending.requestId, undefined);
        },
        (error: unknown) => {
          this.#settlePending(
            pending.requestId,
            toSerialBrokerError(error, this.configuration.name),
          );
        },
      );
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
          this.#announceSent(payload, origin);
          this.#sendWriteResult(origin, requestId, undefined);
        },
        (error: unknown) => {
          this.#sendWriteResult(
            origin,
            requestId,
            toSerialBrokerError(error, this.configuration.name),
          );
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

  #settlePending(requestId: RequestId, error: SerialBrokerError | undefined): void {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) {
      return;
    }

    this.#pending.delete(requestId);
    if (pending.timer !== undefined) {
      this.environment.clock.clearTimer(pending.timer);
    }

    if (error === undefined) {
      pending.deferred.resolve();
    } else {
      pending.deferred.reject(error);
    }
  }

  #failAllPending(error: SerialBrokerError): void {
    for (const requestId of [...this.#pending.keys()]) {
      this.#settlePending(requestId, error);
    }
  }

  // --- Status and errors -----------------------------------------------------------------------

  #setStatus(status: SerialBrokerStatus): void {
    if (this.#status === status || this.#isReleased) {
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
      this.#dispatchWaitingWrites();
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
