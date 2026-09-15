import { BackoffState, computeBackoffDelayMs } from '../core/backoff.js';
import { toHex } from '../core/bytes.js';
import type { TimerHandle } from '../core/clock.js';
import { createDeferred, withDeadline } from '../core/deadline.js';
import type { NormalizedConfiguration, NormalizedDeviceFilter } from '../core/defaults.js';
import type { ConnectionDiagnostics } from '../core/diagnostics.js';
import { SerialBrokerErrorCode } from '../core/error-codes.js';
import { describeUnknown, SerialBrokerError } from '../core/errors.js';
import type { ScopedLogger } from '../core/logger.js';
import { SerialBrokerStatus } from '../core/types.js';
import type {
  SerialOptionsLike,
  SerialPortLike,
  SerialBrokerEnvironment,
} from '../environment/environment.js';

import { findGrantedPort } from './port-matcher.js';
import { ReceiveBuffer } from './receive-buffer.js';
import { mapOpenError } from './serial-errors.js';
import { WriteQueue } from './write-queue.js';

/** What the supervisor reports to the context that owns it, and what it asks of it. */
export interface SupervisorCallbacks {
  /**
   * The device filter in effect, asked for on every attempt to find the port.
   *
   * Asked rather than given, because an auto-mode configuration resolves its device while the
   * supervisor runs - from the port the user chooses, or from the tab holding the port before
   * this one (ADR-0036).
   */
  readonly device: () => NormalizedDeviceFilter;
  /** The connection status changed. */
  readonly onStatus: (status: SerialBrokerStatus) => void;
  /** A chunk arrived from the device. `text` is present only when decoding is enabled. */
  readonly onData: (data: Uint8Array, text: string | undefined) => void;
  /** Something went wrong. The supervisor keeps working unless the status says otherwise. */
  readonly onError: (error: SerialBrokerError) => void;
}

/** The connection, as a discriminated union: no field exists in a state that cannot have it. */
type ConnectionState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'awaiting-permission' }
  /**
   * An attempt has begun and is looking for the port: waiting for the previous connection to
   * finish closing, then listing the granted ports. A state of its own, so that nothing mistakes
   * an attempt in progress for one that is merely scheduled.
   */
  | { readonly kind: 'listing' }
  | {
      readonly kind: 'opening';
      readonly port: SerialPortLike;
      /** The platform's `open()`, which may outlive the attempt that started it. */
      readonly opened: Promise<void>;
    }
  | {
      readonly kind: 'open';
      readonly port: SerialPortLike;
      readonly reader: ReadableStreamDefaultReader<Uint8Array>;
      readonly writer: WritableStreamDefaultWriter<Uint8Array>;
      readonly decoder: TextDecoder | undefined;
      /** Collects what is read into deliveries (ADR-0039); flushed when the connection ends. */
      readonly received: ReceiveBuffer;
    }
  /** The connection was lost and the next attempt is scheduled - there is always a timer. */
  | { readonly kind: 'reconnecting'; readonly timer: TimerHandle }
  | { readonly kind: 'failed' }
  | { readonly kind: 'stopped' };

/**
 * Owns the physical port for one configuration, for as long as this context is the owner.
 *
 * It is a state machine with one job: keep the port open. Everything that can take a
 * connection away - an unplugged device, a powered-off device, a stream that errors, an
 * `open()` that never settles - funnels into a single loss handler, and recovery is
 * exponential backoff with jitter, short-circuited when the platform tells us the device is
 * back. See ADR-0010.
 *
 * It is created when this context acquires ownership and disposed when it loses it, so it
 * never has to ask whether it is still the owner: if it is running, it is.
 *
 * @remarks
 * This file is over the 400-line mark that docs/guidelines/coding-style.md flags. The
 * justification is that what remains is one state machine: connect, read, write, lose,
 * reconnect, close. Splitting it would put transitions of the same automaton in different
 * files, and the question a reader arrives with - "what happens after this state" - would
 * then need two files to answer. What could be lifted out has been: device matching
 * (`port-matcher.ts`), the platform error table (`serial-errors.ts`), write serialisation
 * (`write-queue.ts`) and backoff (`core/backoff.ts`).
 */
