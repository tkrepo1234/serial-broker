/**
 * serial-broker as a Vue 3 composable: one configuration, mirrored into refs a template can read.
 *
 * This file is the integration. It depends on `vue` and `serial-broker` and on nothing else in this
 * application, so it can be copied into any Vue 3 project as it is. The application around it only
 * shows what the refs hold.
 *
 * Nothing here refers to tabs. Every tab runs the same code; serial-broker decides which of them
 * holds the port, and every tab receives the same data and can send.
 */
import {
  SerialBroker,
  SerialBrokerError,
  SerialBrokerErrorCode,
  isSerialBrokerError,
  type ReleaseOptions,
  type SendableData,
  type SerialBrokerOptions,
  type SerialBrokerStatus,
  type Unsubscribe,
} from 'serial-broker';
import { computed, onScopeDispose, ref, shallowRef, type ComputedRef, type Ref } from 'vue';

/** One line of traffic: something the device sent, or something a tab sent to it. */
export interface SerialLine {
  /** Unique within one composable, for `v-for` keys. */
  readonly id: number;
  /** `'received'` for data from the device, `'sent'` for data any tab wrote to it. */
  readonly direction: 'received' | 'sent';
  /** The line without its line ending. Bytes that are not text are shown as hexadecimal. */
  readonly text: string;
  /** Epoch milliseconds, as serial-broker reported the chunk or the write. */
  readonly timestamp: number;
  /** For `'sent'`: `true` when this tab issued the write, `false` when another tab did. */
  readonly local: boolean;
}

/** How the composable itself behaves. The configuration's own options go to `setup()` unchanged. */
export interface UseSerialBrokerSettings {
  /**
   * How many lines `lines` keeps, newest last. A tab on an operator's screen stays open for weeks,
   * so the list is capped rather than left to grow.
   * @defaultValue 500
   */
  readonly maxLines?: number;
  /**
   * Release the configuration when the effect scope ends - usually when the component that called
   * the composable is unmounted - unless another composable of this tab still uses the name then.
   *
   * Leave it `false` when the device outlives the component: releasing and setting up again on
   * every route change interrupts the port for nothing, and a closing tab releases everything
   * anyway. Set it `true` for a component that owns a device for a while, such as a dialog for a
   * one-off scan.
   * @defaultValue false
   */
  readonly releaseOnDispose?: boolean;
}

/** What {@link useSerialBroker} returns. Read-only refs, and the actions that change them. */
export interface UseSerialBroker {
  /** The serial-broker status, unchanged. Treat the set of values as growing. */
  readonly status: Readonly<Ref<SerialBrokerStatus>>;
  /** `true` while the configuration is set up in this tab: after `setup()`, until `released`. */
  readonly isSetUp: Readonly<Ref<boolean>>;
  /** `status` is `'open'`: a write reaches the device now rather than waiting for the port. */
  readonly canSend: ComputedRef<boolean>;
  /**
   * The most recent error, or `null`. Cleared when the port opens. Show `code` and `remediation`;
   * when `isRetryable` is `true` the library is already recovering and the status shows it.
   */
  readonly lastError: Readonly<Ref<SerialBrokerError | null>>;
  /** Received and sent lines, newest last, capped at `maxLines`. */
  readonly lines: Readonly<Ref<readonly SerialLine[]>>;
  /** Received text after the last line ending: a line the device has not finished yet. */
  readonly partialLine: Readonly<Ref<string>>;
  /**
   * Shows the browser's port picker. **Call it synchronously from a click handler** - see the
   * function for why.
   */
  connect(): Promise<boolean>;
  /** Writes to the device, from whichever tab holds the port. Nothing is appended. */
  send(data: SendableData): Promise<boolean>;
  /**
   * Stops using the configuration in this tab. Other tabs keep the device; every composable of
   * this name in this tab shows `released`.
   */
  release(options?: ReleaseOptions): Promise<void>;
  /**
   * Sets the configuration up again: after `released`, or to start over after `failed`. Every
   * composable of this name in this tab follows the new configuration.
   */
  restart(): Promise<void>;
  /** Empties `lines` and `partialLine`. The device is not touched. */
  clearLines(): void;
  /** Sets `lastError` to `null`, for an error box the user has closed. */
  clearError(): void;
}

