import { BackoffState, computeBackoffDelayMs } from '../core/backoff.js';
import { chunkBytes, toHex } from '../core/bytes.js';
import type { TimerHandle } from '../core/clock.js';
import { ignoreRejection, withDeadline } from '../core/deadline.js';
import type { NormalizedConfiguration } from '../core/defaults.js';
import type { ConnectionDiagnostics } from '../core/diagnostics.js';
import { SerialBrokerErrorCode } from '../core/error-codes.js';
import { describeUnknown, SerialBrokerError } from '../core/errors.js';
import type { ScopedLogger } from '../core/logger.js';
import { SerialBrokerStatus } from '../core/types.js';
import type { SerialBrokerEnvironment } from '../environment/environment.js';

import { findGrantedPort, matchesDevice, toRequestOptions } from './port-matcher.js';
import { mapOpenError, mapRequestPortError } from './serial-errors.js';
import { WriteQueue } from './write-queue.js';

/** What the supervisor reports to the context that owns it. */
export interface SupervisorCallbacks {
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
  | { readonly kind: 'opening'; readonly port: SerialPort }
  | {
      readonly kind: 'open';
      readonly port: SerialPort;
      readonly reader: ReadableStreamDefaultReader<Uint8Array>;
      readonly writer: WritableStreamDefaultWriter<Uint8Array>;
      readonly decoder: TextDecoder | undefined;
    }
  | { readonly kind: 'reconnecting'; readonly timer: TimerHandle | undefined }
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

  constructor(
    private readonly environment: SerialBrokerEnvironment,
    private readonly configuration: NormalizedConfiguration,
    private readonly callbacks: SupervisorCallbacks,
    private readonly logger: ScopedLogger,
  ) {}

  /** The current status. */
  get status(): SerialBrokerStatus {
    return this.#status;
  }

  /** `true` when the device is open and writes can be performed. */
  get isOpen(): boolean {
    return this.#state.kind === 'open';
  }

  /**
   * Describes the connection for a diagnostics report (ADR-0018).
   *
   * Called on demand by an observer, never on a hot path, and nothing in the library branches
   * on what it returns.
   */
  diagnostics(): ConnectionDiagnostics {
    return {
      state: this.#state.kind,
      attempt: this.#backoff.attempt,
      nextAttemptAt: this.#nextAttemptAt,
      openedAt: this.#openedAt,
      queuedWrites: this.#writes.depth,
      bytesReceived: this.#bytesReceived,
      bytesSent: this.#bytesSent,
    };
  }

  /**
   * Starts keeping the port open.
   *
   * Returns immediately; progress is reported through {@link SupervisorCallbacks.onStatus}.
   * If no granted port matches the configured device, the status becomes
   * `awaiting-permission` and nothing further happens until `requestAccess()` succeeds -
   * the browser will not show a port picker outside a user gesture (ADR-0009).
   */
  start(): void {
    if (this.#state.kind !== 'idle') {
      return;
    }
    void this.#connect(0);
  }

  /**
   * Stops and releases the port.
   *
   * Waits for an in-flight write to finish rather than cutting it off, so a command already
   * on its way to the device is not truncated. Never throws.
   */
  async stop(): Promise<void> {
    if (this.#state.kind === 'stopped') {
      return;
    }

    this.#generation += 1;
    const previous = this.#state;
    this.#state = { kind: 'stopped' };
    this.#nextAttemptAt = undefined;
    this.#openedAt = undefined;

    if (previous.kind === 'reconnecting' && previous.timer !== undefined) {
      this.environment.clock.clearTimer(previous.timer);
    }

    if (previous.kind === 'open') {
      // Draining first means a write that has already reached the device completes rather than
      // being truncated; the deadline stops a wedged device from holding teardown open forever.
      await this.#closeStep(this.#writes.drain(), 'draining writes');
      await this.#closeConnection(previous);
    }

    this.#setStatus(SerialBrokerStatus.Idle);
  }

