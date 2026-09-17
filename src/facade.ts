import { SerialBrokerClient } from './client/serial-broker-client.js';
import { withTimestamp } from './core/errors.js';
import type {
  ReleaseOptions,
  RequestAccessOptions,
  SendableData,
  SerialBrokerEventMap,
  SerialBrokerEventName,
  SerialBrokerGlobalOptions,
  SerialBrokerOptions,
  SerialBrokerStatusSnapshot,
  Unsubscribe,
} from './core/types.js';
import {
  normalizeGlobalOptions,
  normalizeReleaseOptions,
  validateName,
} from './core/validation.js';
import {
  BROWSER_CLOCK,
  createBrowserEnvironment,
  isSupported as isPlatformSupported,
} from './environment/browser.js';

/**
 * Reports whether this browser can support the library at all.
 *
 * The same check as {@link SerialBrokerApi.isSupported}, callable without the singleton.
 *
 * A function of its own rather than a re-export of the environment's: the published declaration of
 * a re-export imports the declarations of the module it comes from, and the environment is the
 * injection seam this library reserves the right to change (ADR-0014).
 */
export function isSupported(): boolean {
  return isPlatformSupported();
}

/**
 * The library's public surface.
 *
 * Everything is addressed by configuration name; no handles are returned that could outlive
 * their configuration or leak internals. Nothing here reveals which browsing context owns the
 * port, that a `SharedWorker` exists, or that a Web Lock is held - by design, so that those
 * choices stay changeable (ADR-0011).
 *
 * The documentation lives on this interface rather than on the {@link SerialBroker} object,
 * because the interface is the contract: it is what an IDE shows, what a consumer implements
 * against in a test double, and what SemVer covers.
 */
export interface SerialBrokerApi {
  /**
   * Registers a configuration and starts keeping it connected.
   *
   * If the browser already has permission for a matching device - because the user granted it
   * on an earlier visit - the port is opened immediately, with no prompt and no user gesture.
   * Otherwise the status becomes `awaiting-permission` and the application must call
   * {@link SerialBrokerApi.requestAccess} from a user gesture (ADR-0009).
   *
   * Without a `device`, or with `device: { auto: true }`, the configuration is in **auto mode**:
   * it waits with `awaiting-permission` until `requestAccess()` opens the picker with no filter,
   * and takes its device from the port the user chooses - its USB IDs, or the fact that it has
   * none. The device is remembered with the configuration, reported by `getStatus()`, and adopted
   * by the other tabs that set the name up in auto mode (ADR-0036). On a later visit this call
   * takes the device from the configuration remembered under the same name, so it reconnects
   * without a prompt, like an explicit one, whether or not `restore()` ran first. A `device` passed
   * here, or `resolved`, wins over what is remembered; so does `remember: false`, which uses nothing
   * remembered.
   *
   * Calling this again with the same name and equivalent options is a no-op, so it is safe to
   * call on every page initialisation. Calling it with options that would open the port
   * differently is a conflict rather than a silent reconfiguration, because the port may be
   * open in another tab with the old settings. Auto mode never conflicts with auto mode, nor
   * with an explicit device while it has resolved to nothing.
   *
   * In one tab a name is one configuration, whichever code set it up: a second call joins it, and
   * one `release()` ends it for every caller. A second call with equivalent options leaves a
   * working configuration alone, and starts a `failed` one again - in whichever tab it is made, since
   * a tab that does not hold the port asks the tab that does (ADR-0010). A tab that withdrew over a
   * different `maxTabs` stays `failed` until it is released.
   *
   * @param name - Identifies this configuration in every other call. Must be non-empty, at
   *   most 128 characters, and free of control characters.
   * @param options - Line settings, and optionally a device filter and reconnect and encoding
   *   behaviour.
   * @returns A promise that resolves once the configuration is registered. It does **not**
   *   wait for the connection: watch `onStatusChange` for that.
   * @throws A `SerialBrokerError` with code `INVALID_ARGUMENT` when an option is invalid,
   *   `CONFIGURATION_CONFLICT` when the name is already set up with different device or line
   *   settings or a different `maxTabs`, or `WEB_SERIAL_UNAVAILABLE`, `WEB_LOCKS_UNAVAILABLE`,
   *   `TRANSPORT_UNAVAILABLE` or `BROKER_UNAVAILABLE` when the browser cannot support it. Nothing is
   *   registered when it rejects.
   * @example The device the user chooses in the picker
   * ```ts
   * await SerialBroker.setup('Scale', { serial: { baudRate: 19_200 } });
   * // ... from a click, the first time:
   * await SerialBroker.requestAccess('Scale');
   * ```
   * @example A USB device named by its IDs
   * ```ts
   * await SerialBroker.setup('Scale', {
   *   device: { vendorId: 0x0403, productId: 0x6001 },
   *   serial: { baudRate: 19_200, parity: 'even' },
   *   connection: { maxDelayMs: 10_000 },
   * });
   * ```
   * @example Any port with no USB identity - a built-in RS-232 interface, a virtual COM port
   * ```ts
   * await SerialBroker.setup('PanelPort', {
   *   device: { nonUsb: true },
   *   serial: { baudRate: 9600 },
   * });
   * ```
   */
  setup(name: string, options: SerialBrokerOptions): Promise<void>;

