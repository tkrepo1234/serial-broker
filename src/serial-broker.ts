import { SerialBrokerClient } from './client/serial-broker-client.js';
import type {
  ReleaseOptions,
  SendableData,
  SerialBrokerEventMap,
  SerialBrokerEventName,
  SerialBrokerGlobalOptions,
  SerialBrokerOptions,
  SerialBrokerStatusSnapshot,
  Unsubscribe,
} from './core/types.js';
import { createBrowserEnvironment, isSupported } from './environment/browser.js';

/**
 * The library's public surface.
 *
 * Everything is addressed by configuration name; no handles are returned that could outlive
 * their configuration or leak internals. Nothing here reveals which browsing context owns the
 * port, that a `SharedWorker` exists, or that a Web Lock is held - by design, so that those
 * choices stay changeable (ADR-0011).
 */
export interface SerialBrokerApi {
  setup(name: string, options: SerialBrokerOptions): Promise<void>;
  release(name: string, options?: ReleaseOptions): Promise<void>;
  releaseAll(options?: ReleaseOptions): Promise<void>;
  send(name: string, data: SendableData): Promise<void>;
  subscribe<TEvent extends SerialBrokerEventName>(
    name: string,
    event: TEvent,
    listener: (payload: SerialBrokerEventMap[TEvent]) => void,
  ): Unsubscribe;
  unsubscribe<TEvent extends SerialBrokerEventName>(
    name: string,
    event: TEvent,
    listener: (payload: SerialBrokerEventMap[TEvent]) => void,
  ): void;
  getStatus(name: string): SerialBrokerStatusSnapshot;
  exists(name: string): boolean;
  names(): readonly string[];
  requestAccess(name: string): Promise<boolean>;
  restore(): Promise<readonly string[]>;
  configure(options: SerialBrokerGlobalOptions): void;
  isSupported(): boolean;
  dispose(): Promise<void>;
}

let globalOptions: SerialBrokerGlobalOptions = {};
let instance: SerialBrokerClient | undefined;

/**
 * Builds the client on first use.
 *
 * Lazy because constructing it reads `navigator`, and merely importing this module in a
 * non-Chromium browser - or during server-side rendering - must not throw.
 */
function client(): SerialBrokerClient {
  instance ??= new SerialBrokerClient(
    createBrowserEnvironment({
      workerUrl: globalOptions.workerUrl,
      transport: globalOptions.transport,
      logger: globalOptions.logger,
    }),
  );
  return instance;
}

/**
 * Shared access to a serial port across every tab of an origin.
 *
 * One tab holds the physical port; every tab can read from it and write to it. When that tab
 * closes, another takes over automatically. When the device is unplugged or powered off, the
 * connection is re-established as soon as it comes back, with no application code.
 *
 * @example Connect to a card reader and print what it sends
 * ```ts
 * await SerialBroker.setup('CardReader', {
 *   device: { vendorId: 0x1a86, productId: 0x7523 },
 *   serial: { baudRate: 9600 },
 *   encoding: { decodeText: true },
 * });
 *
 * SerialBroker.subscribe('CardReader', 'onReceive', (event) => {
 *   console.log(event.text);
 * });
 *
 * // Needs a user gesture the first time; afterwards the browser remembers the device.
 * document.querySelector('#connect')?.addEventListener('click', () => {
 *   void SerialBroker.requestAccess('CardReader');
 * });
 *
 * await SerialBroker.send('CardReader', 'STATUS?');
 * ```
 */