  /**
   * Shows the browser's port picker and connects to the chosen device.
   *
   * Must be called synchronously from a user gesture handler: `requestPort()` consumes
   * transient activation, and any `await` before it will have spent it.
   *
   * @throws A {@link SerialBrokerError} with code `PERMISSION_DENIED` if the user dismisses
   *   the picker, `DEVICE_MISMATCH` if the chosen port is not the configured device, or
   *   `USER_GESTURE_REQUIRED` if the call was not made during a gesture.
   */
  async requestAccess(): Promise<void> {
    let port: SerialPort;
    try {
      port = await this.environment.serial.requestPort(toRequestOptions(this.configuration));
    } catch (error) {
      throw mapRequestPortError(error, {
        configName: this.configuration.name,
        timestamp: this.environment.clock.now(),
      });
    }

    if (!matchesDevice(port, this.configuration)) {
      const info = port.getInfo();
      throw new SerialBrokerError(
        SerialBrokerErrorCode.DEVICE_MISMATCH,
        'The selected port is not the configured device',
        {
          configName: this.configuration.name,
          context: {
            // Reached only for a USB filter: an `any` filter matches every port, so there is
            // nothing it can mismatch.
            expectedVendorId:
              this.configuration.device.kind === 'usb'
                ? this.configuration.device.vendorId
                : undefined,
            expectedProductId:
              this.configuration.device.kind === 'usb'
                ? this.configuration.device.productId
                : undefined,
            actualVendorId: info.usbVendorId,
            actualProductId: info.usbProductId,
          },
        },
      );
    }

    // The picker stays open for as long as the user likes, and what happened meanwhile decides
    // what the grant still means.
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
    if (current.kind === 'reconnecting' && current.timer !== undefined) {
      this.environment.clock.clearTimer(current.timer);
    }

    this.#backoff.reset();
    this.#state = { kind: 'idle' };
    await this.#connect(0);
  }

  /**
   * Writes to the device.
   *
   * Queued behind every earlier write, so the bytes of one call never interleave with
   * another's. Large payloads are chunked, because devices with small receive buffers drop
   * the tail of an oversized write rather than applying back-pressure.
   *
   * @param payload - The bytes to write.
   * @param onStarted - Invoked at the moment the first byte is handed to the device. After
   *   this point the write is no longer replayable: if this context dies now, whether the
   *   device received the bytes is unknowable. See ADR-0013.
   */
  async write(payload: Uint8Array, onStarted: () => void): Promise<void> {
    await this.#writes.enqueue(async () => {
      const state = this.#state;
      if (state.kind !== 'open') {
        throw new SerialBrokerError(SerialBrokerErrorCode.NOT_CONNECTED, 'The port is not open', {
          configName: this.configuration.name,
          context: { status: this.#status, byteLength: payload.byteLength },
          timestamp: this.environment.clock.now(),
        });
      }

      onStarted();

      let bytesWritten = 0;
      const chunks = chunkBytes(payload, this.configuration.connection.maxWriteChunkBytes);

      for (const chunk of chunks) {
        try {
          await withDeadline(state.writer.write(chunk), this.environment.clock, {
            timeoutMs: this.configuration.connection.writeTimeoutMs,
            code: SerialBrokerErrorCode.WRITE_TIMEOUT,
            message: 'The device did not accept the write in time',
            configName: this.configuration.name,
            context: { bytesWritten, byteLength: payload.byteLength },
          });
        } catch (error) {
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
      }

      this.#traceTraffic('sent', payload);
    });
  }

  /**
   * Reacts to the device reappearing.
   *
   * The platform telling us the device is back makes any remaining backoff delay pointless,
   * so the pending timer is cancelled and the attempt is made now. See ADR-0010.
   */
  handleDeviceConnected(): void {
    if (this.#state.kind === 'reconnecting') {
      if (this.#state.timer !== undefined) {
        this.environment.clock.clearTimer(this.#state.timer);
      }
      this.logger.info('device reappeared; reconnecting immediately', {
        configName: this.configuration.name,
        event: 'supervisor.device-connected',
      });
      void this.#connect(this.#backoff.attempt);
      return;
    }

    // A device reappearing after reconnection was abandoned revives it: the terminal state
    // exists to stop pointless retrying, not to require an application restart.
    if (this.#state.kind === 'failed' || this.#state.kind === 'awaiting-permission') {
      this.#backoff.reset();
      this.#state = { kind: 'idle' };
      void this.#connect(0);
    }
  }

  /** Reacts to the device being unplugged. */
  handleDeviceDisconnected(): void {
    if (this.#state.kind === 'open' || this.#state.kind === 'opening') {
      this.#handleConnectionLoss(
        'device-disconnected',
        new SerialBrokerError(
          SerialBrokerErrorCode.DEVICE_DISCONNECTED,
          'The device was disconnected',
          { configName: this.configuration.name, timestamp: this.environment.clock.now() },
        ),
      );
    }
  }

  // --- Connection lifecycle ---------------------------------------------------------------

  async #connect(attempt: number): Promise<void> {
    if (this.#state.kind === 'stopped') {
      return;
    }

    const generation = (this.#generation += 1);
    this.#backoff.recordAttempt();
    this.#nextAttemptAt = undefined;
    this.#setStatus(SerialBrokerStatus.Connecting);

    let port: SerialPort | undefined;
    try {
      port = await findGrantedPort(this.environment.serial, this.configuration, this.logger);
    } catch (error) {
      this.#report(
        new SerialBrokerError(
          SerialBrokerErrorCode.WEB_SERIAL_UNAVAILABLE,
          `Could not enumerate serial ports: ${describeUnknown(error)}`,
          { configName: this.configuration.name, cause: error },
        ),
      );
    }