  /**
   * Stops using a configuration in this tab.
   *
   * Other tabs are unaffected: if one of them still has it set up, the port stays open and
   * ownership moves there if this tab happened to hold it. Pending writes are rejected rather
   * than left hanging.
   *
   * The status `released` is delivered through `onStatusChange` as the configuration's last event,
   * and this tab's listeners for the name are removed with it: subscribe again after the next
   * `setup()`.
   *
   * **Nothing is forgotten.** The configuration remembered under this name stays, so `restore()`
   * and a later `setup()` bring it back, and the browser's permission for the device is kept, so
   * neither needs a prompt. Forgetting is a decision of its own: `{ forget: true }` removes the
   * remembered configuration, `{ forgetDevice: true }` revokes the browser's permission, and the
   * two together remove every trace of the configuration in this browser.
   *
   * `{ forget: true }` removes the entry only once no tab still runs the configuration with
   * `remember: true` - it is one entry per name for the whole origin (ADR-0033) - and does nothing
   * for a configuration set up with `remember: false`, which has nothing stored under its name.
   *
   * @param name - The configuration name. One that is not set up in this tab has nothing to
   *   disconnect from, and this does nothing - except what `forget` or `forgetDevice` ask for,
   *   which is about what the browser stores rather than about this tab, and happens either way.
   * @param options - Whether to also forget the remembered configuration, and whether to revoke the
   *   browser's device permission. Read once, when the call is made.
   * @throws A `SerialBrokerError` with code `INVALID_ARGUMENT` for an invalid name, for `options`
   *   that is not an object, or for a `forget` or `forgetDevice` that is not a boolean. Nothing is
   *   released then.
   * @returns A promise that resolves once the port has been closed and the lock released.
   *   Teardown is bounded: a device that has stopped answering cannot hold it open.
   * @example
   * ```ts
   * await SerialBroker.release('Scale');
   * await SerialBroker.release('Scale', { forget: true });
   * await SerialBroker.release('Scale', { forget: true, forgetDevice: true });
   * ```
   */
  release(name: string, options?: ReleaseOptions): Promise<void>;

  /**
   * Stops using every configuration in this tab.
   *
   * Forgets nothing by default, as {@link SerialBrokerApi.release} does.
   *
   * @param options - Applied to each configuration in turn, `forget` and `forgetDevice` alike.
   * @throws A `SerialBrokerError` with code `INVALID_ARGUMENT` when `options` is not an object or
   *   `forget` or `forgetDevice` is not a boolean. Nothing is released then.
   */
  releaseAll(options?: ReleaseOptions): Promise<void>;