export class PortSupervisor {
  #state: ConnectionState = { kind: 'idle' };
  #status: SerialBrokerStatus = SerialBrokerStatus.Idle;
  /** A device was plugged in while the ports were being listed, possibly too late to be listed. */
  #deviceConnectedWhileListing = false;
  /**
   * The port the most recent attempt found, whether or not it went on to open.
   *
   * Device events name a port, and only an event for this one concerns this connection: an
   * `any` filter, or two identical adapters, match ports this supervisor has nothing to do with.
   */
  #foundPort: SerialPortLike | undefined;
  /**
   * The platform reported {@link #foundPort} unplugged, and has not reported a device plugged in
   * since.
   *
   * This is what tells an absent device from a withdrawn permission. `getPorts()` lists neither,
   * but only an unplugged device is announced by a `disconnect` event - so while this is set, a
   * port missing from the list is a device that has not come back, and the attempt has failed.
   * See the ADR-0010 amendment.
   */
  #foundPortDetached = false;
  /**
   * Closing whatever lost connections left open, while that is still in progress.
   *
   * The next attempt waits for it, and so does {@link stop}: in Chromium `close()` is a round
   * trip to the browser process, and the device stays open - to this context and to the one
   * taking over - until it returns.
   */
  #teardown: Promise<void> | undefined;
  /** The one teardown {@link stop} runs, so a second call waits for the same one. */
  #stopping: Promise<void> | undefined;
  readonly #backoff = new BackoffState();
  readonly #writes = new WriteQueue();
  /** Incremented on every connection attempt, so a stale async continuation can be ignored. */
  #generation = 0;
  /** When the scheduled reconnect is due, while one is scheduled. Diagnostics only. */
  #nextAttemptAt: number | undefined;
  /** When the current connection opened, while one is open. Diagnostics only. */
  #openedAt: number | undefined;
  #bytesReceived = 0;
  #bytesSent = 0;
  /** Since when a write has been stuck at the device, while one is (ADR-0038). Diagnostics only. */
  #stalledSince: number | undefined;

  constructor(
    private readonly environment: SerialBrokerEnvironment,
    private readonly configuration: NormalizedConfiguration,
    private readonly callbacks: SupervisorCallbacks,
    private readonly logger: ScopedLogger,
  ) {}

  /**
   * Describes the connection for a diagnostics report (ADR-0018).
   *
   * Called on demand by an observer, never on a hot path, and nothing in the library branches
   * on what it returns.
   */
  diagnostics(): ConnectionDiagnostics {
    return {
      // Looking for the port and opening it are one step of an attempt to an operator, and one
      // state in the report: a new state value would change what peers on this protocol version
      // accept.
      state: this.#state.kind === 'listing' ? 'opening' : this.#state.kind,
      attempt: this.#backoff.attempt,
      nextAttemptAt: this.#nextAttemptAt,
      openedAt: this.#openedAt,
      queuedWrites: this.#writes.depth,
      bytesReceived: this.#bytesReceived,
      bytesSent: this.#bytesSent,
      stalledWriteSince: this.#stalledSince,
    };
  }

  /**
   * Starts keeping the port open.
   *
   * Returns immediately; progress is reported through {@link SupervisorCallbacks.onStatus}.
   * If no granted port matches the configured device, the status becomes
   * `awaiting-permission` and nothing is retried until `requestAccess()` succeeds or the
   * platform reports a device plugged in - the browser will not show a port picker outside a
   * user gesture (ADR-0009).
   */
  start(): void {
    if (this.#state.kind !== 'idle') {
      return;
    }
    void this.#connect();
  }

  /**
   * Stops and releases the port.
   *
   * Resolves only once the device is closed, because the caller releases the ownership lock
   * next and the tab that is granted it opens the device at once (ADR-0005). That includes a
   * port whose `open()` is still pending - it is closed when the open settles - and a lost
   * connection still being closed. Every wait is bounded by `openTimeoutMs`.
   *
   * Waits for an in-flight write to finish rather than cutting it off, so a command already
   * on its way to the device is not truncated. Never throws.
   */
  async stop(): Promise<void> {
    this.#stopping ??= this.#stop();
    await this.#stopping;
  }

  async #stop(): Promise<void> {
    this.#generation += 1;
    const previous = this.#state;
    if (previous.kind === 'open') {
      previous.received.flush();
    }
    this.#state = { kind: 'stopped' };
    this.#nextAttemptAt = undefined;
    this.#openedAt = undefined;

    if (previous.kind === 'reconnecting') {
      this.environment.clock.clearTimer(previous.timer);
    }

    if (previous.kind === 'open') {
      // Draining first means a write that has already reached the device completes rather than
      // being truncated; the deadline stops a wedged device from holding teardown open forever.
      await this.#closeStep(this.#writes.drain(), 'draining writes');
      this.#trackTeardown(this.#closeConnection(previous));
    } else if (previous.kind === 'opening') {
      this.#trackTeardown(this.#closeWhenOpened(previous));
    }

