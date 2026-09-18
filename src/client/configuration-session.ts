import { assertNever } from '../core/assert.js';
import type { TimerHandle } from '../core/clock.js';
import { createDeferred, type Deferred } from '../core/deadline.js';
import {
  effectiveDevice,
  type NormalizedConfiguration,
  type NormalizedDeviceFilter,
  type ResolvedDevice,
} from '../core/defaults.js';
import type { ConfigurationDiagnostics } from '../core/diagnostics.js';
import { EventEmitter } from '../core/emitter.js';
import { SerialBrokerErrorCode } from '../core/error-codes.js';
import { deserializeError, SerialBrokerError } from '../core/errors.js';
import { OnceLog, type ScopedLogger } from '../core/logger.js';
import { RateLimiter } from '../core/rate-limit.js';
import {
  SerialBrokerStatus,
  type SerialBrokerListener,
  type SerialBrokerEventName,
  type SerialBrokerStatusSnapshot,
} from '../core/types.js';
import { toSetupOptions } from '../core/validation.js';
import type { SerialPortLike, SerialBrokerEnvironment } from '../environment/environment.js';
import { OwnershipElection } from '../owner/election.js';
import {
  describeDevice,
  matchesDevice,
  resolveDevice,
  toRequestOptions,
} from '../owner/port-matcher.js';
import { PortSupervisor } from '../owner/port-supervisor.js';
import { mapRequestPortError } from '../owner/serial-errors.js';
import { STATUS_ANSWER_RATE } from '../protocol/limits.js';
import type {
  ClientId,
  ProtocolMessage,
  RequestId,
  StatusDevice,
  StatusMessage,
  TermId,
} from '../protocol/messages.js';
import { PROTOCOL_VERSION, termLockName } from '../protocol/version.js';

import { AcceptedWrites } from './accepted-writes.js';
import { OwnerTerms } from './owner-terms.js';
import { PendingWrites } from './pending-writes.js';
import { TabSlot } from './tab-slot.js';
import type { Transport } from './transport/transport.js';

/** Where the outcome of a write performed at this context's port goes. */
interface WriteReport {
  /**
   * Asks the context that issued the write whether it may begin now (ADR-0011): at once for this
   * context's own, with `write-ready` for another's. `true` means that context counts it as begun.
   */
  readonly mayBegin: () => boolean | Promise<boolean>;
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
 * must behave identically either way as far as the application can tell** (ADR-0009). So
 * `send()` goes to the supervisor directly or across the bus depending on the role, and
 * nothing above this class knows which happened.
 *
 * @remarks
 * Over the 400-line mark that docs/guidelines/coding-style.md flags. It is the wiring
 * itself - which of four collaborators handles what, and in which order - and that is
 * only legible in one place. The parts with rules of their own live elsewhere:
 * the delivery guarantee (`pending-writes.ts`, and `accepted-writes.ts` at the port), the tab
 * limit (`tab-slot.ts`), ownership (`../owner/election.ts`), the port lifecycle
 * (`../owner/port-supervisor.ts`) and event dispatch (`../core/emitter.ts`).
 */
export class ConfigurationSession {
  readonly #emitter: EventEmitter;
  readonly #election: OwnershipElection;
  readonly #writes: PendingWrites;
  /** The terms of holding the port this context has heard of (ADR-0018). */
  readonly #terms: OwnerTerms;
  /** This context's term while it holds the port. */
  #term: TermId | undefined;
  /** What this session records once only: what a flood of messages would repeat. */
  readonly #once: OnceLog;
  /** How often this context answers `status-request`, and the answer a flood is coalesced into. */
  readonly #statusAnswers: RateLimiter;
  #delayedStatusAnswer: TimerHandle | undefined;
  /**
   * The writes accepted at this context's port in the current term of holding it (ADR-0011).
   *
   * Replaced, not cleared, when the term ends: a write of the old term that ends later records its
   * outcome in the old term's record, where it cannot make the new term forget a write.
   */
  #acceptedWrites = new AcceptedWrites();
  /**
   * The `write-ready` questions this context has asked as the tab holding the port, by the issuing
   * context and request, with the term that asked (ADR-0011).
   *
   * Only the write next in the port's queue asks, and each question ends with its write, which the
   * supervisor bounds by `writeTimeoutMs`: there is never more than one per term here, and never one
   * a message could add.
   */
  readonly #awaitedApprovals = new Map<
    string,
    { readonly term: TermId; readonly answer: Deferred<boolean> }
  >();