const DEFAULT_MAX_LINES = 500;
/** A device that never sends a line ending still produces lines, of at most this many characters. */
const MAX_PARTIAL_LINE_LENGTH = 4096;

/** One composable, as the others of its name see it. */
interface ConfigurationUser {
  /** Another composable set the name up again: follow the configuration that exists now. */
  followNewConfiguration(): void;
}

/**
 * The live composables of this tab, by configuration name. The library keeps one configuration per
 * name in a tab, so a release by one composable ends it for all of them. A set-up again by one has
 * to reach the others as well, and a composable that goes away must not release a device the
 * others still show.
 */
const usersByName = new Map<string, Set<ConfigurationUser>>();

/**
 * Sets up a serial-broker configuration and mirrors it into refs.
 *
 * Call it from `<script setup>` or any other effect scope. It starts setting the configuration up
 * at once and returns without waiting: the refs start at `idle` and follow the library from there.
 * When the scope ends, the composable unsubscribes, and releases the configuration only if
 * `releaseOnDispose` is set and no other composable of this tab uses the name.
 *
 * Several components may call it with the same name and equivalent options. They share one
 * configuration: `setup()` is a no-op the second time, each composable receives every event, a
 * `release()` in one shows `released` in all of them, and a `restart()` in one brings all of them
 * back.
 *
 * `name` and `options` are read once. A different device is a different configuration name.
 *
 * `SerialBroker.configure({ workerUrl })` has to have run before the first call - in `main.ts`,
 * before `createApp()` - because the library reads it when it builds its internals.
 *
 * @param name - The configuration name, the same in every tab: non-empty, at most 128 characters.
 * @param options - Device filter, line settings and encoding, passed to `SerialBroker.setup()`
 *   unchanged.
 * @param settings - How the composable behaves; see {@link UseSerialBrokerSettings}.
 * @returns Read-only refs and actions. Actions never reject: a failure is put into `lastError`,
 *   and the action resolves with `false` (or, for `release` and `restart`, with nothing).
 * @example
 * ```ts
 * const { status, lastError, lines, canSend, connect, send } = useSerialBroker('Scale', {
 *   device: { vendorId: 0x0403, productId: 0x6001 },
 *   serial: { baudRate: 19_200 },
 *   encoding: { decodeText: true },
 * });
 * ```
 */