  /**
   * Sends data to the device.
   *
   * The write is performed by whichever tab currently owns the port; the caller does not have
   * to be that tab and cannot tell whether it is. If no connection is available yet, the write
   * waits for one rather than failing immediately - bounded by `connection.writeTimeoutMs`.
   *
   * Writes issued by one tab reach the device in the order that tab issued them, and the bytes
   * of one call are never interleaved with another's. Writes from *different* tabs have no
   * defined relative order (ADR-0013).
   *
   * @param name - The configuration name passed to {@link SerialBrokerApi.setup}.
   * @param data - Text, encoded as UTF-8, or raw bytes. Nothing is appended: no newline, no
   *   terminator. What you pass is what the device receives.
   * @returns A promise that resolves once the browser has taken the bytes for the port - into its
   *   transmit buffer of `serial.bufferSize` bytes - not once the device has received them, which
   *   Web Serial does not report. A device that has stopped taking data fails a write with
   *   `WRITE_TIMEOUT` only once that buffer is full (ADR-0038).
   * @throws A `SerialBrokerError` with code `UNKNOWN_CONFIGURATION`, `INVALID_ARGUMENT` for a
   *   string while an `encoding` other than UTF-8 is configured or for more than 16 MiB of data,
   *   `WRITE_FAILED`, `WRITE_TIMEOUT`, `WRITE_QUEUE_FULL` when the tab holding the port already
   *   keeps as many waiting writes as it may, `CONFIGURATION_RELEASED` when the configuration is released while the write waits,
   *   `CONFIGURATION_CONFLICT` once this tab has withdrawn because the tab holding the port runs
   *   a different `maxTabs`, or `OWNER_LOST_DURING_WRITE` when the owning tab closed mid-write
   *   and it is unknowable whether the device received the bytes. The library never retries
   *   that last case on its own.
   * @example
   * ```ts
   * await SerialBroker.send('Printer', 'INIT');
   * await SerialBroker.send('Printer', new Uint8Array([0x1b, 0x40]));
   * ```
   */
  send(name: string, data: SendableData): Promise<void>;

  /**
   * Registers an event listener.
   *
   * | Event | Fires when |
   * | --- | --- |
   * | `onReceive` | The tab holding the port delivers what the device sent, collected until the line is quiet (`receive`, ADR-0039), in every tab. Delivery boundaries carry no meaning - this library performs no framing (ADR-0002). |
   * | `onSend` | The browser took bytes for the port, in every tab. `origin` is `'local'` if this tab issued the write and `'remote'` if another one did. |
   * | `onError` | Anything goes wrong, in every tab that is affected. |
   * | `onStatusChange` | The connection status changes. A new listener is also told the current status once, right after `subscribe()` returns, with `previousStatus` equal to `status`. |
   *
   * A listener that throws is reported through `onError` and does not prevent the other
   * listeners receiving the event. Registering the same function twice has no extra effect.
   *
   * @param name - The configuration name.
   * @param event - Which event to listen for.
   * @param listener - Called with the event payload. Must not assume it runs on any particular
   *   tab: every tab receives the same events.
   * @returns A function that removes this listener. Calling it twice is harmless.
   * @throws A `SerialBrokerError` with code `UNKNOWN_CONFIGURATION` if `name` is not set up in
   *   this tab, or `INVALID_ARGUMENT` if `event` is not one of the four events or `listener` is
   *   not a function.
   * @example
   * ```ts
   * const stop = SerialBroker.subscribe('Scale', 'onReceive', (event) => {
   *   process(event.data);
   * });
   * // later
   * stop();
   * ```
   */
  subscribe<TEvent extends SerialBrokerEventName>(
    name: string,
    event: TEvent,
    listener: (payload: SerialBrokerEventMap[TEvent]) => void,
  ): Unsubscribe;

  /**
   * Removes a listener registered with {@link SerialBrokerApi.subscribe}.
   *
   * Provided for code that keeps its callbacks in fields rather than holding the unsubscribe
   * function. Removing a listener that was never registered is a no-op, as is removing one
   * from a configuration that is not set up.
   *
   * @param name - The configuration name.
   * @param event - The event it was registered for.
   * @param listener - The exact function reference that was registered.
   */
  unsubscribe<TEvent extends SerialBrokerEventName>(
    name: string,
    event: TEvent,
    listener: (payload: SerialBrokerEventMap[TEvent]) => void,
  ): void;

