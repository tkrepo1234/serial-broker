/**
 * serial-broker for Svelte 5: one configuration as reactive state and a handful of actions.
 *
 * This file is the integration. It depends on `svelte` and `serial-broker` and on nothing else in
 * the application, so it can be copied into any Svelte 5 project as it is:
 *
 * ```svelte
 * <script lang="ts">
 *   import { createSerialBroker } from './lib/serial-broker.svelte.ts';
 *
 *   const scale = createSerialBroker('Scale', {
 *     device: { vendorId: 0x0403, productId: 0x6001 },
 *     serial: { baudRate: 9600 },
 *     encoding: { decodeText: true },
 *   });
 * </script>
 *
 * <p>{scale.status}</p>
 * {#if scale.needsPermission}<button onclick={() => scale.connect()}>Connect</button>{/if}
 * ```
 *
 * Nothing here refers to tabs. Every tab runs the same code; serial-broker decides which tab
 * holds the port, and every tab sees the same status, receives the same data and can send.
 */
import {
  SerialBroker,
  SerialBrokerError,
  type SendableData,
  type SerialBrokerOptions,
  type SerialBrokerStatus,
  type Unsubscribe,
} from 'serial-broker';
import { untrack } from 'svelte';

/** Settings of {@link createSerialBroker} that are about this module, not about the device. */
export interface SerialBrokerSettings {
  /**
   * How many characters of received text {@link SerialBrokerConnection.received} keeps, oldest
   * dropped first. A tab on an operator's screen stays open for weeks.
   * @defaultValue 20000
   */
  readonly maxReceivedLength?: number;
  /**
   * Whether destroying the component that created the connection releases the configuration in
   * this tab.
   *
   * Leave it `true` when the component owns the device: without a release, the tab would keep
   * the port open - or keep its place in the queue - for a device nothing on the page shows any
   * more. Set it `false` when the configuration outlives the component, because other code in the
   * same tab uses it too: a release ends the configuration, and every subscription to it, for all
   * of the tab.
   *
   * @defaultValue true
   */
  readonly releaseOnDestroy?: boolean;
}

/** How a {@link SerialBrokerConnection.connect} ended. */
export type ConnectOutcome =
  /** A device is available: the port opens, or is open already. */
  | 'granted'
  /** The user closed the browser's port picker without choosing. A decision, not a failure. */
  | 'dismissed'
  /** The call failed; the reason is in {@link SerialBrokerConnection.error}. */
  | 'failed';

/**
 * One serial-broker configuration, as Svelte sees it.
 *
 * Every property is reactive: read it in markup, in `$derived` or in `$effect`, and Svelte
 * updates what depends on it. None of them can be assigned; the actions change them.
 */
export interface SerialBrokerConnection {
  /** The configuration name. */
  readonly name: string;
  /**
   * The status serial-broker reports, unchanged. Treat the set of values as growing: a later
   * version may add one, so fall through to something neutral for a value you do not know.
   *
   * `idle` until the configuration is registered, and `failed` when registering it failed.
   */
  readonly status: SerialBrokerStatus;
  /** Epoch milliseconds at which the current status was entered. */
  readonly since: number;
  /**
   * `true` while the configuration is set up in this tab - also in `failed`, which is why
   * {@link SerialBrokerConnection.restart} releases before it sets up again.
   */
  readonly isSetUp: boolean;
  /** `status === 'awaiting-permission'`: the one state in which a connect button belongs on screen. */
  readonly needsPermission: boolean;
  /**
   * `status === 'open'`. The library accepts a write in any status and holds it for the port up to
   * `connection.writeTimeoutMs`; a view that shows the status next to the send button says the
   * same thing sooner by disabling it.
   */
  readonly canSend: boolean;
  /**
   * The most recent error, or `null`. Branch on `code`, show `remediation`. `isRetryable` means the
   * library is already recovering and the status shows it: show such an error as a note, not as a
   * problem. A retryable error is cleared once the port is open again; any other stays until
   * {@link SerialBrokerConnection.clearError} or a restart.
   */
  readonly error: SerialBrokerError | null;
  /**
   * Everything received as text, capped at `maxReceivedLength`. Chunks are appended as they come:
   * a chunk is not a line, and the device's own line endings make the lines. Bytes arrive as text
   * with `encoding: { decodeText: true }`, and as hexadecimal without it.
   */
  readonly received: string;
  /** Bytes received since the configuration was last set up. */
  readonly receivedBytes: number;
  /** Bytes any tab sent to the device since the configuration was last set up. */
  readonly sentBytes: number;

