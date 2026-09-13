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

import { AcceptedWrites } from './accepted-writes.js';
import { PendingWrites } from './pending-writes.js';
import { TabSlot } from './tab-slot.js';
import type { Transport } from './transport/transport.js';

/** Where the outcome of a write performed at this context's port goes. */
interface WriteReport {
  /** The first byte is being handed to the device. */
  readonly started: () => void;
  /** The write ended, or was answered with the outcome of an earlier attempt. */
  readonly finished: (error: SerialBrokerError | undefined) => void;
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
 *
 * @remarks
 * Over the 400-line mark that docs/guidelines/coding-style.md flags. What remains is the
 * wiring itself - which of four collaborators handles what, and in which order - and that is
 * only legible in one place. The parts with rules of their own have been lifted out:
 * the delivery guarantee (`pending-writes.ts`, and `accepted-writes.ts` at the port), the tab
 * limit (`tab-slot.ts`), ownership (`../owner/election.ts`), the port lifecycle
 * (`../owner/port-supervisor.ts`) and event dispatch (`../core/emitter.ts`).
 */
export class ConfigurationSession {
  readonly #emitter: EventEmitter;
  readonly #election: OwnershipElection;
  readonly #writes: PendingWrites;
  /**
   * The writes accepted at this context's port in the current term of holding it (ADR-0013).
   *
   * Replaced, not cleared, when the term ends: a write of the old term that ends later records its
   * outcome in the old term's record, where it cannot make the new term forget a write.
   */
  #acceptedWrites = new AcceptedWrites();

  #supervisor: PortSupervisor | undefined;
  #status: SerialBrokerStatus = SerialBrokerStatus.Idle;
  #statusSince: number;
  #lastErrorCode: SerialBrokerErrorCode | undefined;
  #isReleased = false;
  /** This tab's place among the `maxTabs` tabs, or `undefined` without a limit (ADR-0025). */
  readonly #slot: TabSlot | undefined;
  /** On the bus and in the election: at once without a limit, once a place is held with one. */
  #isJoined = false;
  /** Why this tab gave up: the tab holding the port runs a different tab limit (ADR-0025). */
  #withdrawal: SerialBrokerError | undefined;

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

    this.#slot = Number.isFinite(configuration.maxTabs)
      ? new TabSlot(
          environment.locks,
          configuration.name,
          configuration.maxTabs,
          () => {
            this.#join();
          },
          logger,
          environment.clock,
        )
      : undefined;
  }

  /** The configuration this session serves. */
  get definition(): NormalizedConfiguration {
    return this.configuration;
  }

  /**
   * Joins the bus and the election - at once, or, with a tab limit, once this tab holds one of the
   * places (ADR-0025). Until then the status is `queued`.
   */
  start(): void {
    const slot = this.#slot;
    if (slot === undefined) {
      this.#join();
      return;
    }
    this.#setStatus(SerialBrokerStatus.Queued);
    slot.start();
  }

  #join(): void {
    if (this.#isReleased || this.#isJoined) {
      return;
    }
    this.#isJoined = true;
    if (this.#status === SerialBrokerStatus.Queued) {
      this.#setStatus(SerialBrokerStatus.Idle);
    }

    this.transport.attach(this.configuration.name);

    // Ask whoever owns the port to restate its status. Without this, a tab joining an
    // already-open configuration would sit at `idle` until the next status change, which on a
    // healthy connection could be hours away. Asking here rather than letting the broker do it
    // keeps both transports on one code path - the fallback has no broker to ask (ADR-0007).
    this.#requestStatus();

