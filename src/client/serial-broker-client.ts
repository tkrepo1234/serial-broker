import { copyBytes } from '../core/bytes.js';
import type { NormalizedConfiguration } from '../core/defaults.js';
import type { ParticipantDiagnostics } from '../core/diagnostics.js';
import { DisposalStack } from '../core/disposable.js';
import { SerialBrokerErrorCode } from '../core/error-codes.js';
import { describeUnknown, SerialBrokerError } from '../core/errors.js';
import type { ScopedLogger } from '../core/logger.js';
import type {
  ReleaseOptions,
  SendableData,
  SerialBrokerEventMap,
  SerialBrokerEventName,
  SerialBrokerOptions,
  SerialBrokerStatusSnapshot,
  Unsubscribe,
} from '../core/types.js';
import { isDeviceCompatible, normalizeConfiguration, validateName } from '../core/validation.js';
import type { SerialBrokerEnvironment } from '../environment/environment.js';
import { matchesDevice } from '../owner/port-matcher.js';
import { describeDecodeFailure, type DecodeFailure } from '../protocol/decode.js';
import type { ClientId, ProtocolMessage, RequestId } from '../protocol/messages.js';
import { PROTOCOL_VERSION } from '../protocol/version.js';
import { ConfigurationStore } from '../storage/configuration-store.js';

import { ConfigurationSession } from './configuration-session.js';
import type { Transport } from './transport/transport.js';

/**
 * One browsing context's view of every configuration it participates in.
 *
 * This is the class the public facade delegates to. It exists separately from the facade so
 * that a test can construct as many independent instances as it likes, each with its own
 * simulated environment - which is how the multi-tab scenarios are tested at all (ADR-0014).
 */
export class SerialBrokerClient {
  readonly #sessions = new Map<string, ConfigurationSession>();
  readonly #store: ConfigurationStore;
  readonly #disposal = new DisposalStack();
  readonly #clientId: ClientId;
  readonly #logger: ScopedLogger;

  #transport: Transport | undefined;
  #isDisposed = false;