export const SerialBroker: SerialBrokerApi = {
  /**
   * Registers a configuration and starts keeping it connected.
   *
   * If the browser already has permission for a matching device - because the user granted it
   * on an earlier visit - the port is opened immediately, with no prompt and no user gesture.
   * Otherwise the status becomes `awaiting-permission` and the application must call
   * {@link SerialBrokerApi.requestAccess} from a user gesture (ADR-0009).
   *
   * Calling this again with the same name and equivalent options is a no-op, so it is safe to
   * call on every page initialisation.
   *
   * @param name - Identifies this configuration in every other call. Must be non-empty, at
   *   most 128 characters, and free of control characters.
   * @param options - Device filter, line settings, and optionally reconnect and encoding
   *   behaviour.
   * @throws A {@link SerialBrokerError} with code `INVALID_ARGUMENT` when an option is
   *   invalid, `CONFIGURATION_CONFLICT` when the name is already set up with different device
   *   or line settings, or `WEB_SERIAL_UNAVAILABLE` when the browser cannot support it.
   * @example
   * ```ts
   * await SerialBroker.setup('Scale', {
   *   device: { vendorId: 0x0403, productId: 0x6001 },
   *   serial: { baudRate: 19200, parity: 'even' },
   *   connection: { maxDelayMs: 10_000 },
   * });
   * ```
   */
  async setup(name, options) {
    await client().setup(name, options);
  },

  /**
   * Stops using a configuration in this tab.
   *
   * Other tabs are unaffected: if one of them still has it set up, the port stays open and
   * ownership moves there if this tab happened to hold it.
   *
   * The browser's permission for the device is deliberately kept, so a later `setup()` needs
   * no prompt. Pass `{ forgetDevice: true }` to revoke it as well.
   *
   * Releasing a name that is not set up is a no-op.
   */
  async release(name, options) {
    await client().release(name, options);
  },

  /** Stops using every configuration in this tab. */
  async releaseAll(options) {
    await client().releaseAll(options);
  },

  /**
   * Sends data to the device.
   *
   * The write is performed by whichever tab currently owns the port; the caller does not have
   * to be that tab and cannot tell whether it is. Writes issued by one tab reach the device in
   * the order that tab issued them, and the bytes of one call are never interleaved with
   * another's. Writes from *different* tabs have no defined relative order (ADR-0013).
   *
   * @param name - The configuration name passed to {@link SerialBrokerApi.setup}.
   * @param data - Text, encoded as UTF-8, or raw bytes. Nothing is appended: no newline, no
   *   terminator. What you pass is what the device receives.
   * @returns A promise that resolves once the bytes have been handed to the device - not once
   *   the device has acted on them, which a serial port cannot report.
   * @throws A {@link SerialBrokerError} with code `UNKNOWN_CONFIGURATION`, `NOT_CONNECTED`,
   *   `WRITE_FAILED`, `WRITE_TIMEOUT`, or `OWNER_LOST_DURING_WRITE` when the owning tab closed
   *   mid-write and it is unknowable whether the device received the bytes.
   * @example
   * ```ts
   * await SerialBroker.send('Printer', 'INIT');
   * await SerialBroker.send('Printer', new Uint8Array([0x1b, 0x40]));
   * ```
   */
  async send(name, data) {
    await client().send(name, data);
  },

  /**
   * Registers a listener.
   *
   * | Event | Fires when |
   * | --- | --- |
   * | `onReceive` | A chunk arrives from the device, in every tab. Chunk boundaries carry no meaning - this library performs no framing (ADR-0002). |
   * | `onSend` | Bytes reach the device, in every tab. `origin` is `'local'` if this tab issued the write and `'remote'` if another one did. |
   * | `onError` | Anything goes wrong, in every tab that is affected. |
   * | `onStatusChange` | The connection status changes. |
   *
   * A listener that throws is reported through `onError` and does not prevent the other
   * listeners receiving the event.
   *
   * @returns A function that removes this listener. Calling it twice is harmless.
   * @throws A {@link SerialBrokerError} with code `UNKNOWN_CONFIGURATION` if `name` is not set
   *   up in this tab.
   * @example
   * ```ts
   * const stop = SerialBroker.subscribe('Scale', 'onReceive', (event) => {
   *   process(event.data);
   * });
   * // later
   * stop();
   * ```
   */
  subscribe(name, event, listener) {
    return client().subscribe(name, event, listener);
  },

  /**
   * Removes a listener registered with {@link SerialBrokerApi.subscribe}.
   *
   * Removing one that was never registered is a no-op.
   */
  unsubscribe(name, event, listener) {
    client().unsubscribe(name, event, listener);
  },

  /**
   * Returns a point-in-time view of a configuration.
   *
   * Synchronous and local: it reads a cached snapshot and never blocks. `observedAt` says when
   * the snapshot was taken, so a stale value is recognisable rather than misleading.
   *
   * @throws A {@link SerialBrokerError} with code `UNKNOWN_CONFIGURATION`.
   */
  getStatus(name) {
    return client().getStatus(name);
  },

  /** `true` if a configuration with this name is set up in this tab. */
  exists(name) {
    return client().exists(name);
  },

  /** Every configuration name set up in this tab. */
  names() {
    return client().names();
  },

  /**
   * Shows the browser's serial port picker.
   *
   * **Must be called synchronously from a user gesture handler.** The browser only shows the
   * picker during transient activation, and any `await` before this call will have consumed
   * it. Once the user grants a device, the permission persists across visits and this never
   * needs to be called again for that device.
   *
   * @returns `true` if a device is now available, `false` if the user dismissed the picker -
   *   a decision, not a failure, so it does not throw.
   * @throws A {@link SerialBrokerError} with code `USER_GESTURE_REQUIRED` when called outside
   *   a gesture, or `DEVICE_MISMATCH` when the chosen port is not the configured device.
   * @example
   * ```ts
   * connectButton.addEventListener('click', async () => {
   *   const granted = await SerialBroker.requestAccess('CardReader');
   *   connectButton.hidden = granted;
   * });
   * ```
   */
  async requestAccess(name) {
    return await client().requestAccess(name);
  },

  /**
   * Sets up every configuration persisted by an earlier visit.
   *
   * Call this once during initialisation to reconnect without knowing in advance which
   * devices the user has configured. Configurations already set up in this tab are skipped.
   *
   * @returns The names that were restored.
   */
  async restore() {
    return await client().restore();
  },

  /**
   * Applies library-wide settings.
   *
   * Must be called before the first {@link SerialBrokerApi.setup}: the settings are read when
   * the internal client is built, and calling it later has no effect on an existing one.
   *
   * @example
   * ```ts
   * SerialBroker.configure({
   *   workerUrl: '/assets/serial-broker.worker.js',
   *   logger: { log: (level, message, fields) => console[level](message, fields) },
   * });
   * ```
   */
  configure(options) {
    globalOptions = { ...globalOptions, ...options };
  },

  /**
   * `true` if this browser can support the library.
   *
   * Checks for Web Serial, Web Locks and a message bus. Use it to decide whether to offer a
   * device-connected feature at all, rather than discovering it at `setup()`.
   */
  isSupported() {
    return isSupported();
  },

  /**
   * Releases everything this tab holds.
   *
   * Rarely needed: a closing tab releases everything anyway, and ownership moves to another
   * tab automatically. Useful in single-page applications that tear down a feature area, and
   * in tests.
   */
  async dispose() {
    const current = instance;
    instance = undefined;
    await current?.dispose();
  },
};