    this.#election.start();
  }

  /**
   * The bus reached a new broker after the old one died (ADR-0021, amended).
   *
   * Statuses and write requests sent through the dead one may be lost. The tab holding the port
   * restates its status, which a tab that reached the new broker first could not ask for yet; any
   * other tab asks for it. Hearing `open` from the owner hands on writes that have not started.
   */
  handleBusReconnected(): void {
    if (this.#isReleased || !this.#isJoined || this.#withdrawal !== undefined) {
      return;
    }
    if (this.#election.isOwner) {
      this.#broadcastStatus(this.#status);
    } else {
      this.#requestStatus();
    }
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

    if (this.#isJoined && this.#withdrawal === undefined) {
      this.transport.detach(this.configuration.name);
    }
    // The place goes last: the next tab joins only once this one has left the bus and the port.
    this.#slot?.stop();
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
    if (this.#withdrawal !== undefined) {
      // A withdrawn tab never writes again, so waiting for the deadline would only delay the
      // answer the writes pending at the withdrawal were already given.
      throw this.#withdrawal;
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
        this.#status === SerialBrokerStatus.Queued
          ? 'This tab is queued behind the tabs using this configuration and cannot use the device yet'
          : 'Another tab currently owns this configuration and must be the one to request access',
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
    if (this.#isReleased || !this.#isJoined || this.#withdrawal !== undefined) {
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
        if (this.#election.isOwner) {
          // The tab holding the port states its own status. One from another tab was sent by a
          // former holder before it let go, and arrived after the lock did: taking it would show a
          // status this tab's port does not have, and hold back every write while it lasted.
          return;
        }
        if (message.maxTabs !== this.configuration.maxTabs) {
          this.#withdraw(message.maxTabs);
          return;
        }
        if (message.status === SerialBrokerStatus.Open) {
          // The owner states `open` when the port opens, and again after reaching a new broker. A
          // write request lost on the way in between is handed on here; one the owner already has,
          // it recognises. Before the status is set, so that a write only now allowed out is sent
          // once, by the status change.
          this.#writes.resendUnstarted();
        }
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
    // A later term as owner starts with its own record: a write accepted now has ended, or is
    // turned away as `NOT_CONNECTED`, before this context could write it again.
    this.#acceptedWrites = new AcceptedWrites();

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
      // Straight to the port, with no round trip across the bus - but through the same record as
      // a peer's write: a late `NOT_CONNECTED` from a former owner hands this write on again, and
      // it may already be queued here.
      this.#performWrite(supervisor, this.transport.clientId, requestId, payload, {
        started: () => {
          this.#writes.markStarted(requestId);
        },
        finished: (error) => {
          this.#settleWrite(requestId, error);
        },
      });
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

  /**
   * Settles a write this context issued, wherever it was performed.
   *
   * A write that found no open connection never started, so it goes back to wait for the next
   * connection instead of failing - in the tab holding the port exactly as in any other. If it has
   * begun all the same, it did so with another owner - this answer came late from a former one -
   * and that owner's answer, or the next owner change, is what settles it.
   */
  #settleWrite(requestId: RequestId, error: SerialBrokerError | undefined): void {
    if (error?.code === SerialBrokerErrorCode.NOT_CONNECTED) {
      this.#writes.redispatch(requestId);
      return;
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

    this.#performWrite(supervisor, origin, requestId, payload, {
      started: () => {
        this.transport.send({
          type: 'write-started',
          v: PROTOCOL_VERSION,
          from: this.transport.clientId,
          to: origin,
          configName: this.configuration.name,
          requestId,
        });
      },
      finished: (error) => {
        this.#sendWriteResult(origin, requestId, error);
      },
    });
  }

  /**
   * Writes at this context's port, at most once per request whoever issued it (ADR-0013).
   *
   * A repeat of a write still being written is ignored, since its own outcome is on the way; a
   * repeat of a finished one is answered with the known outcome, for an issuer that may have
   * missed it.
   */
  #performWrite(
    supervisor: PortSupervisor,
    origin: ClientId,
    requestId: RequestId,
    payload: Uint8Array,
    report: WriteReport,
  ): void {
    const accepted = this.#acceptedWrites;
    const admission = accepted.admit(origin, requestId);
    if (admission.kind === 'in-progress') {
      return;
    }
    if (admission.kind === 'finished') {
      report.finished(admission.error);
      return;
    }

    void supervisor.write(payload, report.started).then(
      () => {
        accepted.finish(origin, requestId, undefined);
        this.#announceSent(payload, origin);
        report.finished(undefined);
      },
      (error: unknown) => {
        const failure = toSerialBrokerError(error, this.configuration.name);
        accepted.finish(origin, requestId, failure);
        report.finished(failure);
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

  /**
   * Gives the configuration up in this tab, because the tab holding the port runs it with a
   * different tab limit (ADR-0025).
   *
   * Two limits cannot both be kept, and silently keeping the looser one would defeat the point of
   * a limit. The tab holding the port decides; this one reports the conflict to every tab, leaves
   * the bus, the election and its place, and stays `failed` until the application releases the
   * configuration and sets it up with the same limit.
   */
  #withdraw(holdingTabMaxTabs: number): void {
    const conflict = new SerialBrokerError(
      SerialBrokerErrorCode.CONFIGURATION_CONFLICT,
      `"${this.configuration.name}" is used with maxTabs ${String(holdingTabMaxTabs)} by the tab holding the port, and with maxTabs ${String(this.configuration.maxTabs)} in this tab`,
      {
        configName: this.configuration.name,
        context: { maxTabs: this.configuration.maxTabs, holdingTabMaxTabs },
        timestamp: this.environment.clock.now(),
      },
    );
    this.#withdrawal = conflict;
    this.logger.warn('withdrew from a configuration run with a different tab limit', {
      event: 'session.tab-limit-conflict',
      maxTabs: this.configuration.maxTabs,
      holdingTabMaxTabs,
    });
    // Told to every tab, the one holding the port included, before this tab leaves the bus.
    this.#emitError(conflict);
    this.#writes.failAll(conflict);
    this.#election.stop();
    this.transport.detach(this.configuration.name);
    this.#slot?.stop();
    this.#setStatus(SerialBrokerStatus.Failed);
  }

  #requestStatus(): void {
    this.transport.send({
      type: 'status-request',
      v: PROTOCOL_VERSION,
      from: this.transport.clientId,
      to: 'owner',
      configName: this.configuration.name,
    });
  }

  #broadcastStatus(status: SerialBrokerStatus): void {
    this.transport.send({
      type: 'status',
      v: PROTOCOL_VERSION,
      from: this.transport.clientId,
      to: 'all',
      configName: this.configuration.name,
      status,
      maxTabs: this.configuration.maxTabs,
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