  /**
   * Shows the browser's port picker.
   *
   * **Call it first thing in a click handler**, with no `await` before it: the browser shows the
   * picker only during the transient activation of a user gesture, and anything awaited first
   * uses the gesture up. Outside a gesture the call fails with `USER_GESTURE_REQUIRED`.
   *
   * @returns How it ended. A failure does not reject; it is in `error`, where a view shows it.
   */
  connect(): Promise<ConnectOutcome>;
  /**
   * Sends data to the device, from whichever tab holds the port. Nothing is appended: the line
   * ending is the application's decision.
   *
   * @returns `true` once the bytes were handed to the device, `false` when the write failed - the
   *   reason is in `error`.
   */
  send(data: SendableData): Promise<boolean>;
  /**
   * Stops using the configuration in this tab. The other tabs keep it, and one of them takes the
   * port over if this tab held it. The status ends at `released`.
   */
  release(): Promise<void>;
  /**
   * Starts over: releases the configuration if it is still set up, then sets it up again. The way
   * back from `released`, and from a `failed` that does not end by itself - `setup()` alone does
   * nothing for a name that is still set up.
   */
  restart(): Promise<void>;
  /** Clears `error`, for an error panel the user dismissed. */
  clearError(): void;
  /** Empties `received`. The device is not touched. */
  clearReceived(): void;
}

const DEFAULT_MAX_RECEIVED_LENGTH = 20_000;

/**
 * Releases still closing a port, by configuration name.
 *
 * A component that is destroyed and created again at once - a route left and entered, a `{#key}`
 * block, hot module replacement - releases the configuration and sets it up again. The release
 * resolves only once the port is closed, and the new setup waits for that rather than race it.
 */
const closing = new Map<string, Promise<void>>();

/**
 * Creates the reactive state of one configuration, and ties it to the component that calls it.
 *
 * **Call it while a component initialises** - at the top level of its `<script>`, like `$state`.
 * The configuration is set up when the component mounts, and on destroy the subscriptions end and,
 * unless `releaseOnDestroy` is `false`, the configuration is released in this tab. For a connection
 * that outlives every component, create it inside `$effect.root()`, whose cleanup ends it.
 *
 * `SerialBroker.configure({ workerUrl })` has to have run before, once for the page.
 *
 * @param name - The configuration name, the same in every tab.
 * @param options - Device, line settings, encoding - passed to `SerialBroker.setup()` unchanged,
 *   and the same in every tab. A `$state` object is fine: a plain copy is passed on.
 * @param settings - Settings of this module.
 * @returns The connection's state and actions.
 */
export function createSerialBroker(
  name: string,
  options: SerialBrokerOptions,
  settings: SerialBrokerSettings = {},
): SerialBrokerConnection {
  const connection = new ReactiveConnection(name, options, settings);
  $effect(() => {
    // Untracked: start() reads state, and an effect that tracked it would destroy and set up the
    // connection again on every status change.
    untrack(() => {
      void connection.start();
    });
    return () => {
      connection.destroy();
    };
  });
  return connection;
}

class ReactiveConnection implements SerialBrokerConnection {
  readonly name: string;

  #status = $state<SerialBrokerStatus>('idle');
  #since = $state(Date.now());
  #isSetUp = $state(false);
  // Raw: the error is a class instance to read, not an object to track field by field.
  #error = $state.raw<SerialBrokerError | null>(null);
  #received = $state('');
  #receivedBytes = $state(0);
  #sentBytes = $state(0);

  readonly #options: SerialBrokerOptions;
  readonly #maxReceivedLength: number;
  readonly #releaseOnDestroy: boolean;
  #subscriptions: Unsubscribe[] = [];
  #starting: Promise<void> | undefined;
  #destroyed = false;

  constructor(name: string, options: SerialBrokerOptions, settings: SerialBrokerSettings) {
    this.name = name;
    this.#options = options;
    this.#maxReceivedLength = settings.maxReceivedLength ?? DEFAULT_MAX_RECEIVED_LENGTH;
    this.#releaseOnDestroy = settings.releaseOnDestroy ?? true;
  }

  get status(): SerialBrokerStatus {
    return this.#status;
  }

  get since(): number {
    return this.#since;
  }

  get isSetUp(): boolean {
    return this.#isSetUp;
  }

  get needsPermission(): boolean {
    return this.#status === 'awaiting-permission';
  }

  get canSend(): boolean {
    return this.#status === 'open';
  }

  get error(): SerialBrokerError | null {
    return this.#error;
  }

  get received(): string {
    return this.#received;
  }

  get receivedBytes(): number {
    return this.#receivedBytes;
  }

  get sentBytes(): number {
    return this.#sentBytes;
  }

  /** Sets the configuration up and subscribes to it. A second call returns the first one's promise. */
  start(): Promise<void> {
    this.#starting ??= this.#start();
    return this.#starting;
  }

  connect(): Promise<ConnectOutcome> {
    // No `await` and nothing slow before this call: it has to run inside the click.
    return SerialBroker.requestAccess(this.name).then(
      (granted): ConnectOutcome => (granted ? 'granted' : 'dismissed'),
      (error: unknown): ConnectOutcome => {
        this.#report(error);
        return 'failed';
      },
    );
  }