export function useSerialBroker(
  name: string,
  options: SerialBrokerOptions,
  settings: UseSerialBrokerSettings = {},
): UseSerialBroker {
  const maxLines = settings.maxLines ?? DEFAULT_MAX_LINES;

  const status = ref<SerialBrokerStatus>('idle');
  const isSetUp = ref(false);
  // Shallow: an error and a list of lines are replaced, never changed in place, so Vue does not
  // need to make every field of every line reactive - which matters at a device's data rate.
  const lastError = shallowRef<SerialBrokerError | null>(null);
  const lines = shallowRef<readonly SerialLine[]>([]);
  const partialLine = ref('');
  const canSend = computed(() => status.value === 'open');

  let subscriptions: Unsubscribe[] = [];
  let nextLineId = 1;
  let disposed = false;
  /**
   * The configuration this composable followed was released - here or by another composable of
   * the name - so a set-up by any of them is one to follow. A set-up that failed on its own, with
   * a `CONFIGURATION_CONFLICT` say, is not: the configuration that exists is not the one it asked
   * for.
   */
  let followedReleased = false;
  /** The latest start, so that dispose can release after a `setup()` still under way. */
  let starting: Promise<void> = Promise.resolve();

  const user: ConfigurationUser = { followNewConfiguration };
  const users = usersByName.get(name) ?? new Set<ConfigurationUser>();
  users.add(user);
  usersByName.set(name, users);

  function report(error: unknown): void {
    lastError.value = toSerialBrokerError(error, name);
  }

  function setStatus(value: SerialBrokerStatus): void {
    status.value = value;
    // The connection is fine again, so whatever went wrong on the way there is over. An error
    // that happens while open - a write that timed out, say - stays until the next time.
    if (value === 'open') {
      lastError.value = null;
    }
    if (value === 'released') {
      // `released` is the configuration's last event; the subscriptions end with it.
      unsubscribe();
      isSetUp.value = false;
      followedReleased = true;
    }
  }

  function appendLines(added: readonly SerialLine[]): void {
    if (added.length > 0) {
      lines.value = [...lines.value, ...added].slice(-maxLines);
    }
  }

  function line(
    direction: SerialLine['direction'],
    text: string,
    timestamp: number,
    local = false,
  ): SerialLine {
    return { id: nextLineId++, direction, text, timestamp, local };
  }

  function onReceive(text: string, timestamp: number): void {
    // A chunk is an arbitrary piece of the byte stream - serial-broker does no framing - so lines
    // are assembled here. A CR at the very end is held back: its LF may be in the next chunk.
    const parts = `${partialLine.value}${text}`.split(/\r\n|\n|\r(?!$)/u);
    let rest = parts.pop() ?? '';
    const complete = parts.map((part) => line('received', part, timestamp));
    if (rest.length > MAX_PARTIAL_LINE_LENGTH) {
      complete.push(line('received', rest, timestamp));
      rest = '';
    }
    appendLines(complete);
    partialLine.value = rest;
  }

  function subscribe(): void {
    unsubscribe();
    subscriptions = [
      SerialBroker.subscribe(name, 'onStatusChange', (event) => {
        setStatus(event.status);
      }),
      SerialBroker.subscribe(name, 'onReceive', (event) => {
        // `text` exists with `encoding: { decodeText: true }`; without it, the bytes are shown.
        onReceive(event.text ?? `${toHex(event.data)}\n`, event.timestamp);
      }),
      SerialBroker.subscribe(name, 'onSend', (event) => {
        // Every write that reached the device, from every tab - `origin` says whose it was.
        appendLines([
          line('sent', describeSent(event.data), event.timestamp, event.origin === 'local'),
        ]);
      }),
      SerialBroker.subscribe(name, 'onError', (event) => {
        // Failures no call answers for: the device unplugged, the port not opening.
        report(event.error);
      }),
    ];
  }

  function unsubscribe(): void {
    for (const stop of subscriptions) {
      stop();
    }
    subscriptions = [];
  }

  /**
   * Follows the configuration that is set up under `name` now. `false`, with the error shown, when
   * there is none any more.
   */
  function attach(): boolean {
    try {
      subscribe();
      // The status may have changed between setup() and the subscriptions.
      const current = SerialBroker.getStatus(name).status;
      followedReleased = false;
      isSetUp.value = true;
      setStatus(current);
      return true;
    } catch (error: unknown) {
      // Released between setup() resolving and here - by another composable of the name, say -
      // which throws UNKNOWN_CONFIGURATION. That is a configuration that went away: `failed`
      // shows Try again, and a set-up by another composable brings this one back.
      unsubscribe();
      isSetUp.value = false;
      followedReleased = true;
      report(error);
      status.value = 'failed';
      return false;
    }
  }

  async function start(): Promise<void> {
    try {
      // Resolves once the configuration is registered, not when the port is open: opening may
      // need the user's click (see connect). Rejects where there is no Web Serial - outside
      // Chromium, or outside https:// and localhost - with a code and a remediation to show.
      await SerialBroker.setup(name, options);
    } catch (error: unknown) {
      if (!disposed) {
        report(error);
        status.value = 'failed';
      }
      return;
    }
    if (disposed || !attach()) {
      return;
    }
    // A configuration set up again, after a release that every composable of the name received:
    // the others follow it too, instead of showing `released` next to an open port.
    for (const other of usersByName.get(name) ?? []) {
      if (other !== user) {
        other.followNewConfiguration();
      }
    }
  }

  function followNewConfiguration(): void {
    // A composable still subscribed already follows it; one whose own set-up is under way attaches
    // when that set-up resolves, and attaching twice only renews the subscriptions.
    if (disposed || !followedReleased) {
      return;
    }
    // The error belonged to the configuration that was released, as it does after restart().
    lastError.value = null;
    attach();
  }

  function connect(): Promise<boolean> {
    // requestAccess() has to be called synchronously from the click. The browser shows its port
    // picker only during the click's transient activation, and an `await` before this line uses
    // it up - the call then fails with USER_GESTURE_REQUIRED. So: no `await` above, and the
    // caller's click handler calls connect() first thing.
    return SerialBroker.requestAccess(name).then(
      // `false` is not a failure: the user closed the picker without choosing a port.
      (granted) => granted,
      (error: unknown) => {
        report(error);
        return false;
      },
    );
  }

  async function send(data: SendableData): Promise<boolean> {
    try {
      // Resolves once the bytes were handed to the device, whichever tab holds the port. A write
      // issued while the port is not open waits for it, up to connection.writeTimeoutMs.
      await SerialBroker.send(name, data);
      return true;
    } catch (error: unknown) {
      // Read `lastError.value.code` right after a `false` to decide what to do - above all for
      // OWNER_LOST_DURING_WRITE, where only the application knows whether a command may be
      // sent twice.
      report(error);
      return false;
    }
  }

  async function release(releaseOptions?: ReleaseOptions): Promise<void> {
    try {
      await SerialBroker.release(name, releaseOptions);
    } catch (error: unknown) {
      report(error);
      return;
    }
    setStatus('released');
  }

  async function restart(): Promise<void> {
    // A configuration that shows `failed` is still set up, and setup() does nothing for a name
    // that is set up - so it is released first. That is the library's own remediation for
    // RECONNECT_EXHAUSTED and CONFIGURATION_CONFLICT.
    if (safeExists(name)) {
      await release();
    }
    lastError.value = null;
    status.value = 'idle';
    starting = start();
    await starting;
  }

  starting = start();

  // Called from <script setup>, the scope is the component's, and this runs when it is unmounted.
  // Vue warns in development when the composable is called outside any effect scope, where
  // nothing would ever unsubscribe.
  onScopeDispose(() => {
    disposed = true;
    unsubscribe();
    users.delete(user);
    if (users.size === 0 && usersByName.get(name) === users) {
      usersByName.delete(name);
    }
    if (settings.releaseOnDispose === true) {
      // After a setup() still under way, so the release does not come before the registration.
      // Checked then, not now: a component re-created in the same tick - a changed `:key`, hot
      // module replacement - has registered by then and keeps the device instead of losing it.
      // Fire and forget: nobody is left to show a failure to.
      void starting
        .then(async () => {
          if (!usersByName.has(name)) {
            await SerialBroker.release(name);
          }
        })
        .catch(() => undefined);
    }
  });

  return {
    status,
    isSetUp,
    canSend,
    lastError,
    lines,
    partialLine,
    connect,
    send,
    release,
    restart,
    clearLines: () => {
      lines.value = [];
      partialLine.value = '';
    },
    clearError: () => {
      lastError.value = null;
    },
  };
}