  /**
   * Returns a point-in-time view of a configuration.
   *
   * Synchronous and local: it reads a cached snapshot and never blocks. `observedAt` says when
   * the snapshot was taken, so a stale value is recognisable rather than misleading. The
   * snapshot describes the *connection* and never the coordination - which tab owns the port
   * is deliberately not representable (ADR-0011).
   *
   * @param name - The configuration name.
   * @returns A frozen snapshot. Treat the `status` union as extensible: handle an unrecognised
   *   value gracefully rather than throwing.
   * @throws A `SerialBrokerError` with code `UNKNOWN_CONFIGURATION`.
   * @example
   * ```ts
   * const { status, lastErrorCode } = SerialBroker.getStatus('Scale');
   * if (status === 'failed') showReconnectButton(lastErrorCode);
   * ```
   */
  getStatus(name: string): SerialBrokerStatusSnapshot;

  /**
   * Reports whether a configuration with this name is set up **in this tab**.
   *
   * Says nothing about other tabs: a configuration another tab is using is not visible here
   * until this tab sets it up too.
   *
   * `false` again once the name is released in this tab, and for a name only another tab has set
   * up: this asks about this tab, not about the origin.
   *
   * @throws A `SerialBrokerError` with code `INVALID_ARGUMENT` if the name is not a valid one.
   */
  exists(name: string): boolean;

  /** Every configuration name set up in this tab, in registration order. */
  names(): readonly string[];

  /**
   * Shows the browser's serial port picker.
   *
   * **Must be called synchronously from a user gesture handler.** The browser only shows the
   * picker during transient activation, and any `await` before this call will have consumed
   * it. Once the user grants a device, the permission persists across visits and this never
   * needs to be called again for that device.
   *
   * The picker is pre-filtered to the configured device, or to the device a configuration in
   * auto mode has resolved to. It is unfiltered for a configuration that accepts any port or
   * only ports without USB identity, and for one in auto mode that has not resolved yet - which
   * then takes its device from the port chosen, and remembers it (ADR-0036).
   *
   * Allowed in any tab taking part in the configuration: the permission belongs to the origin. In a
   * tab that does not hold the port, the tab holding it looks for the granted port again and opens
   * it - in auto mode with the device chosen here. `setup()` and `requestAccess()` may follow each
   * other in one click.
   *
   * **Choosing a different device.** With `{ chooseAgain: true }`, a configuration in auto mode opens
   * the picker unfiltered even though it has a device, and the port the user chooses becomes the
   * device of every tab, remembered as the first choice was. The tab holding the port closes the old
   * device and opens the new one, from any tab and while the connection is open. Dismissing the
   * picker changes nothing.
   *
   * @param name - The configuration name.
   * @param options - Whether to choose the device again. Read once, when the call is made.
   * @returns `true` if a device is now available, `false` if the user dismissed the picker - a
   *   decision, not a failure, so it does not throw.
   * @throws A `SerialBrokerError` with code `UNKNOWN_CONFIGURATION`, `USER_GESTURE_REQUIRED` when
   *   called outside a gesture, `DEVICE_MISMATCH` when the chosen port is not the configured
   *   device, `PERMISSION_REQUIRED` when this tab is `queued` under `maxTabs` or withdrew from the
   *   configuration, or `INVALID_ARGUMENT` for options that are not an object, a `chooseAgain` that
   *   is not a boolean, or `chooseAgain` for a configuration that names its device - set that one up
   *   with the other device instead.
   * @example
   * ```ts
   * connectButton.addEventListener('click', async () => {
   *   const granted = await SerialBroker.requestAccess('CardReader');
   *   connectButton.hidden = granted;
   * });
   * ```
   * @example A different adapter on the line, in auto mode
   * ```ts
   * changeDeviceButton.addEventListener('click', () => {
   *   void SerialBroker.requestAccess('Scale', { chooseAgain: true });
   * });
   * ```
   */
  requestAccess(name: string, options?: RequestAccessOptions): Promise<boolean>;