  constructor(private readonly environment: SerialBrokerEnvironment) {
    this.#clientId = environment.newId('c') as ClientId;
    this.#logger = environment.logger.child({ clientId: this.#clientId });

    this.#store = new ConfigurationStore(environment.storage, this.#logger, (error) => {
      // Storage problems are never fatal: the library works in memory, it just will not
      // remember across a reload. Reporting it to every session is how an application learns.
      this.#reportGlobal(error);
    });
  }

  /** This context's identity on the bus. Diagnostics only; never exposed publicly. */
  get clientId(): string {
    return this.#clientId;
  }

  /** Which transport ended up being used. Diagnostics and tests only. */
  get transportKind(): 'sharedworker' | 'broadcastchannel' | undefined {
    return this.#transport?.kind;
  }

  /**
   * Describes this context and every configuration it has set up, for a diagnostics report.
   *
   * @returns `undefined` before the first `setup()`, when this context is not on the bus and
   *   has nothing to describe.
   */
  diagnostics(): ParticipantDiagnostics | undefined {
    const transport = this.#transport;
    if (transport === undefined) {
      return undefined;
    }
    return {
      clientId: this.#clientId,
      transport: transport.kind,
      protocolVersion: PROTOCOL_VERSION,
      reportedAt: this.environment.clock.now(),
      configurations: [...this.#sessions.values()].map((session) => session.diagnostics()),
    };
  }

  /**
   * Registers a configuration and starts keeping it connected.
   *
   * Idempotent for equal options. Calling it again with options that would change how the
   * port is opened is a conflict rather than a silent reconfiguration, because the port may
   * be open in another tab with the old settings.
   */
  async setup(name: unknown, options: unknown): Promise<void> {
    this.#assertUsable();

    const configuration = normalizeConfiguration(name, options);
    const existing = this.#sessions.get(configuration.name);

    if (existing !== undefined) {
      if (!isDeviceCompatible(existing.definition, configuration)) {
        throw new SerialBrokerError(
          SerialBrokerErrorCode.CONFIGURATION_CONFLICT,
          `"${configuration.name}" is already set up with different device or line settings`,
          {
            configName: configuration.name,
            context: {
              existing: existing.definition.device,
              requested: configuration.device,
            },
            timestamp: this.environment.clock.now(),
          },
        );
      }
      // Same device, same line settings: nothing to do. Re-running the connection would
      // interrupt a working port for no reason.
      return;
    }

    this.#requireSupport();

    const session = new ConfigurationSession(
      this.environment,
      this.#ensureTransport(),
      configuration,
      this.#logger.child({ configName: configuration.name }),
    );

    this.#sessions.set(configuration.name, session);
    this.#store.save(configuration);
    session.start();

    this.#logger.info('configuration registered', {
      configName: configuration.name,
      event: 'client.setup',
    });

    // `setup` is asynchronous so that a future version can await something here without a
    // breaking change, and so callers write `await setup(...)` from the start.
    await Promise.resolve();
  }

  /**
   * Restores configurations persisted by an earlier session.
   *
   * @returns The names that were restored.
   */
  async restore(): Promise<readonly string[]> {
    this.#assertUsable();

    const restored: string[] = [];
    for (const configuration of this.#store.load()) {
      if (this.#sessions.has(configuration.name)) {
        continue;
      }
      await this.setup(configuration.name, toOptions(configuration));
      restored.push(configuration.name);
    }

    if (restored.length > 0) {
      this.#logger.info('restored persisted configurations', {
        event: 'client.restore',
        count: restored.length,
      });
    }

    return restored;
  }

  /** Stops using a configuration in this context. */
  async release(name: unknown, options: ReleaseOptions = {}): Promise<void> {
    const validName = validateName(name);
    const session = this.#sessions.get(validName);
    if (session === undefined) {
      // Releasing something that is not set up is a no-op, not an error: it leaves the caller
      // in the state it asked for.
      return;
    }

    this.#sessions.delete(validName);
    // Removed before the wait, not after it: a `setup()` of the same name while the port closes
    // saves the new configuration, which removing afterwards would delete.
    this.#store.remove(validName);
    await session.release();

    // For the same reason, a configuration set up again meanwhile keeps its device permission.
    if (options.forgetDevice === true && !this.#sessions.has(validName)) {
      await this.#forgetDevice(session.definition);
    }

    this.#logger.info('configuration released', {
      configName: validName,
      event: 'client.release',
    });
  }

  /** Stops using every configuration in this context. */
  async releaseAll(options: ReleaseOptions = {}): Promise<void> {
    const names = [...this.#sessions.keys()];
    for (const name of names) {
      await this.release(name, options);
    }
  }

  /** Writes to a device. */
  async send(name: unknown, data: SendableData): Promise<void> {
    const session = this.#requireSession(validateName(name));
    await session.send(this.#toBytes(data, session.definition));
  }

  /** Registers an event listener. */
  subscribe<TEvent extends SerialBrokerEventName>(
    name: unknown,
    event: TEvent,
    listener: (payload: SerialBrokerEventMap[TEvent]) => void,
  ): Unsubscribe {
    const validName = validateName(name);
    const session = this.#requireSession(validName);

    if (typeof listener !== 'function') {
      throw new SerialBrokerError(
        SerialBrokerErrorCode.INVALID_ARGUMENT,
        'listener must be a function',
        { configName: validName, context: { argumentName: 'listener' } },
      );
    }

    session.subscribe(event, listener);

    return () => {
      this.#sessions.get(validName)?.unsubscribe(event, listener);
    };
  }

  /** Removes an event listener. */
  unsubscribe<TEvent extends SerialBrokerEventName>(
    name: unknown,
    event: TEvent,
    listener: (payload: SerialBrokerEventMap[TEvent]) => void,
  ): void {
    this.#sessions.get(validateName(name))?.unsubscribe(event, listener);
  }

  /** A point-in-time view of a configuration. */
  getStatus(name: unknown): SerialBrokerStatusSnapshot {
    return this.#requireSession(validateName(name)).getStatus();
  }

  /** `true` if a configuration is set up in this context. */
  exists(name: unknown): boolean {
    return this.#sessions.has(validateName(name));
  }

  /** Every configuration name set up in this context. */
  names(): readonly string[] {
    return [...this.#sessions.keys()];
  }

  /**
   * Shows the browser's port picker for a configuration.
   *
   * @returns `true` if a device is now available, `false` if the user dismissed the picker.
   * @throws A {@link SerialBrokerError} for anything other than a dismissal.
   */
  async requestAccess(name: unknown): Promise<boolean> {
    const session = this.#requireSession(validateName(name));

    try {
      await session.requestAccess();
      return true;
    } catch (error) {
      if (
        error instanceof SerialBrokerError &&
        error.code === SerialBrokerErrorCode.PERMISSION_DENIED
      ) {
        // A dismissed picker is a user decision, not a failure. Returning `false` lets the
        // caller offer the button again without writing a try/catch for the normal case.
        return false;
      }
      throw error;
    }
  }

  /** Releases everything this context holds. */
  async dispose(): Promise<void> {
    if (this.#isDisposed) {
      return;
    }
    this.#isDisposed = true;

    for (const session of this.#sessions.values()) {
      await session.release();
    }
    this.#sessions.clear();

    this.#transport?.close();
    this.#transport = undefined;
    this.#disposal.disposeAll();
  }

  // --- Internals ------------------------------------------------------------------------------

  #ensureTransport(): Transport {
    if (this.#transport !== undefined) {
      return this.#transport;
    }

    const transport = this.environment.createTransport({
      clientId: this.#clientId,
      onMessage: (message) => {
        this.#routeMessage(message);
      },
      onDecodeFailure: (failure) => {
        this.#handleDecodeFailure(failure);
      },
      onTransportError: (error) => {
        this.#reportGlobal(
          new SerialBrokerError(
            SerialBrokerErrorCode.BROKER_UNAVAILABLE,
            `The message bus reported a failure: ${describeUnknown(error)}`,
            { timestamp: this.environment.clock.now(), cause: error },
          ),
        );
      },
      logger: this.#logger,
    });

    this.#transport = transport;
    this.#disposal.add(() => {
      transport.close();
    });

    this.#listenForDeviceChanges();

    return transport;
  }

  /**
   * Routes device attach and detach events to the sessions they concern.
   *
   * Registered once per context rather than once per configuration: the platform fires these
   * on `navigator.serial` itself, and several configurations can watch the same device.
   */
  #listenForDeviceChanges(): void {
    const onConnect = (event: { readonly target: EventTarget | null }): void => {
      this.#forEachMatchingSession(event, (session) => {
        session.handleDeviceConnected();
      });
    };

    const onDisconnect = (event: { readonly target: EventTarget | null }): void => {
      this.#forEachMatchingSession(event, (session) => {
        session.handleDeviceDisconnected();
      });
    };

    this.environment.serial.addEventListener('connect', onConnect);
    this.environment.serial.addEventListener('disconnect', onDisconnect);

    this.#disposal.add(() => {
      this.environment.serial.removeEventListener('connect', onConnect);
      this.environment.serial.removeEventListener('disconnect', onDisconnect);
    });
  }

  #forEachMatchingSession(
    event: { readonly target: EventTarget | null },
    action: (session: ConfigurationSession) => void,
  ): void {
    const port = event.target as SerialPort | null;

    for (const session of this.#sessions.values()) {
      // A null target should not happen, but a device event with no port is better treated as
      // "might concern anything" than dropped: a missed disconnect stalls a connection.
      if (port === null || matchesDevice(port, session.definition)) {
        action(session);
      }
    }
  }

  #routeMessage(message: ProtocolMessage): void {
    if (message.type === 'diagnostics-request') {
      this.#answerDiagnostics(message.from, message.requestId);
      return;
    }

    const configName = 'configName' in message ? message.configName : undefined;
    if (configName === undefined) {
      return;
    }

    this.#sessions.get(configName)?.handleMessage(message);
  }

  /** Answers an observer. Reached only through the bus, so a transport exists. */
  #answerDiagnostics(observer: ClientId, requestId: RequestId): void {
    const report = this.diagnostics();
    if (report === undefined) {
      return;
    }
    this.#transport?.send({
      type: 'diagnostics-report',
      v: PROTOCOL_VERSION,
      from: this.#clientId,
      to: observer,
      requestId,
      report,
    });
  }

  #handleDecodeFailure(failure: DecodeFailure): void {
    const description = describeDecodeFailure(failure);

    if (failure.reason === 'version-mismatch') {
      // Loud, and exactly once per distinct peer version: a mixed deployment is a real
      // problem the application has to fix, and two groups may both try to own the device.
      this.#reportGlobal(
        new SerialBrokerError(
          SerialBrokerErrorCode.PROTOCOL_VERSION_MISMATCH,
          `Another tab runs an incompatible version of this library: ${description}`,
          {
            context: { theirVersion: failure.theirVersion },
            timestamp: this.environment.clock.now(),
          },
        ),
      );
      return;
    }

    this.#logger.warn('dropped a malformed message', {
      event: 'client.malformed-message',
      reason: description,
    });
  }

  /** Reports an error that is not tied to a single configuration. */
  #reportGlobal(error: SerialBrokerError): void {
    this.#logger.error(error.message, { event: 'client.error', code: error.code });

    for (const session of this.#sessions.values()) {
      session.reportExternalError(error);
    }
  }

  #requireSession(name: string): ConfigurationSession {
    const session = this.#sessions.get(name);
    if (session === undefined) {
      throw new SerialBrokerError(
        SerialBrokerErrorCode.UNKNOWN_CONFIGURATION,
        `No configuration named "${name}" is set up in this context`,
        {
          configName: name,
          context: { known: [...this.#sessions.keys()] },
          timestamp: this.environment.clock.now(),
        },
      );
    }
    return session;
  }

  #toBytes(data: SendableData, configuration: NormalizedConfiguration): Uint8Array {
    if (typeof data === 'string') {
      // `TextEncoder` only produces UTF-8. For any other configured encoding the caller has
      // to encode the bytes itself - silently sending the wrong bytes would be worse than
      // saying so.
      if (configuration.encoding.encoding !== 'utf-8') {
        throw new SerialBrokerError(
          SerialBrokerErrorCode.INVALID_ARGUMENT,
          `String payloads can only be encoded as UTF-8; "${configuration.encoding.encoding}" is configured. Encode the bytes yourself and pass a Uint8Array.`,
          {
            configName: configuration.name,
            context: { argumentName: 'data', encoding: configuration.encoding.encoding },
          },
        );
      }
      return new TextEncoder().encode(data);
    }

    return copyBytes(data);
  }

  async #forgetDevice(configuration: NormalizedConfiguration): Promise<void> {
    try {
      const ports = await this.environment.serial.getPorts();
      for (const port of ports) {
        if (matchesDevice(port, configuration)) {
          await port.forget();
        }
      }
    } catch (error) {
      // `forget()` is newer than the rest of Web Serial and is absent in older Chromium.
      // Failing to revoke a permission is not a reason to fail the release.
      this.#logger.warn('could not revoke the device permission', {
        configName: configuration.name,
        event: 'client.forget-failed',
        reason: describeUnknown(error),
      });
    }
  }

  #assertUsable(): void {
    if (this.#isDisposed) {
      throw new SerialBrokerError(
        SerialBrokerErrorCode.CONFIGURATION_RELEASED,
        'This SerialBroker client has been disposed',
        { timestamp: this.environment.clock.now() },
      );
    }
  }

  /**
   * Fails early and specifically when the platform cannot support the library.
   *
   * Checked at `setup()` rather than at construction, so that merely importing the library in
   * a non-Chromium browser does not throw.
   */
  #requireSupport(): void {
    if (typeof this.environment.serial.getPorts !== 'function') {
      throw new SerialBrokerError(
        SerialBrokerErrorCode.WEB_SERIAL_UNAVAILABLE,
        'This browser does not expose the Web Serial API',
        { timestamp: this.environment.clock.now() },
      );
    }

    if (typeof this.environment.locks.request !== 'function') {
      throw new SerialBrokerError(
        SerialBrokerErrorCode.WEB_LOCKS_UNAVAILABLE,
        'This browser does not expose the Web Locks API',
        { timestamp: this.environment.clock.now() },
      );
    }
  }
}

/** Turns a normalised configuration back into the options `setup()` accepts. */
function toOptions(configuration: NormalizedConfiguration): SerialBrokerOptions {
  return {
    device:
      configuration.device.kind === 'usb'
        ? { vendorId: configuration.device.vendorId, productId: configuration.device.productId }
        : { any: true },
    serial: configuration.serial,
    connection: configuration.connection,
    encoding: configuration.encoding,
    persist: configuration.persist,
  };
}