    await this.#teardown;
    this.#setStatus(SerialBrokerStatus.Idle);
  }

  /**
   * Tries again after the supervisor gave up, as a device plugged in again does.
   *
   * Does nothing in any other state: a connection that works, or one being retried, is left alone.
   */
  retry(): void {
    if (this.#state.kind !== 'failed') {
      return;
    }
    this.#backoff.reset();
    this.#state = { kind: 'idle' };
    void this.#connect();
  }

  /**
   * Connects to a port the user has just granted in the picker.
   *
   * The picker itself is the session's: which device it asks for, and what the chosen port
   * means for the configuration, are decided there (ADR-0036). What the supervisor decides is
   * what the grant means for the connection, since the picker stays open for as long as the user
   * likes and the connection may have moved on meanwhile.
   */
  async useGrantedPort(): Promise<void> {
    const current = this.#state;
    if (current.kind === 'stopped') {
      // This context stopped holding the port while the picker was open.
      return;
    }
    if (current.kind === 'open' || current.kind === 'opening') {
      // The browser has recorded the grant. Connecting again would throw away a connection that
      // works, or race the one being made.
      return;
    }
    if (current.kind === 'reconnecting') {
      this.environment.clock.clearTimer(current.timer);
    }

    // A listing in progress may have been taken before the grant, so it is started over rather
    // than awaited.
    this.#backoff.reset();
    this.#state = { kind: 'idle' };
    await this.#connect();
  }

  /**
   * Writes to the device.
   *
   * Queued behind every earlier write, so the bytes of one call never interleave with
   * another's. Large payloads are chunked, because devices with small receive buffers drop
   * the tail of an oversized write rather than applying back-pressure.
   *
   * A write that has waited in the queue for `writeTimeoutMs` is never begun, and rejects with
   * `WRITE_TIMEOUT` and `started: false`. Its issuer's own deadline, which covers the whole journey,
   * has passed by then, and it was told the write did not start: writing it afterwards would put a
   * command on the device the application may already have sent again (ADR-0013). It leaves the
   * queue when its time is up, so a backlog behind a slow write holds no payloads nobody waits for.
   *
   * @param payload - The bytes to write.
   * @param onStarted - Invoked at the moment the first byte is handed to the device. After
   *   this point the write is no longer replayable: if this context dies now, whether the
   *   device received the bytes is unknowable. See ADR-0013.
   */
  async write(payload: Uint8Array, onStarted: () => void): Promise<void> {
    const clock = this.environment.clock;
    const { writeTimeoutMs, maxWriteChunkBytes } = this.configuration.connection;
    const queuedAt = clock.monotonicNow();
    let expiry: TimerHandle | undefined;
    // Rejected when a chunk outlives its deadline at the device, which tells the caller while the
    // chunk itself stays in flight (see below).
    const stalled = createDeferred<never>();

    const queued = this.#writes.enqueueWithdrawable(async () => {
      if (expiry !== undefined) {
        clock.clearTimer(expiry);
        expiry = undefined;
      }
      // Measured as well as timed: a timer can run late, in a tab the browser throttles, and a write
      // begun in that moment is one its issuer has given up on. On the monotonic clock, the one the
      // expiry timer runs on, so that the system clock being set forward or back neither refuses a
      // write that is still in time nor lets a lapsed one through (ADR-0032).
      if (clock.monotonicNow() - queuedAt >= writeTimeoutMs) {
        throw this.#waitedTooLong(payload.byteLength, queuedAt);
      }

      const state = this.#state;
      if (state.kind !== 'open') {
        throw new SerialBrokerError(SerialBrokerErrorCode.NOT_CONNECTED, 'The port is not open', {
          configName: this.configuration.name,
          context: { status: this.#status, byteLength: payload.byteLength },
          timestamp: clock.now(),
        });
      }

      onStarted();

      // One chunk at a time rather than all of them up front: a large payload with a small chunk size
      // would otherwise allocate a view per chunk - millions of them - before the first byte goes out.
      let bytesWritten = 0;
      do {
        const chunk = payload.subarray(bytesWritten, bytesWritten + maxWriteChunkBytes);
        const written = Promise.resolve(state.writer.write(chunk));
        try {
          await withDeadline(written, this.environment.clock, {
            timeoutMs: this.configuration.connection.writeTimeoutMs,
            code: SerialBrokerErrorCode.WRITE_TIMEOUT,
            message: 'The device did not accept the write in time',
            configName: this.configuration.name,
            context: { bytesWritten, byteLength: payload.byteLength },
          });
        } catch (error) {
          if (
            error instanceof SerialBrokerError &&
            error.code === SerialBrokerErrorCode.WRITE_TIMEOUT
          ) {
            // The device has not taken the chunk. Tearing the connection down would not help: the
            // browser cannot abort a write the operating system still holds, and a port with one
            // outstanding neither closes nor opens again, however soon the device recovers
            // (measured in Chromium on Windows, ADR-0038). So the caller hears now, and the chunk
            // stays in flight - holding the queue, so that nothing behind it begins - until the
            // device takes it or the connection is lost.
            stalled.reject(error);
            await this.#awaitStalledWrite(written, state, chunk.byteLength);
            return;
          }
          // A failed write means the connection is suspect: report it to the caller with how
          // far it got, and start recovery, because the next write would fail the same way.
          const failure =
            error instanceof SerialBrokerError
              ? error
              : new SerialBrokerError(
                  SerialBrokerErrorCode.WRITE_FAILED,
                  `The device rejected the write: ${describeUnknown(error)}`,
                  {
                    configName: this.configuration.name,
                    context: { bytesWritten, byteLength: payload.byteLength },
                    timestamp: this.environment.clock.now(),
                    cause: error,
                  },
                );

          // Only while this is still the connection the write started on: a write that outlived
          // its connection must not tear down the one that replaced it.
          if (this.#state === state) {
            this.#handleConnectionLoss('write-failed', failure);
          }
          throw failure;
        }

        bytesWritten += chunk.byteLength;
        this.#bytesSent += chunk.byteLength;
      } while (bytesWritten < payload.byteLength);

      this.#traceTraffic('sent', payload);
    });

    expiry = clock.setTimer(() => {
      expiry = undefined;
      queued.withdraw(this.#waitedTooLong(payload.byteLength, queuedAt));
    }, writeTimeoutMs);

    try {
      await Promise.race([queued.promise, stalled.promise]);
    } finally {
      // Safe for a timer that has fired: clearing it then does nothing.
      clock.clearTimer(expiry);
    }
  }

  /**
   * Waits for a chunk the device did not accept in time, once its caller has been told so.
   *
   * Taken late, the chunk changes nothing but the byte count: its write has already failed. A
   * stream that fails instead is a lost connection, like any failed write - unless the connection
   * it was written to has already been replaced.
   */
  async #awaitStalledWrite(
    written: Promise<unknown>,
    state: Extract<ConnectionState, { kind: 'open' }>,
    chunkBytes: number,
  ): Promise<void> {
    this.logger.warn('the device did not accept a write in time; it stays in flight', {
      configName: this.configuration.name,
      event: 'supervisor.write-stalled',
      chunkBytes,
    });
    this.#stalledSince = this.environment.clock.now();
    try {
      await written;
      this.#bytesSent += chunkBytes;
    } catch (error) {
      if (this.#state === state) {
        this.#handleConnectionLoss(
          'write-failed',
          new SerialBrokerError(
            SerialBrokerErrorCode.WRITE_FAILED,
            `The device rejected the write: ${describeUnknown(error)}`,
            {
              configName: this.configuration.name,
              context: { chunkBytes },
              timestamp: this.environment.clock.now(),
              cause: error,
            },
          ),
        );
      }
    } finally {
      this.#stalledSince = undefined;
    }
  }

  /**
   * The error for a write that waited at the port for `writeTimeoutMs` without being begun.
   *
   * @param queuedAt - A {@link Clock.monotonicNow} reading, so that `waitedMs` is how long the write
   *   really waited rather than how far the system clock moved meanwhile.
   */
  #waitedTooLong(byteLength: number, queuedAt: number): SerialBrokerError {
    const waitedMs = this.environment.clock.monotonicNow() - queuedAt;
    this.logger.debug('a write waited too long at the port and was not begun', {
      configName: this.configuration.name,
      event: 'supervisor.write-expired',
      byteLength,
      queuedWrites: this.#writes.depth,
    });
    return new SerialBrokerError(
      SerialBrokerErrorCode.WRITE_TIMEOUT,
      'The write waited at the port for longer than writeTimeoutMs and was not begun',
      {
        configName: this.configuration.name,
        context: { started: false, byteLength, waitedMs },
        timestamp: this.environment.clock.now(),
      },
    );
  }

  /**
   * Reacts to the device reappearing.
   *
   * The platform telling us the device is back makes any remaining backoff delay pointless,
   * so the pending timer is cancelled and the attempt is made now. See ADR-0010.
   */
  handleDeviceConnected(): void {
    // A device came back, and whether it is the one that was unplugged cannot be told: the port
    // object of a replugged device is not the one it had. From here on, a port missing from the
    // list means what it means without a disconnect - no permission.
    this.#foundPortDetached = false;

    if (this.#state.kind === 'listing') {
      // Too late, perhaps, to be in the list being taken; the attempt looks again if so.
      this.#deviceConnectedWhileListing = true;
      return;
    }

    if (this.#state.kind === 'reconnecting') {
      this.environment.clock.clearTimer(this.#state.timer);
      this.#logDeviceConnected();
      void this.#connect();
      return;
    }

    // A device reappearing after reconnection was abandoned revives it: the terminal state
    // exists to stop pointless retrying, not to require an application restart. Unless the
    // application reconnects itself (`autoReconnect: false`), which a device coming back does
    // not change.
    if (this.#state.kind === 'failed' && !this.configuration.connection.autoReconnect) {
      return;
    }
    if (this.#state.kind === 'failed' || this.#state.kind === 'awaiting-permission') {
      this.#backoff.reset();
      this.#state = { kind: 'idle' };
      this.#logDeviceConnected();
      void this.#connect();
    }
  }

  #logDeviceConnected(): void {
    this.logger.info('device reappeared; reconnecting immediately', {
      configName: this.configuration.name,
      event: 'supervisor.device-connected',
    });
  }

  /**
   * Reacts to a port being unplugged.
   *
   * @param port - The event's target. Only the port this supervisor found concerns it; a
   *   `null` target, which the platform should never produce, is taken to be that port, because
   *   a missed disconnect stalls a connection and a spurious one costs a reconnect.
   */
  handleDeviceDisconnected(port: SerialPortLike | null): void {
    const found = this.#foundPort;
    if (found === undefined || (port !== null && port !== found)) {
      return;
    }
    this.#foundPortDetached = true;

    const state = this.#state;
    const error = new SerialBrokerError(
      SerialBrokerErrorCode.DEVICE_DISCONNECTED,
      'The device was disconnected',
      { configName: this.configuration.name, timestamp: this.environment.clock.now() },
    );

    if (state.kind === 'open' || state.kind === 'opening') {
      this.#handleConnectionLoss('device-disconnected', error);
      return;
    }

    if (state.kind === 'awaiting-permission') {
      // The event arrived after a retry had already found the port missing - the read error
      // and the event reach the page separately. The attempt that concluded "no permission"
      // was wrong; it failed because the device is away, and backoff takes over. The loss
      // itself was reported when the connection broke.
      this.#recordFailedAttempt('device-disconnected', error);
    }
  }

  // --- Connection lifecycle ---------------------------------------------------------------

  async #connect(): Promise<void> {
    if (this.#state.kind === 'stopped') {
      return;
    }

    const generation = (this.#generation += 1);
    this.#backoff.recordAttempt();
    // Counted from one, as diagnostics and `supervisor.reconnect` count attempts, so that the
    // number in an error's context, in a log record and in a report is the same attempt.
    const attempt = this.#backoff.attempt;
    this.#nextAttemptAt = undefined;
    this.#state = { kind: 'listing' };
    this.#setStatus(SerialBrokerStatus.Connecting);

    const teardown = this.#teardown;
    if (teardown !== undefined) {
      // Opening before the lost connection has finished closing fails with InvalidStateError:
      // an error about nothing, reported to every tab, and an attempt spent on it.
      await teardown;
      if (this.#isStale(generation)) {
        return;
      }
    }

    let port: SerialPortLike | undefined;
    do {
      this.#deviceConnectedWhileListing = false;
      try {
        port = await withDeadline(
          findGrantedPort(
            this.environment.serial,
            { name: this.configuration.name, device: this.callbacks.device() },
            this.logger,
          ),
          this.environment.clock,
          {
            timeoutMs: this.configuration.connection.openTimeoutMs,
            code: SerialBrokerErrorCode.OPEN_TIMEOUT,
            message: 'Listing the granted ports did not complete in time',
            configName: this.configuration.name,
            context: { attempt },
          },
        );
      } catch (error) {
        if (this.#isStale(generation)) {
          return;
        }
        if (
          error instanceof SerialBrokerError &&
          error.code === SerialBrokerErrorCode.OPEN_TIMEOUT
        ) {
          // A browser that never answers is a failed attempt, like a port that never opens.
          this.#handleConnectionLoss('listing-timed-out', error);
          return;
        }
        // The browser refuses to list the ports at all - a permissions policy, for instance. That
        // is not retryable, and another attempt would meet the same refusal (see
        // {@link #giveUp}).
        this.#report(
          new SerialBrokerError(
            SerialBrokerErrorCode.WEB_SERIAL_UNAVAILABLE,
            `Could not enumerate serial ports: ${describeUnknown(error)}`,
            {
              configName: this.configuration.name,
              context: { attempt },
              timestamp: this.environment.clock.now(),
              cause: error,
            },
          ),
        );
        this.#giveUp('listing-refused');
        return;
      }

      if (this.#isStale(generation)) {
        return;
      }
      // A device plugged in while the list was being taken may be missing from it. Looking again
      // is part of this attempt - not another one counted against `maxAttempts` - rather than a
      // wait for a connect event that has already happened.
    } while (port === undefined && this.#takeDeviceConnectedWhileListing());

    if (port === undefined && this.#isFoundPortDetached()) {
      // The browser does not list a detached port. The device is away, not the permission, so
      // this is a failed attempt like any other and backoff continues (ADR-0010 amendment).
      this.#recordFailedAttempt(
        'device-absent',
        new SerialBrokerError(
          SerialBrokerErrorCode.DEVICE_DISCONNECTED,
          'The device has not been plugged in again',
          {
            configName: this.configuration.name,
            context: { attempt },
            timestamp: this.environment.clock.now(),
          },
        ),
      );
      return;
    }

    if (port === undefined) {
      // Not an error: the user has never granted this device, or has taken the permission
      // away. The application has to ask, from a gesture, and until then there is nothing to
      // retry.
      this.#state = { kind: 'awaiting-permission' };
      this.#setStatus(SerialBrokerStatus.AwaitingPermission);
      return;
    }

    this.#foundPort = port;
    this.#foundPortDetached = false;
    const opened = Promise.resolve(port.open(this.#openOptions()));
    this.#state = { kind: 'opening', port, opened };

    try {
      // An open that outlives its deadline is closed by the loss handler, or by `stop()`, once it
      // settles - closing while it is pending does not stop it opening.
      await withDeadline(opened, this.environment.clock, {
        timeoutMs: this.configuration.connection.openTimeoutMs,
        code: SerialBrokerErrorCode.OPEN_TIMEOUT,
        message: 'Opening the port did not complete in time',
        configName: this.configuration.name,
        context: { attempt },
      });
    } catch (error) {
      if (this.#isStale(generation)) {
        return;
      }
      const failure = mapOpenError(error, {
        configName: this.configuration.name,
        timestamp: this.environment.clock.now(),
        extra: { attempt },
      });
      // Only a retryable failure leads to another attempt, as docs/site/errors.md promises. A
      // `SecurityError` - serial blocked by a permissions policy - is not one: every attempt would
      // meet it again, forever under the default `maxAttempts`.
      this.#handleConnectionLoss('open-failed', failure, failure.isRetryable ? 'retry' : 'give-up');
      return;
    }

    if (this.#isStale(generation)) {
      // Ownership or the connection went away while the port was opening. Whatever moved on -
      // `stop()` or the loss handler - found the attempt in `opening` and closes what it opened.
      return;
    }

    const readable = port.readable;
    const writable = port.writable;
    if (readable === null || writable === null) {
      this.#handleConnectionLoss(
        'streams-missing',
        new SerialBrokerError(
          SerialBrokerErrorCode.OPEN_FAILED,
          'The port opened but exposes no readable or writable stream',
          {
            configName: this.configuration.name,
            context: { hasReadable: readable !== null, hasWritable: writable !== null },
            timestamp: this.environment.clock.now(),
          },
        ),
      );
      return;
    }

    // A streaming decoder per connection: a multi-byte character cannot span a disconnect,
    // so its state must not either. See ADR-0015.
    const decoder = this.configuration.encoding.decodeText
      ? new TextDecoder(this.configuration.encoding.encoding)
      : undefined;
    this.#state = {
      kind: 'open',
      port,
      reader: readable.getReader(),
      writer: writable.getWriter(),
      decoder,
      received: new ReceiveBuffer(this.environment.clock, this.configuration.receive, (data) => {
        this.#deliver(data, decoder);
      }),
    };

    // The stability window is a duration, so it is measured on the monotonic clock (ADR-0032);
    // `openedAt` is a moment an operator reads, so it is the wall clock.
    this.#backoff.recordConnected(this.environment.clock.monotonicNow());
    this.#openedAt = this.environment.clock.now();
    this.#setStatus(SerialBrokerStatus.Open);
    this.logger.info('port opened', {
      configName: this.configuration.name,
      event: 'supervisor.open',
      attempt,
    });

    // Deliberately not awaited: the read loop runs for the life of the connection and ends by
    // calling the loss handler. It never rejects - every failure inside it is handled there.
    void this.#readUntilClosed(this.#state, generation);
  }

  /**
   * Whether a device was plugged in while the ports were being listed, clearing the note.
   *
   * A method rather than a field read: the note is set by `handleDeviceConnected` while the
   * listing is awaited, which the compiler's narrowing of the field cannot see.
   */
  #takeDeviceConnectedWhileListing(): boolean {
    const connected = this.#deviceConnectedWhileListing;
    this.#deviceConnectedWhileListing = false;
    return connected;
  }

  /** {@link #foundPortDetached}, read through a method for the same reason as above. */
  #isFoundPortDetached(): boolean {
    return this.#foundPortDetached;
  }

  #openOptions(): SerialOptionsLike {
    const serial = this.configuration.serial;
    return {
      baudRate: serial.baudRate,
      dataBits: serial.dataBits,
      stopBits: serial.stopBits,
      parity: serial.parity,
      bufferSize: serial.bufferSize,
      flowControl: serial.flowControl,
    };
  }

  /**
   * Reads until the stream ends or errors.
   *
   * Both outcomes mean the same thing - the connection is gone - and both go through the same
   * loss handler, which is the only way the reconnect logic stays testable.
   */
  async #readUntilClosed(
    state: Extract<ConnectionState, { kind: 'open' }>,
    generation: number,
  ): Promise<void> {
    try {
      for (;;) {
        const { value, done } = await state.reader.read();

        if (this.#isStale(generation)) {
          return;
        }

        if (done) {
          this.#handleConnectionLoss(
            'stream-ended',
            new SerialBrokerError(
              SerialBrokerErrorCode.DEVICE_DISCONNECTED,
              'The device closed the connection',
              { configName: this.configuration.name, timestamp: this.environment.clock.now() },
            ),
          );
          return;
        }

        state.received.push(value);
      }
    } catch (error) {
      if (this.#isStale(generation)) {
        return;
      }
      this.#handleConnectionLoss(
        'read-failed',
        new SerialBrokerError(
          SerialBrokerErrorCode.READ_FAILED,
          `Reading from the device failed: ${describeUnknown(error)}`,
          {
            configName: this.configuration.name,
            timestamp: this.environment.clock.now(),
            cause: error,
          },
        ),
      );
    }
  }

  /** Hands on one delivery of the receive buffer, which owns the bytes (a copy of what was read). */
  #deliver(data: Uint8Array, decoder: TextDecoder | undefined): void {
    this.#bytesReceived += data.byteLength;
    const text = decoder?.decode(data, { stream: true });
    this.#traceTraffic('received', data);
    this.callbacks.onData(data, text);
  }

  /**
   * Records traffic at `debug` level.
   *
   * The byte count is always logged; the bytes themselves only when the application has asked
   * for them. Serial traffic routinely carries card numbers and PINs, and a support engineer
   * reading a console dump must not be reading those by accident. See
   * docs/guidelines/error-handling.md.
   */
  #traceTraffic(direction: 'received' | 'sent', data: Uint8Array): void {
    this.logger.debug(direction, {
      configName: this.configuration.name,
      event: `supervisor.${direction}`,
      byteLength: data.byteLength,
      ...(this.environment.logPayloads ? { hex: toHex(data) } : {}),
    });
  }

  /**
   * The single entry point into recovery.
   *
   * Every way a connection can be lost - a failed open, a failed write, a dead stream, an
   * unplugged device - arrives here, so there is exactly one backoff policy and one place to
   * test it.
   *
   * @param next - `'give-up'` for a failed attempt whose error is not retryable: the status becomes
   *   `failed` at once, as after `maxAttempts`, instead of another attempt being scheduled. A lost
   *   connection is always retried, whatever its error - a failed write says nothing about whether
   *   the port opens again.
   */
  #handleConnectionLoss(
    reason: string,
    error: SerialBrokerError,
    next: 'retry' | 'give-up' = 'retry',
  ): void {
    const previous = this.#state;
    // `reconnecting` always has its retry scheduled, so a second report of the same loss has
    // nothing left to do. An attempt in progress is `listing` or `opening`, never this.
    if (previous.kind === 'stopped' || previous.kind === 'reconnecting') {
      return;
    }
    if (previous.kind === 'open') {
      previous.received.flush();
    }

    this.#generation += 1;
    this.#openedAt = undefined;
    this.#report(error);

    if (previous.kind === 'open') {
      this.#trackTeardown(this.#closeConnection(previous));
    } else if (previous.kind === 'opening') {
      this.#trackTeardown(this.#closeWhenOpened(previous));
    }

    if (next === 'give-up') {
      this.#giveUp(reason);
      return;
    }
    this.#recordFailedAttempt(reason, error);
  }

  /**
   * Stops trying after a failure that is not retryable, which the caller has already reported.
   *
   * The same terminal state `maxAttempts` leads to, and left the same ways: a device plugged in
   * again, a successful `requestAccess()`, or the configuration set up anew. No
   * `RECONNECT_EXHAUSTED` follows, because nothing was exhausted - the reported error is the reason,
   * and stays the configuration's `lastErrorCode`.
   */
  #giveUp(reason: string): void {
    this.#nextAttemptAt = undefined;
    this.#state = { kind: 'failed' };
    this.logger.warn('connection attempt failed and will not be retried', {
      configName: this.configuration.name,
      event: 'supervisor.gave-up',
      reason,
      attempt: this.#backoff.attempt,
    });
    this.#setStatus(SerialBrokerStatus.Failed);
  }

  /**
   * Counts an attempt, or a connection, as failed and schedules the next attempt - or gives up.
   *
   * Reports nothing about the failure itself: a lost connection has been reported by the loss
   * handler, and a device that is still away was reported when it went.
   */
  #recordFailedAttempt(reason: string, cause: SerialBrokerError): void {
    if (!this.configuration.connection.autoReconnect) {
      this.#giveUp(reason);
      return;
    }
    this.#backoff.recordDisconnected(
      this.environment.clock.monotonicNow(),
      this.configuration.connection.stableAfterMs,
    );

    if (this.#backoff.hasExhausted(this.configuration.connection)) {
      this.#nextAttemptAt = undefined;
      this.#state = { kind: 'failed' };
      this.#setStatus(SerialBrokerStatus.Failed);
      this.#report(
        new SerialBrokerError(
          SerialBrokerErrorCode.RECONNECT_EXHAUSTED,
          `Gave up reconnecting after ${String(this.#backoff.attempt)} attempts`,
          {
            configName: this.configuration.name,
            context: { attempts: this.#backoff.attempt, reason },
            timestamp: this.environment.clock.now(),
            cause,
          },
        ),
      );
      return;
    }

    // The first retry after a loss is immediate: a power-cycled device is usually back within
    // one event-loop turn (ADR-0010).
    const delayMs = computeBackoffDelayMs(
      this.#backoff.retryIndex,
      this.configuration.connection,
      this.environment.random,
    );

    this.logger.warn('connection lost; scheduling reconnect', {
      configName: this.configuration.name,
      event: 'supervisor.reconnect',
      reason,
      attempt: this.#backoff.attempt,
      delayMs,
    });

    const timer = this.environment.clock.setTimer(() => {
      if (this.#state.kind === 'reconnecting') {
        void this.#connect();
      }
    }, delayMs);

    this.#nextAttemptAt = this.environment.clock.now() + delayMs;
    this.#state = { kind: 'reconnecting', timer };
    this.#setStatus(SerialBrokerStatus.Reconnecting);
  }

  /**
   * Adds a close to {@link #teardown}.
   *
   * Never rejects, because every close step swallows its failure, so waiting for it is safe
   * anywhere.
   */
  #trackTeardown(close: Promise<void>): void {
    const previous = this.#teardown;
    const combined =
      previous === undefined ? close : Promise.all([previous, close]).then(() => undefined);
    this.#teardown = combined;
    void combined.then(() => {
      if (this.#teardown === combined) {
        this.#teardown = undefined;
      }
    });
  }

  /**
   * Closes a port whose attempt was abandoned while `open()` was pending, once it settles.
   *
   * Closing while it is pending does not stop the open from succeeding afterwards, and a port
   * that opens after it was closed stays open with nobody to close it - held against every other
   * tab. An open that failed opened nothing, and closing it could only disturb whoever does hold
   * the device.
   */
  async #closeWhenOpened(state: Extract<ConnectionState, { kind: 'opening' }>): Promise<void> {
    try {
      await withDeadline(state.opened, this.environment.clock, {
        timeoutMs: this.configuration.connection.openTimeoutMs,
        code: SerialBrokerErrorCode.OPEN_TIMEOUT,
        message: 'Timed out while waiting for the port to open',
        configName: this.configuration.name,
      });
    } catch (error) {
      const isStillPending =
        error instanceof SerialBrokerError && error.code === SerialBrokerErrorCode.OPEN_TIMEOUT;
      if (!isStillPending) {
        return;
      }
      // Still pending: close anyway, for whatever that is worth to a driver that has hung.
    }
    await this.#closeStep(Promise.resolve(state.port.close()), 'closing the port');
  }

  /**
   * Releases everything a connection holds, in the order the streams require.
   *
   * Never throws. Teardown runs on paths where something has already gone wrong, and a
   * disposal that fails must not prevent the rest of it.
   */
  async #closeConnection(state: Extract<ConnectionState, { kind: 'open' }>): Promise<void> {
    // Every one of these is bounded, including the two that look like pure local cleanup.
    // They are not: `cancel()` and `abort()` both wait for the stream's in-flight operation to
    // settle, so a device that has stopped answering mid-write leaves all three pending
    // forever - and with them, whatever asked for the teardown.
    //
    // `cancel()` and `abort()` end the streams but leave them locked, and a port whose streams
    // are still locked refuses to close. So each lock is released before `close()`; otherwise the
    // port stays open and the next `open()`, here or in the tab taking over, fails.
    await this.#closeStep(state.reader.cancel(), 'cancelling the reader');
    releaseLock(state.reader);
    await this.#closeStep(state.writer.abort(), 'aborting the writer');
    releaseLock(state.writer);
    await this.#closeStep(Promise.resolve(state.port.close()), 'closing the port');
  }

  /**
   * Runs one teardown step, bounded, recording its failure rather than raising it.
   *
   * Teardown runs on paths where something has already gone wrong; a step that fails or hangs
   * must not prevent the remaining steps or the caller that is waiting for all of them.
   */
  async #closeStep(operation: Promise<unknown>, step: string): Promise<void> {
    try {
      await withDeadline(operation, this.environment.clock, {
        timeoutMs: this.configuration.connection.openTimeoutMs,
        code: SerialBrokerErrorCode.OPEN_TIMEOUT,
        message: `Timed out while ${step}`,
        configName: this.configuration.name,
      });
    } catch (error) {
      // Not reported: expected when the device has already gone, and the caller is tearing down
      // precisely because something is wrong and is already reporting why. But a close that
      // failed can leave the device open, and the `InvalidStateError` the next open then meets
      // is unexplainable without this record.
      this.logger.debug('a teardown step failed', {
        configName: this.configuration.name,
        event: 'supervisor.teardown-failed',
        step,
        error: describeUnknown(error),
      });
    }
  }

  // --- Plumbing ---------------------------------------------------------------------------

  /**
   * `true` if the world moved on while an `await` was pending.
   *
   * Checked after every await that is followed by a state mutation. Without it, a slow
   * `open()` resolving after ownership has already been lost would install a connection this
   * context is no longer entitled to hold.
   */
  #isStale(generation: number): boolean {
    return this.#generation !== generation || this.#state.kind === 'stopped';
  }

  #setStatus(status: SerialBrokerStatus): void {
    if (this.#status === status) {
      return;
    }
    this.#status = status;
    this.callbacks.onStatus(status);
  }

  #report(error: SerialBrokerError): void {
    this.callbacks.onError(error);
  }
}

/**
 * Releases a stream reader's or writer's lock.
 *
 * Can throw while an operation is still pending - a read or write whose deadline gave up on it.
 * The port then cannot be closed cleanly anyway, and the close step that follows says so.
 */
function releaseLock(holder: { releaseLock(): void }): void {
  try {
    holder.releaseLock();
  } catch {
    // Nothing more can be done here; see above.
  }
}