  /**
   * Sets up every configuration remembered by an earlier visit (`remember`, on by default).
   *
   * Call this once during initialisation to reconnect without knowing in advance which devices
   * the user has configured. Configurations already set up in this tab are skipped, and an
   * entry that no longer validates is discarded rather than failing the whole restore.
   *
   * A page that names its own devices does not need this: calling `setup()` with the same options
   * reconnects just as silently, and a device named explicitly is taken from those options rather
   * than from what was remembered. This is for configurations the page does not know in advance -
   * ones a user created, or a device chosen through the picker in auto mode.
   *
   * @returns The names that were restored.
   * @example
   * ```ts
   * const restored = await SerialBroker.restore();
   * console.info(`reconnecting to ${restored.length} device(s)`);
   * ```
   */
  restore(): Promise<readonly string[]>;

  /**
   * Applies library-wide settings.
   *
   * Must be called **before any other method**: the settings are read when the internal client
   * is built, by the first call that needs one. Called afterwards, it logs a warning
   * (`facade.late-configure`), and its settings apply only after {@link SerialBrokerApi.dispose}.
   * `exists`, `names`, `unsubscribe`, `release`, `releaseAll` and `isSupported` build no client
   * while nothing is
   * set up.
   *
   * @param options - Merged into the current settings; omitted fields are left alone. Each field is
   *   read once, now.
   * @throws A `SerialBrokerError` with code `INVALID_ARGUMENT` when `options` is not an object, or
   *   a field has the wrong type: `workerUrl` not a non-empty string or `URL`, `transport` not one of
   *   the three kinds, `logger` without a `log` method, `logPayloads` not a boolean. Nothing is
   *   applied then.
   * @example
   * ```ts
   * SerialBroker.configure({
   *   workerUrl: '/assets/serial-broker.worker.js',
   *   logger: { log: (level, message, fields) => console[level](message, fields) },
   * });
   * ```
   */
  configure(options: SerialBrokerGlobalOptions): void;

  /**
   * Reports whether this browser can support the library at all.
   *
   * Checks for Web Serial, Web Locks and a message bus, a `SharedWorker` or a `BroadcastChannel`.
   * Browsers offer Web Serial and Web Locks only in a secure context, so that is checked as well.
   * Use it to decide whether to offer a device-connected feature, rather than discovering the
   * problem at `setup()`.
   */
  isSupported(): boolean;

  /**
   * Releases everything this tab holds.
   *
   * Rarely needed: a closing tab releases everything anyway, and ownership moves to another tab
   * automatically. Useful in single-page applications that tear down a feature area, and in
   * tests. A later `setup()` builds a fresh client.
   */
  dispose(): Promise<void>;
}

let globalOptions: SerialBrokerGlobalOptions = {};
let instance: SerialBrokerClient | undefined;
/**
 * The `dispose()` still closing what the previous client held, if one is under way.
 *
 * `dispose()` lets go of its client at once, so that a call made meanwhile starts afresh. Closing
 * the ports takes longer. `release()`, `releaseAll()` and `dispose()` promise to resolve once the
 * ports are closed, so a call to one of them made meanwhile waits for this as well.
 */
let disposing: Promise<void> | undefined;

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
      logPayloads: globalOptions.logPayloads,
    }),
  );
  return instance;
}

/**
 * Runs a check from core code, filling in the time of the error it throws (see `withTimestamp`).
 *
 * The client does the same for the checks it runs; these are the ones the facade runs itself,
 * before or without a client.
 */
function checked<T>(check: () => T): T {
  try {
    return check();
  } catch (error) {
    throw withTimestamp(error, BROWSER_CLOCK.now());
  }
}