  async send(data: SendableData): Promise<boolean> {
    try {
      await SerialBroker.send(this.name, data);
      return true;
    } catch (error) {
      this.#report(error);
      return false;
    }
  }

  async release(): Promise<void> {
    try {
      await this.#release();
    } catch (error) {
      this.#report(error);
    }
    // `released` is the configuration's last event and normally arrives through the subscription;
    // set here as well for a configuration that ended without one, such as a failed setup.
    this.#unsubscribe();
    this.#isSetUp = false;
    this.#applyStatus('released', Date.now());
  }

  async restart(): Promise<void> {
    this.#error = null;
    if (SerialBroker.exists(this.name)) {
      try {
        await this.#release();
      } catch (error) {
        this.#report(error);
        return;
      }
    }
    this.#unsubscribe();
    this.#starting = undefined;
    await this.start();
  }

  clearError(): void {
    this.#error = null;
  }

  clearReceived(): void {
    this.#received = '';
  }

  /** Ends the subscriptions and, with `releaseOnDestroy`, the configuration. Called on destroy. */
  destroy(): void {
    this.#destroyed = true;
    this.#unsubscribe();
    if (this.#releaseOnDestroy) {
      // After any setup still under way, so that it cannot finish after the release. Nothing is
      // left to show a failure to.
      void (this.#starting ?? Promise.resolve())
        .then(async () => {
          await this.#release();
        })
        .catch(() => undefined);
    }
  }

  async #start(): Promise<void> {
    try {
      // A previous connection of the same name - a component destroyed a moment ago - may still be
      // closing the port.
      await closing.get(this.name);
      if (this.#destroyed) {
        return;
      }
      // A plain copy: `options` may be a `$state` proxy, and a proxy cannot be passed between tabs.
      await SerialBroker.setup(this.name, $state.snapshot(this.#options) as SerialBrokerOptions);
    } catch (error) {
      // setup() fails for invalid options, and where there is no Web Serial at all - outside
      // Chromium, or outside https:// and localhost - with WEB_SERIAL_UNAVAILABLE.
      this.#report(error);
      this.#applyStatus('failed', Date.now());
      // Not remembered as done: restart() tries again.
      this.#starting = undefined;
      return;
    }
    if (this.#destroyed) {
      return;
    }

    this.#isSetUp = true;
    this.#receivedBytes = 0;
    this.#sentBytes = 0;
    this.#subscriptions = [
      SerialBroker.subscribe(this.name, 'onStatusChange', (event) => {
        this.#applyStatus(event.status, event.timestamp);
      }),
      SerialBroker.subscribe(this.name, 'onReceive', (event) => {
        this.#receivedBytes += event.data.byteLength;
        this.#append(event.text ?? `${toHex(event.data)} `);
      }),
      SerialBroker.subscribe(this.name, 'onSend', (event) => {
        // Fires in every tab for every write that reached the device, whichever tab issued it.
        this.#sentBytes += event.data.byteLength;
      }),
      SerialBroker.subscribe(this.name, 'onError', (event) => {
        // Failures no call answers for: the device unplugged, the port not opening.
        this.#report(event.error);
      }),
    ];
    // The status may have moved on between setup() resolving and the subscriptions above.
    const snapshot = SerialBroker.getStatus(this.name);
    this.#applyStatus(snapshot.status, snapshot.since);
  }

  /** Releases the configuration, and lets a setup of the same name wait until the port is closed. */
  async #release(): Promise<void> {
    const release = SerialBroker.release(this.name);
    closing.set(this.name, release);
    try {
      await release;
    } finally {
      if (closing.get(this.name) === release) {
        closing.delete(this.name);
      }
    }
  }

  #applyStatus(status: SerialBrokerStatus, since: number): void {
    this.#status = status;
    this.#since = since;
    if (status === 'released') {
      this.#isSetUp = false;
    }
    // The recovery a retryable error announced has succeeded; the note is out of date.
    if (status === 'open' && this.#error?.isRetryable === true) {
      this.#error = null;
    }
  }

  #append(text: string): void {
    this.#received = (this.#received + text).slice(-this.#maxReceivedLength);
  }

  #report(error: unknown): void {
    if (!(error instanceof SerialBrokerError)) {
      // Everything serial-broker reports is a SerialBrokerError. Anything else is a bug in the
      // application, and stays loud instead of turning into a message on the page.
      throw error;
    }
    this.#error = error;
  }

  #unsubscribe(): void {
    for (const unsubscribe of this.#subscriptions) {
      unsubscribe();
    }
    this.#subscriptions = [];
  }
}

/** Bytes as `1A 2B`, for data the configuration does not decode as text. */
function toHex(data: Uint8Array): string {
  return Array.from(data, (byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}