    if (this.#isStale(generation)) {
      return;
    }

    if (port === undefined) {
      // Not an error: the user has simply never granted this device. The application has to
      // ask, from a gesture, and until then there is nothing to retry.
      this.#state = { kind: 'awaiting-permission' };
      this.#setStatus(SerialBrokerStatus.AwaitingPermission);
      return;
    }

    this.#state = { kind: 'opening', port };

    try {
      await withDeadline(port.open(this.#openOptions()), this.environment.clock, {
        timeoutMs: this.configuration.connection.openTimeoutMs,
        code: SerialBrokerErrorCode.OPEN_TIMEOUT,
        message: 'Opening the port did not complete in time',
        configName: this.configuration.name,
        context: { attempt },
        onTimeout: () => {
          // The open may still settle later and would then leave an open port nobody
          // tracks. Closing it is best-effort; failing to is not actionable.
          ignoreRejection(Promise.resolve(port.close()).catch(() => undefined));
        },
      });
    } catch (error) {
      if (this.#isStale(generation)) {
        return;
      }
      this.#handleConnectionLoss(
        'open-failed',
        mapOpenError(error, {
          configName: this.configuration.name,
          timestamp: this.environment.clock.now(),
          extra: { attempt },
        }),
      );
      return;
    }

    if (this.#isStale(generation)) {
      // Ownership or the configuration went away while the port was opening. Close what was
      // just opened rather than leaking it.
      ignoreRejection(Promise.resolve(port.close()).catch(() => undefined));
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

    this.#state = {
      kind: 'open',
      port,
      reader: readable.getReader(),
      writer: writable.getWriter(),
      // A streaming decoder per connection: a multi-byte character cannot span a disconnect,
      // so its state must not either. See ADR-0015.
      decoder: this.configuration.encoding.decodeText
        ? new TextDecoder(this.configuration.encoding.encoding)
        : undefined,
    };

    this.#backoff.recordConnected(this.environment.clock.now());
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

  #openOptions(): SerialOptions {
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

        if (value.byteLength > 0) {
          this.#deliver(value, state.decoder);
        }
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

  #deliver(chunk: Uint8Array, decoder: TextDecoder | undefined): void {
    // A copy, because the application may retain or mutate what it receives and the stream
    // may reuse its buffer. See docs/guidelines/defensive-programming.md.
    const data = new Uint8Array(chunk);
    this.#bytesReceived += data.byteLength;
    const text = decoder?.decode(chunk, { stream: true });
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
   */
  #handleConnectionLoss(reason: string, error: SerialBrokerError): void {
    const previous = this.#state;
    if (previous.kind === 'stopped' || previous.kind === 'reconnecting') {
      return;
    }

    this.#generation += 1;
    this.#openedAt = undefined;
    this.#report(error);
    this.#backoff.recordDisconnected(
      this.environment.clock.now(),
      this.configuration.connection.stableAfterMs,
    );

    if (previous.kind === 'open') {
      ignoreRejection(this.#closeConnection(previous));
    } else if (previous.kind === 'opening') {
      ignoreRejection(Promise.resolve(previous.port.close()).catch(() => undefined));
    }

    if (this.#backoff.hasExhausted(this.configuration.connection)) {
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
            cause: error,
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
        void this.#connect(this.#backoff.attempt);
      }
    }, delayMs);

    this.#nextAttemptAt = this.environment.clock.now() + delayMs;
    this.#state = { kind: 'reconnecting', timer };
    this.#setStatus(SerialBrokerStatus.Reconnecting);
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
    // `cancel` comes first because it stops the read loop and releases the reader's lock in
    // one step; `releaseLock` on a reader with a pending read throws instead.
    await this.#closeStep(state.reader.cancel(), 'cancelling the reader');
    await this.#closeStep(state.writer.abort(), 'aborting the writer');
    await this.#closeStep(Promise.resolve(state.port.close()), 'closing the port');
  }

  /**
   * Runs one teardown step, bounded and swallowing its failure.
   *
   * Teardown runs on paths where something has already gone wrong; a step that fails or hangs
   * must not prevent the remaining steps or the caller that is waiting for all of them.
   */
  async #closeStep(operation: Promise<unknown>, what: string): Promise<void> {
    try {
      await withDeadline(operation, this.environment.clock, {
        timeoutMs: this.configuration.connection.openTimeoutMs,
        code: SerialBrokerErrorCode.OPEN_TIMEOUT,
        message: `Timed out while ${what}`,
        configName: this.configuration.name,
      });
    } catch {
      // Expected when the device has already gone. The caller is tearing down precisely
      // because something is wrong and is already reporting why.
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