  #supervisor: PortSupervisor | undefined;
  #status: SerialBrokerStatus = SerialBrokerStatus.Idle;
  #statusSince: number;
  #lastErrorCode: SerialBrokerErrorCode | undefined;
  #isReleased = false;
  /** This tab's place among the `maxTabs` tabs, or `undefined` without a limit (ADR-0017). */
  readonly #slot: TabSlot | undefined;
  /** On the bus and in the election: at once without a limit, once a place is held with one. */
  #isJoined = false;
  /** Why this tab gave up: the tab holding the port runs a different tab limit (ADR-0017). */
  #withdrawal: SerialBrokerError | undefined;
  /**
   * The configuration in effect.
   *
   * Replaced, never mutated, and only in one respect: an auto-mode configuration takes its
   * device from the port the user chooses, or from the tab holding the port (ADR-0022). Every
   * other field is what `setup()` was given.
   */
  #configuration: NormalizedConfiguration;

  /**
   * @param onDeviceResolved - An auto-mode configuration resolved its device, or adopted another
   *   tab's; `definition` now carries it, and whoever remembers the configuration should remember
   *   that.
   */
  constructor(
    private readonly environment: SerialBrokerEnvironment,
    private readonly transport: Transport,
    configuration: NormalizedConfiguration,
    private readonly logger: ScopedLogger,
    private readonly onDeviceResolved: () => void,
  ) {
    this.#configuration = configuration;
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
        newTerm: () => {
          const term = environment.newId('t') as TermId;
          const lockName = termLockName(
            configuration.name,
            term,
            transport.clientId,
            configuration.maxTabs,
          );
          return { term, lockName };
        },
        onAcquired: (term) => {
          // Released while the locks were being granted: the election lets them go right after.
          if (!this.#isReleased) {
            this.#startTerm(term);
          }
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
      dispatch: (requestId, payload, term) => {
        this.#dispatchWrite(requestId, payload, term);
      },
      // A write can only go anywhere while there is a connection to write to. Asking here
      // rather than tracking it in two places keeps one source of truth for the answer.
      canDispatch: () => this.#status === SerialBrokerStatus.Open,
      currentTerm: () => this.#terms.current,
      isTermEnded: (term) => this.#terms.isEnded(term),
    });