/**
 * Shared access to a serial port across every tab of an origin.
 *
 * One tab holds the physical port; every tab can read from it and write to it. When that tab
 * closes - or crashes - another takes over automatically. When the device is unplugged or
 * powered off, the connection is re-established as soon as it comes back, with no application
 * code.
 *
 * See {@link SerialBrokerApi} for what each method does.
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
  /** {@inheritDoc SerialBrokerApi.setup} */
  async setup(name, options) {
    await client().setup(name, options);
  },

  /** {@inheritDoc SerialBrokerApi.release} */
  async release(name, options) {
    if (instance === undefined) {
      // Nothing is set up here, so there is nothing to disconnect from. Forgetting is not about
      // this tab, though - it is about what the browser stores, and it is promised either way
      // (ADR-0033) - so a client is built when, and only when, something is asked to be
      // forgotten. Without that there is no reason to build one, and building one throws in a
      // browser without Web Serial. A disposal under way may still be closing the port.
      const asked = checked(() => {
        validateName(name);
        return normalizeReleaseOptions(options);
      });
      await disposing;
      if (!asked.forget && !asked.forgetDevice) {
        return;
      }
      await client().release(name, asked);
      return;
    }
    // Checked, and read once, before anything is released: an invalid value must leave the
    // configuration running, and the client reads the options only after the port has closed.
    await instance.release(
      name,
      checked(() => normalizeReleaseOptions(options)),
    );
  },

  /** {@inheritDoc SerialBrokerApi.releaseAll} */
  async releaseAll(options) {
    const releaseOptions = checked(() => normalizeReleaseOptions(options));
    await instance?.releaseAll(releaseOptions);
    await disposing;
  },

  /** {@inheritDoc SerialBrokerApi.send} */
  async send(name, data) {
    await client().send(name, data);
  },

  /** {@inheritDoc SerialBrokerApi.subscribe} */
  subscribe(name, event, listener) {
    return client().subscribe(name, event, listener);
  },

  /** {@inheritDoc SerialBrokerApi.unsubscribe} */
  unsubscribe(name, event, listener) {
    if (instance === undefined) {
      // Nothing is set up, so no listener can be registered - and building a client to find
      // that out would throw in a browser without Web Serial.
      checked(() => validateName(name));
      return;
    }
    instance.unsubscribe(name, event, listener);
  },

  /** {@inheritDoc SerialBrokerApi.getStatus} */
  getStatus(name) {
    return client().getStatus(name);
  },

  /** {@inheritDoc SerialBrokerApi.exists} */
  exists(name) {
    if (instance === undefined) {
      // Checked like every other facade validation, so that the error it throws carries the time
      // it arose rather than core code's missing clock (see `withTimestamp`).
      checked(() => {
        validateName(name);
      });
      return false;
    }
    return instance.exists(name);
  },

  /** {@inheritDoc SerialBrokerApi.names} */
  names() {
    return instance?.names() ?? [];
  },

  /** {@inheritDoc SerialBrokerApi.requestAccess} */
  async requestAccess(name, options) {
    return await client().requestAccess(name, options);
  },

  /** {@inheritDoc SerialBrokerApi.restore} */
  async restore() {
    return await client().restore();
  },

  /** {@inheritDoc SerialBrokerApi.configure} */
  configure(options) {
    // Validated and copied now: the client reads the settings only when it is built, which may be
    // long after this call, and must find the values that were checked.
    const validated = checked(() => normalizeGlobalOptions(options));
    globalOptions = { ...globalOptions, ...validated };
    // The client has already read the settings it was built with. Silence would leave an
    // application wondering why its worker URL or logger is not used.
    instance?.logger.warn(
      'configure() was called after serial-broker started; the settings apply after dispose()',
      { event: 'facade.late-configure', options: Object.keys(validated).join(', ') },
    );
  },

  /** {@inheritDoc SerialBrokerApi.isSupported} */
  isSupported() {
    return isSupported();
  },

  /** {@inheritDoc SerialBrokerApi.dispose} */
  async dispose() {
    const current = instance;
    instance = undefined;
    if (current !== undefined) {
      const run = Promise.all([disposing, current.dispose()]).then(() => undefined);
      const settled = (): void => {
        if (disposing === run) {
          disposing = undefined;
        }
      };
      disposing = run;
      run.then(settled, settled);
    }
    await disposing;
  },
};