/**
 * Everything serial-broker reports is a `SerialBrokerError`. Anything else - a bug in the
 * application's own code, say - is wrapped under `UNKNOWN` rather than swallowed, so a template
 * has one shape to show.
 */
function toSerialBrokerError(error: unknown, name: string): SerialBrokerError {
  if (isSerialBrokerError(error)) {
    return error;
  }
  return new SerialBrokerError(
    SerialBrokerErrorCode.UNKNOWN,
    error instanceof Error ? error.message : String(error),
    { configName: name, cause: error },
  );
}

/** `exists()` throws for a name that is not valid; such a name is not set up either. */
function safeExists(name: string): boolean {
  try {
    return SerialBroker.exists(name);
  } catch {
    return false;
  }
}

/** Bytes as `1A 2B`, for data that is not text. */
function toHex(data: Uint8Array): string {
  return Array.from(data, (byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

/** A write, for the traffic list: its text without the line ending, or hexadecimal. */
function describeSent(data: Uint8Array): string {
  const text = new TextDecoder().decode(data).replace(/(\r\n|\n|\r)$/u, '');
  // Control characters other than tab and line endings, or bytes that are not UTF-8 (which the
  // decoder turns into U+FFFD). Written as escapes, so the file stays printable text.
  return /[\u0000-\u0008\u000B-\u001F\u007F\uFFFD]/u.test(text) ? toHex(data) : text;
}