    this.#terms = new OwnerTerms({
      locks: environment.locks,
      clock: environment.clock,
      configName: configuration.name,
      logger,
      lockQueryTimeoutMs: configuration.connection.openTimeoutMs,
      onEnded: (term, wasCurrent) => {
        this.#writes.handleTermEnded(term);
        // The port is with nobody until the next tab claims it. Only the term that held it as far
        // as this tab knew says that; a term that had been succeeded describes nothing any more.
        // A configuration that gave up, and does not reconnect by itself, stays `failed`: the next
        // tab to hold the port does not connect either (ADR-0008).
        if (wasCurrent && !this.#election.isOwner && !this.#isReleased && !this.#staysFailed()) {
          this.#setStatus(SerialBrokerStatus.Reconnecting);
        }
      },
    });

    this.#once = new OnceLog(logger);
    this.#statusAnswers = new RateLimiter(STATUS_ANSWER_RATE, environment.clock);

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
    return this.#configuration;
  }

  /**
   * The three fields every message this session sends carries: the protocol version, this context
   * as the sender, and the configuration the message is about. Spread into each message beside the
   * fields that are its own.
   */
  #envelope(): { readonly v: number; readonly from: ClientId; readonly configName: string } {
    return {
      v: PROTOCOL_VERSION,
      from: this.transport.clientId,
      configName: this.#configuration.name,
    };
  }

  /**
   * Joins the bus and the election - at once, or, with a tab limit, once this tab holds one of the
   * places (ADR-0017). Until then the status is `queued`.
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

    this.transport.attach(this.#configuration.name);

    // Ask whoever owns the port to restate its status. Without this, a tab joining an
    // already-open configuration would sit at `idle` until the next status change, which on a
    // healthy connection could be hours away. Asking here rather than letting the broker do it
    // keeps both transports on one code path - the fallback has no broker to ask (ADR-0006).
    this.#requestStatus();

    this.#election.start();
  }

  /**
   * The bus reached a new broker after the old one died (ADR-0024).
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
   * Tries again where the connection gave up (ADR-0008): in the tab holding the port, whose
   * supervisor did, or - from any other tab - by asking that tab to.
   *
   * A tab that withdrew over a different tab limit stays withdrawn.
   */
  retry(): void {
    if (this.#withdrawal !== undefined) {
      return;
    }
    if (this.#supervisor !== undefined) {
      this.#supervisor.retry();
    } else if (this.#status === SerialBrokerStatus.Failed) {
      this.#requestStatus(true);
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
        { configName: this.#configuration.name, timestamp: this.environment.clock.now() },
      ),
    );

    // Order is load-bearing: the port must be closed *before* the lock is released. The lock
    // is what guarantees only one context has the device open, so releasing it first lets the
    // successor call `open()` while this context still holds it - which fails with
    // InvalidStateError and drops the successor straight into a reconnect loop.
    await this.#stopBeingOwner();
    await this.#election.stop();
    this.#terms.dispose();
    this.#stopTimers();

    if (this.#isJoined && this.#withdrawal === undefined) {
      this.transport.detach(this.#configuration.name);
    }
    // The place goes last: the next tab joins only once this one has left the bus and the port.
    this.#slot?.stop();
    this.#setStatus(SerialBrokerStatus.Released);
    this.#emitter.clear();
  }

  // --- Application-facing ------------------------------------------------------------------

  /**
   * Registers an event listener.
   *
   * @returns Removes this registration only (see `EventEmitter.add`).
   */
  subscribe<TEvent extends SerialBrokerEventName>(
    event: TEvent,
    listener: SerialBrokerListener<TEvent>,
  ): () => void {
    const remove = this.#emitter.add(event, listener);
    if (event === 'onStatusChange') {
      // The current status, once, so that no application has to read `getStatus()` right after
      // subscribing. After `subscribe()` has returned, as every event is delivered, and only to a
      // listener still registered then; `previousStatus` equals `status`, which no change has.
      void Promise.resolve().then(() => {
        if (this.#isReleased) {
          return;
        }
        this.#emitter.emitTo('onStatusChange', listener as SerialBrokerListener<'onStatusChange'>, {
          name: this.#configuration.name,
          status: this.#status,
          previousStatus: this.#status,
          timestamp: this.environment.clock.now(),
        });
      });
    }
    return remove;
  }

  /** Removes an event listener. */
  unsubscribe<TEvent extends SerialBrokerEventName>(
    event: TEvent,
    listener: SerialBrokerListener<TEvent>,
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
    const device = describeDevice(this.#configuration.device);
    return Object.freeze({
      name: this.#configuration.name,
      status: this.#status,
      deviceKind: device.kind,
      vendorId: device.vendorId,
      productId: device.productId,
      serialOptions: this.#configuration.serial,
      maxTabs: this.#configuration.maxTabs,
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
   * application's code (ADR-0014).
   */
  diagnostics(): ConfigurationDiagnostics {
    return {
      name: this.#configuration.name,
      role: this.#election.isOwner ? 'owner' : 'participant',
      status: this.#status,
      statusSince: this.#statusSince,
      lastErrorCode: this.#lastErrorCode,
      settings: toSetupOptions(this.#configuration),
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
        { configName: this.#configuration.name, timestamp: this.environment.clock.now() },
      );
    }
    if (this.#withdrawal !== undefined) {
      // A withdrawn tab never writes again, so waiting for the deadline would only delay the
      // answer the writes pending at the withdrawal were already given.
      throw this.#withdrawal;
    }

    await this.#writes.add(this.environment.newId('w') as RequestId, payload);
  }

  /**
   * Shows the port picker. Must be called from a user gesture.
   *
   * Allowed while this tab holds the port, and before anyone is known to: a tab that has just set
   * the configuration up may ask in the same gesture, and the choice is used the moment this tab
   * holds the port (ADR-0022). A tab that knows another tab holds it asks that tab to look again.
   *
   * @param options - `chooseAgain`: an auto-mode configuration lets the user choose a different
   *   device, which the tab holding the port switches to, even while it is open.
   * @throws A {@link SerialBrokerError} with code `INVALID_ARGUMENT` for `chooseAgain` in a
   *   configuration that names its device, before the picker opens.
   */
  async requestAccess(options: { readonly chooseAgain: boolean }): Promise<void> {
    const { chooseAgain } = options;
    if (chooseAgain && this.#configuration.device.kind !== 'auto') {
      throw new SerialBrokerError(
        SerialBrokerErrorCode.INVALID_ARGUMENT,
        `"${this.#configuration.name}" names its device, so there is nothing to choose again. To use another device, release the configuration and set it up with the other device.`,
        {
          configName: this.#configuration.name,
          context: {
            argumentName: 'options.chooseAgain',
            expected: 'a configuration in auto mode',
            actualValue: true,
            deviceKind: describeDevice(this.#configuration.device).kind,
          },
          timestamp: this.environment.clock.now(),
        },
      );
    }
    // The connection is open, so there is nothing to ask the user for - unless the user is to
    // choose a different device. The same answer whichever tab this is: a picker that opens here
    // and not there would say which tab holds the port, which no caller may learn (ADR-0009).
    if (this.#status === SerialBrokerStatus.Open && !chooseAgain) {
      return;
    }

    if (this.#supervisor === undefined) {
      // The permission is the origin's, so any tab taking part may ask the user for it. A tab
      // waiting for a place, or one that has left the configuration, does not take part.
      if (
        this.#status === SerialBrokerStatus.Queued ||
        this.#withdrawal !== undefined ||
        this.#isReleased
      ) {
        throw new SerialBrokerError(
          SerialBrokerErrorCode.PERMISSION_REQUIRED,
          this.#status === SerialBrokerStatus.Queued
            ? 'This tab is queued behind the tabs using this configuration and cannot use the device yet'
            : 'This tab no longer takes part in this configuration',
          {
            configName: this.#configuration.name,
            context: { status: this.#status },
            timestamp: this.environment.clock.now(),
          },
        );
      }
    }

    const changed = await this.#pickPort(chooseAgain);
    // The picker stays open for as long as the user likes, so this tab may hold the port by now,
    // or no longer. Its supervisor, if there is one, decides what the grant means for the
    // connection: a different device is switched to, even from an open connection. Without one,
    // the tab holding the port is asked to look again - with the device the user chose, which in
    // auto mode it has no other way to learn.
    const supervisor = this.#supervisor;
    if (supervisor === undefined) {
      this.#requestStatus(true);
    } else if (changed) {
      await supervisor.followDevice();
    } else {
      await supervisor.useGrantedPort();
    }
  }

  /**
   * Opens the picker for the device in effect and takes what the user chose.
   *
   * In auto mode the chosen port's identity becomes the device (ADR-0022): the first time, and
   * whenever the user is to choose again, when the picker is unfiltered. Otherwise the port has to be
   * the configured device - a browser applies the filter, but the check behind it holds should one
   * offer a port it did not ask for.
   *
   * @returns `true` if the device in effect changed.
   * @throws A {@link SerialBrokerError} with code `PERMISSION_DENIED` if the user dismisses
   *   the picker, `DEVICE_MISMATCH` if the chosen port is not the configured device, or
   *   `USER_GESTURE_REQUIRED` if the call was not made during a gesture.
   */
  async #pickPort(chooseAgain: boolean): Promise<boolean> {
    let port: SerialPortLike;
    try {
      port = await this.environment.serial.requestPort(
        chooseAgain ? {} : toRequestOptions(this.#configuration),
      );
    } catch (error) {
      throw mapRequestPortError(error, {
        configName: this.#configuration.name,
        timestamp: this.environment.clock.now(),
      });
    }

    // The picker stays open for as long as the user likes. A tab that left the configuration
    // meanwhile - released it, or withdrew from it - must not give it a device any more, nor tell
    // the tab holding the port to go looking for one.
    if (this.#isReleased) {
      throw new SerialBrokerError(
        SerialBrokerErrorCode.CONFIGURATION_RELEASED,
        'The configuration was released while the port picker was open',
        { configName: this.#configuration.name, timestamp: this.environment.clock.now() },
      );
    }
    if (this.#withdrawal !== undefined) {
      throw this.#withdrawal;
    }

    const device = this.#configuration.device;
    if (device.kind === 'auto' && (chooseAgain || device.resolved === undefined)) {
      return this.resolveDevice(resolveDevice(port), 'picker');
    }
    if (!matchesDevice(port, this.#configuration)) {
      const info = port.getInfo();
      const expected = describeDevice(device);
      throw new SerialBrokerError(
        SerialBrokerErrorCode.DEVICE_MISMATCH,
        'The selected port is not the configured device',
        {
          configName: this.#configuration.name,
          context: {
            // Reached for a USB or a non-USB filter: an `any` filter matches every port, so
            // there is nothing it can mismatch.
            expectedDevice: expected.kind,
            expectedVendorId: expected.vendorId,
            expectedProductId: expected.productId,
            actualVendorId: info.usbVendorId,
            actualProductId: info.usbProductId,
          },
          timestamp: this.environment.clock.now(),
        },
      );
    }
    return false;
  }

  /**
   * Takes a device for an auto-mode configuration: the port the user chose, or what the tab
   * holding the port runs (ADR-0022).
   *
   * Only auto mode resolves, and only to something else than it has: the tab holding the port
   * decides, so a device adopted from it replaces one this tab chose earlier, and a device the user
   * chose again replaces the one before. The client passes what a remembered entry resolved to
   * before the session starts.
   *
   * @returns `true` if the device in effect changed.
   */
  resolveDevice(resolved: ResolvedDevice, source: 'picker' | 'holder' | 'remembered'): boolean {
    const device = this.#configuration.device;
    if (device.kind !== 'auto' || isSameResolution(device.resolved, resolved)) {
      return false;
    }
    this.#configuration = Object.freeze({
      ...this.#configuration,
      device: Object.freeze({ kind: 'auto' as const, resolved: Object.freeze(resolved) }),
    });
    this.logger.info('auto mode resolved the device', {
      configName: this.#configuration.name,
      event: 'session.device-resolved',
      source,
      device: resolved.kind,
      vendorId: resolved.kind === 'usb' ? resolved.vendorId : undefined,
      productId: resolved.kind === 'usb' ? resolved.productId : undefined,
    });
    this.onDeviceResolved();
    return true;
  }

  // --- Bus ----------------------------------------------------------------------------------

  /** Handles a message addressed to this context. */
  handleMessage(message: ProtocolMessage): void {
    if (this.#isReleased || !this.#isJoined || this.#withdrawal !== undefined) {
      return;
    }

    if ((message.type === 'owner-claimed' || message.type === 'status') && this.#election.isOwner) {
      // While this context holds the lock, any other claim or status is stale - the lock cannot be
      // held twice (ADR-0005). A former holder's status arriving after the lock did would show a
      // status this port does not have, and a claim would hand this context's own writes out again.
      return;
    }
    // Who may say what about the port is the terms' to decide (ADR-0018).
    this.#terms.authorize(message, () => {
      this.#apply(message);
    });
  }

  /** Acts on a message the terms have believed. */
  #apply(message: ProtocolMessage): void {
    switch (message.type) {
      case 'write-request':
        this.#performWriteForPeer(message.from, message.requestId, message.payload, message.term);
        return;

      case 'write-ready':
        // Decided here, in this context's own event loop, against whether it has given the write up
        // (ADR-0011). Answered either way, so that a refused write does not hold the port's queue.
        this.transport.send({
          ...this.#envelope(),
          type: 'write-approval',
          to: message.from,
          requestId: message.requestId,
          term: message.term,
          approved: this.#writes.approve(message.requestId, message.term),
        });
        return;

      case 'write-approval':
        this.#takeApproval(message.from, message.requestId, message.term, message.approved);
        return;

      case 'write-result':
        this.#writes.handleResult(
          message.requestId,
          message.term,
          message.ok || message.error === undefined ? undefined : deserializeError(message.error),
        );
        return;

      case 'data-received':
        this.#emitter.emit('onReceive', {
          name: this.#configuration.name,
          data: message.payload,
          text: message.text,
          timestamp: message.timestamp,
        });
        return;

      case 'data-sent':
        this.#emitter.emit('onSend', {
          name: this.#configuration.name,
          data: message.payload,
          origin: message.originClientId === this.transport.clientId ? 'local' : 'remote',
          timestamp: message.timestamp,
        });
        return;

      case 'status':
        this.#applyStatus(message);
        return;

      case 'status-request':
        if (message.retry && this.#supervisor !== undefined) {
          // Asked by a tab whose user chose the device, or whose application set it up again. A
          // resolution chosen there is taken first (ADR-0022), and a different device is switched
          // to, even from an open connection: the user chose it. Otherwise nothing happens unless
          // this tab's supervisor gave up or waits for permission - a working connection is left
          // alone.
          const supervisor = this.#supervisor;
          if (message.device !== undefined && this.resolveDevice(message.device, 'picker')) {
            void supervisor.followDevice();
          } else {
            supervisor.retry();
          }
        }
        this.#answerStatusRequest();
        return;

      case 'error':
        this.#emitError(deserializeError(message.error), { broadcast: false });
        return;

      case 'owner-claimed':
        // Believed, and so the term holding the port (ADR-0018). Waiting writes go to it once it
        // states `open`: until then there is nothing to write to.
        return;

      case 'owner-released':
      case 'hello':
      case 'welcome':
      case 'worker-log':
        // The broker's bookkeeping and the worker's own records, handled by the broker or the
        // transport, which logs a forwarded record itself (ADR-0014). Nothing to do here.
        return;

      case 'diagnostics-request':
      case 'diagnostics-report':
        // Addressed to a context rather than to a configuration: the client answers requests
        // itself, and reports go to observers, which have no sessions (ADR-0014).
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
  handleDeviceDisconnected(port: SerialPortLike | null): void {
    this.#supervisor?.handleDeviceDisconnected(port);
  }

  // --- Ownership ----------------------------------------------------------------------------

  /**
   * Begins a term of holding the port: the election holds its lock, so the term can be spoken for.
   *
   * Nothing is said in a term before its lock is held: every other tab checks that lock before it
   * believes a word of what this tab says about the term (ADR-0018).
   */
  #startTerm(term: TermId): void {
    this.#term = term;

    this.transport.send({
      ...this.#envelope(),
      type: 'owner-claimed',
      to: 'all',
      term,
      maxTabs: this.#configuration.maxTabs,
    });

    const supervisor = new PortSupervisor(
      this.environment,
      this.#configuration,
      {
        device: () => this.#configuration.device,
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
            name: this.#configuration.name,
            data,
            text,
            timestamp: this.environment.clock.now(),
          });
          this.transport.send({
            ...this.#envelope(),
            type: 'data-received',
            to: 'all',
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
    // Taken over from a term that gave up, in a configuration that does not reconnect by itself:
    // this tab does not connect either, until the application or the user says so (ADR-0008).
    supervisor.start(this.#staysFailed() ? 'failed' : 'connecting');

    // Becoming the owner is also a change of owner, and has to treat pending writes exactly as an
    // announcement from a peer would. Whoever held the port before let go of the lock - but what it
    // said about a write may still be on its way, so its term is waited for (ADR-0018).
    this.#terms.takeOwn({
      term,
      from: this.transport.clientId,
      maxTabs: this.#configuration.maxTabs,
    });
  }

  async #stopBeingOwner(): Promise<void> {
    const supervisor = this.#supervisor;
    const term = this.#term;
    this.#supervisor = undefined;
    this.#term = undefined;
    // A later term as owner starts with its own record: a write accepted now has ended, or is
    // turned away as `NOT_CONNECTED`, before this context could write it again.
    this.#acceptedWrites = new AcceptedWrites();

    if (supervisor === undefined || term === undefined) {
      // Not holding the port, so there is nothing to give up: the election reports the lock lost
      // after `release()` has already stopped being owner.
      return;
    }

    // `owner-released` is the term's last word, and a tab that hears it concludes that a write the
    // term began and did not answer was lost with it (ADR-0018). So the answers go first: the
    // supervisor stops only once every write handed to it has been answered, or has hung for as long
    // as a write may.
    await supervisor.stop();

    // Queued before the goodbye is sent and before the term's lock is let go: a tab that finds the
    // lock free and this request waiting on it knows that the term's last words are on their way,
    // rather than taking it for a term whose tab died (ADR-0018).
    this.#queueGoodbye(term);

    this.transport.send({
      ...this.#envelope(),
      type: 'owner-released',
      to: 'all',
      term,
    });
    // The term's lock and the ownership lock go together, after the term's last word.
    void this.#election.stop();
    this.#terms.endOwn(term);
  }

  /**
   * Queues a request of this context's own on the term's lock, as the sign of a clean end.
   *
   * It is granted once every tab watching the term has looked, and then let go. Nothing else can
   * produce it: a tab that died leaves nothing queued, which is exactly the difference the tabs
   * waiting on the term have to tell (ADR-0018).
   */
  #queueGoodbye(term: TermId): void {
    void this.environment.locks
      .request(
        termLockName(
          this.#configuration.name,
          term,
          this.transport.clientId,
          this.#configuration.maxTabs,
        ),
        { mode: 'exclusive' },
        async () => {
          // Nothing to do while holding it: being queued was the whole point.
        },
      )
      .catch(() => {
        // A browser that refuses the request only costs the other tabs the difference between this
        // term ending cleanly and its tab having died, which ends it as soon as the lock is free.
      });
  }

  // --- Writes ---------------------------------------------------------------------------------

  /**
   * Hands a write to whoever can perform it.
   *
   * Called by {@link PendingWrites} once it has decided the request may be sent - whether that
   * is the first attempt or a re-dispatch after ownership moved. The decision lives there;
   * this method only knows *how* to send, not *whether* to.
   */
  #dispatchWrite(requestId: RequestId, payload: Uint8Array, term: TermId): void {
    const supervisor = this.#supervisor;
    if (this.#election.isOwner && supervisor !== undefined && term === this.#term) {
      // Straight to the port, with no round trip across the bus - but through the same record as
      // a peer's write: a late `NOT_CONNECTED` from a former owner hands this write on again, and
      // it may already be queued here. A write that found no open connection never started, so it
      // goes back to wait for the next one, in the tab holding the port exactly as in any other.
      this.#performWrite(supervisor, this.transport.clientId, requestId, payload, {
        // The issuer is this context: asked at once, with nothing on the bus.
        mayBegin: () => this.#writes.approve(requestId, term),
        finished: (error) => {
          this.#writes.handleResult(requestId, term, error);
        },
      });
      return;
    }

    // To every participant: only the tab holding `term` acts on it (ADR-0006).
    this.transport.send({
      ...this.#envelope(),
      type: 'write-request',
      to: 'all',
      requestId,
      payload,
      term,
    });
  }

  /** The owner path for someone else's write. */
  #performWriteForPeer(
    origin: ClientId,
    requestId: RequestId,
    payload: Uint8Array,
    requestedTerm: TermId,
  ): void {
    const supervisor = this.#supervisor;
    const term = this.#term;
    if (supervisor === undefined || term === undefined || requestedTerm !== term) {
      // Addressed to a term this tab does not hold: every participant hears a write request, and
      // only the tab holding its term acts on it (ADR-0006). A tab that let go of the port in that
      // term is released and hears nothing; its issuer hands the write on once the term has ended.
      return;
    }

    const key = approvalKey(origin, requestId);
    this.#performWrite(supervisor, origin, requestId, payload, {
      mayBegin: () => {
        const answer = createDeferred<boolean>();
        this.#awaitedApprovals.set(key, { term, answer });
        this.transport.send({
          ...this.#envelope(),
          type: 'write-ready',
          to: origin,
          requestId,
          term,
        });
        return answer.promise;
      },
      finished: (error) => {
        // Answered or not, the question is over: the supervisor stopped waiting for it.
        this.#awaitedApprovals.delete(key);
        this.#sendWriteResult(origin, requestId, term, error);
      },
    });
  }

  /**
   * Takes the answer to a `write-ready` this context asked.
   *
   * Only from the context that issued the write, which the request's `from` named, and only for the
   * term that asked: whether a write may begin is that context's to decide, and a yes from any other
   * would begin a write its issuer may have given up (ADR-0011). Any other answer is ignored - the
   * supervisor stops waiting at its deadline, so the write is not begun.
   */
  #takeApproval(from: ClientId, requestId: RequestId, term: TermId, approved: boolean): void {
    const key = approvalKey(from, requestId);
    const awaited = this.#awaitedApprovals.get(key);
    if (awaited?.term !== term) {
      return;
    }
    this.#awaitedApprovals.delete(key);
    awaited.answer.resolve(approved);
  }

  /**
   * Writes at this context's port, at most once per request whoever issued it (ADR-0011).
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
    const refusal = accepted.isKnown(origin, requestId)
      ? undefined
      : supervisor.refusalOfWrite(requestId, payload.byteLength);
    if (refusal !== undefined) {
      report.finished(refusal);
      return;
    }

    const admission = accepted.admit(origin, requestId);
    if (admission.kind === 'in-progress') {
      return;
    }
    if (admission.kind === 'finished') {
      report.finished(admission.error);
      return;
    }

    void supervisor.write(payload, report.mayBegin).then(
      () => {
        accepted.finish(origin, requestId, undefined);
        // The outcome goes to the issuer before any tab hears `onSend`. A listener may release the
        // configuration from there, which fails every write still pending as released - and this one
        // is known to have reached the device. For another tab's write, `write-result` therefore goes
        // out before `data-sent`: the messages of one sender keep their order.
        report.finished(undefined);
        this.#announceSent(payload, origin);
      },
      (error: unknown) => {
        // The supervisor rejects a write with a library error only.
        const failure = error as SerialBrokerError;
        accepted.finish(origin, requestId, failure);
        report.finished(failure);
      },
    );
  }

  #sendWriteResult(
    origin: ClientId,
    requestId: RequestId,
    term: TermId | undefined,
    error: SerialBrokerError | undefined,
  ): void {
    this.transport.send({
      ...this.#envelope(),
      type: 'write-result',
      to: origin,
      requestId,
      ok: error === undefined,
      error: error?.toJSON(),
      term,
    });
  }

  /** Tells everyone - including this context - that bytes reached the device. */
  #announceSent(payload: Uint8Array, originClientId: ClientId): void {
    const timestamp = this.environment.clock.now();

    this.#emitter.emit('onSend', {
      name: this.#configuration.name,
      data: payload,
      origin: originClientId === this.transport.clientId ? 'local' : 'remote',
      timestamp,
    });

    this.transport.send({
      ...this.#envelope(),
      type: 'data-sent',
      to: 'all',
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
      name: this.#configuration.name,
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
   * different tab limit (ADR-0017).
   *
   * Two limits cannot both be kept, and silently keeping the looser one would defeat the point of
   * a limit. The tab holding the port decides; this one reports the conflict in this tab only, leaves
   * the bus, the election and its place, and stays `failed` until the application releases the
   * configuration and sets it up with the same limit.
   */
  #withdraw(holdingTabMaxTabs: number): void {
    const conflict = new SerialBrokerError(
      SerialBrokerErrorCode.CONFIGURATION_CONFLICT,
      `"${this.#configuration.name}" is used with maxTabs ${String(holdingTabMaxTabs)} by the tab holding the port, and with maxTabs ${String(this.#configuration.maxTabs)} in this tab`,
      {
        configName: this.#configuration.name,
        context: { maxTabs: this.#configuration.maxTabs, holdingTabMaxTabs },
        timestamp: this.environment.clock.now(),
      },
    );
    this.#withdrawal = conflict;
    this.logger.warn('withdrew from a configuration run with a different tab limit', {
      event: 'session.tab-limit-conflict',
      maxTabs: this.#configuration.maxTabs,
      holdingTabMaxTabs,
    });
    // Reported in this tab only: the other tabs believe errors only from the tab holding the port.
    this.#emitError(conflict, { broadcast: false });
    this.#writes.failAll(conflict);
    this.#terms.dispose();
    this.#stopTimers();
    void this.#election.stop();
    this.transport.detach(this.#configuration.name);
    this.#slot?.stop();
    this.#setStatus(SerialBrokerStatus.Failed);
  }

  /**
   * Takes a status this tab has believed: the term's lock was held when it was checked.
   *
   * Runs after that check, so the configuration may have gone away in between.
   */
  #applyStatus(message: StatusMessage): void {
    if (this.#isReleased || this.#withdrawal !== undefined || this.#election.isOwner) {
      return;
    }
    if (message.maxTabs !== this.#configuration.maxTabs) {
      // The limit is part of the term's lock name, so this tab has checked that the tab holding
      // the port really runs the configuration with it (ADR-0017, ADR-0018).
      this.#withdraw(message.maxTabs);
      return;
    }
    if (message.device.kind === 'usb' || message.device.kind === 'non-usb') {
      // The device the tab holding the port runs - configured, or chosen by its user. A tab in
      // auto mode follows it; any other tab keeps what it was configured with (ADR-0022). Believed
      // for the same reason as the limit: the term's lock was held when this status was checked.
      this.resolveDevice(message.device, 'holder');
    }
    if (message.status === SerialBrokerStatus.Open) {
      // The owner states `open` when the port opens, and again after reaching a new broker. A
      // write request lost on the way in between is handed on here; one the owner already has,
      // it recognises. Before the status is set, so that a write only now allowed out is sent
      // once, by the status change.
      this.#writes.resendUnstarted();
    }
    this.#setStatus(message.status);
  }

  /**
   * Answers a `status-request`, within the rate this context answers them at (ADR-0019).
   *
   * One answer is a broadcast that reaches every tab, so requests beyond the rate need no answer
   * of their own: they are answered together by the next one the rate allows, and no tab that
   * asked is left without a status.
   */
  #answerStatusRequest(): void {
    if (!this.#election.isOwner) {
      return;
    }
    if (this.#statusAnswers.take()) {
      this.#broadcastStatus(this.#status);
      return;
    }
    this.#once.warn(
      'status-answers',
      'answers to status-request beyond the rate limit are coalesced; further ones without a record',
      { event: 'session.status-answers-throttled' },
    );
    if (this.#delayedStatusAnswer !== undefined) {
      return;
    }
    this.#delayedStatusAnswer = this.environment.clock.setTimer(() => {
      this.#delayedStatusAnswer = undefined;
      if (this.#isReleased || !this.#election.isOwner) {
        return;
      }
      this.#statusAnswers.take();
      this.#broadcastStatus(this.#status);
    }, this.#statusAnswers.delayUntilAllowed());
  }

  /**
   * `true` while the configuration, as this tab last knew it, gave up and waits for the application
   * or the user: `failed`, with `autoReconnect: false`.
   *
   * A term of holding the port that ends does not change that, so neither the tabs that watch it end
   * nor the tab taking over treat the handover as a reason to connect (ADR-0008). A tab that knows
   * nothing - the only tab, reloaded - is `idle`, and connects: setting up is the application asking.
   */
  #staysFailed(): boolean {
    return (
      this.#status === SerialBrokerStatus.Failed && !this.#configuration.connection.autoReconnect
    );
  }

  /** Stops what this session scheduled. */
  #stopTimers(): void {
    if (this.#delayedStatusAnswer !== undefined) {
      this.environment.clock.clearTimer(this.#delayedStatusAnswer);
      this.#delayedStatusAnswer = undefined;
    }
  }

  /** @param retry - Whether the tab holding the port is to try again where it gave up. */
  #requestStatus(retry = false): void {
    this.transport.send({
      ...this.#envelope(),
      type: 'status-request',
      to: 'all',
      retry,
      ...(retry ? this.#chosenDevice() : {}),
    });
  }

  /** The device auto mode resolved to, for a request to the tab holding the port. */
  #chosenDevice(): { device?: ResolvedDevice } {
    const device = this.#configuration.device;
    return device.kind === 'auto' && device.resolved !== undefined
      ? { device: device.resolved }
      : {};
  }

  #broadcastStatus(status: SerialBrokerStatus): void {
    const term = this.#term;
    if (term === undefined) {
      // Holding the lock without holding the port: released while the lock was being granted. There
      // is no status of a port to state.
      return;
    }
    this.transport.send({
      ...this.#envelope(),
      type: 'status',
      to: 'all',
      status,
      maxTabs: this.#configuration.maxTabs,
      device: statusDevice(this.#configuration.device),
      term,
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
      name: this.#configuration.name,
      error,
      timestamp: error.timestamp === 0 ? this.environment.clock.now() : error.timestamp,
    });

    if (options.broadcast) {
      this.transport.send({
        ...this.#envelope(),
        type: 'error',
        to: 'all',
        error: error.toJSON(),
        timestamp: this.environment.clock.now(),
      });
    }
  }
}

/** The key of a question about one write: requests are identified per issuing context. */
function approvalKey(origin: ClientId, requestId: RequestId): string {
  return `${origin} ${requestId}`;
}

/** `true` if a resolution is the one an auto-mode filter already holds. */
function isSameResolution(current: ResolvedDevice | undefined, next: ResolvedDevice): boolean {
  if (current?.kind !== next.kind) {
    return false;
  }
  return (
    current.kind !== 'usb' ||
    next.kind !== 'usb' ||
    (current.vendorId === next.vendorId && current.productId === next.productId)
  );
}

/** The device in effect, as a `status` message carries it: by kind, with USB IDs when it has them. */
function statusDevice(filter: NormalizedDeviceFilter): StatusDevice {
  const device = effectiveDevice(filter);
  if (device === undefined) {
    return { kind: 'auto' };
  }
  return device.kind === 'usb'
    ? { kind: 'usb', vendorId: device.vendorId, productId: device.productId }
    : { kind: device.kind };
}
