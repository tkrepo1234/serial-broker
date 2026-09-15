/**
 * One serial-broker configuration as a store React can subscribe to - and nothing about React.
 *
 * The store sets the configuration up when its first subscriber arrives, listens to the library
 * while anyone is subscribed, and stops listening when the last one leaves. React's
 * `useSyncExternalStore` pairs every subscribe with an unsubscribe - under StrictMode's doubled
 * effects and across hot updates alike - so the pairing the library needs is React's job, and this
 * file only has to count.
 *
 * There is one store per configuration name per tab, shared by every component that uses the name:
 * a status badge in the header and a terminal in the page see the same status and the same lines,
 * and a release in one is a release in the other, as it is in the library.
 */
import {
  isSerialBrokerError,
  SerialBroker,
  SerialBrokerError,
  SerialBrokerErrorCode,
  type ReleaseOptions,
  type SendableData,
  type SerialBrokerOptions,
  type SerialBrokerStatus,
  type Unsubscribe,
} from 'serial-broker';

/** One line the device sent. */
export interface SerialLine {
  /** Unique within the store, and kept when an incomplete line completes: a stable React key. */
  readonly id: number;
  /** The text, without its line ending. Bytes arrive as hexadecimal without `decodeText`. */
  readonly text: string;
  /** Epoch milliseconds at which the last chunk of this line was read. */
  readonly timestamp: number;
  /** `false` for the last line while the device has not ended it yet - a prompt, say. */
  readonly complete: boolean;
}

/** What a component renders: replaced as a whole on every change, never mutated. */
export interface SerialState {
  /**
   * The library's status, unchanged. `idle` until `setup()` has resolved, and `failed` when
   * `setup()` itself failed - `lastError` says why. Treat the set of values as growing.
   */
  readonly status: SerialBrokerStatus;
  /** The most recent error, from `onError` or from a call this store made; `null` if none. */
  readonly lastError: SerialBrokerError | null;
  /** Received lines, oldest first, at most `maxLines` of them plus the incomplete one. */
  readonly lines: readonly SerialLine[];
}

/** Settings for a store, beyond the library's own options. */
export interface SerialConnectionSettings {
  /**
   * How many complete lines to keep. A tab on an operator's screen stays open for weeks.
   * @defaultValue 500
   */
  readonly maxLines?: number | undefined;
  /**
   * How long a line may grow before it is cut, for a device that never sends a line ending.
   * Without `decodeText` every line is cut, since bytes carry no line ending, and the cut falls on
   * whole bytes: at most 333 of them, `999` characters, by default.
   * @defaultValue 1000
   */
  readonly maxLineLength?: number | undefined;
}

const LINE_ENDING = /\r\n|\r|\n/u;

/** Characters per byte in {@link toHex}'s output: two digits and a space. */
const HEX_WIDTH = 3;

function setUpOnce(name: string, options: SerialBrokerOptions): Promise<void> {
  return SerialBroker.setup(name, options);
}

/**
 * Sets a configuration up again, for `restart()`.
 *
 * `setup()` with the same options starts a `failed` configuration again, from any tab, and sets a
 * released one up anew. Two cases need a release first, because `setup()` alone cannot help: a tab
 * that withdrew with `CONFIGURATION_CONFLICT` over another `maxTabs` in the tab holding the port,
 * and options that open the port differently from the ones the name is set up with - which is how
 * `restart(options)` applies new ones.
 */
async function setUpAgain(name: string, options: SerialBrokerOptions): Promise<void> {
  if (SerialBroker.exists(name)) {
    const { status, lastErrorCode } = SerialBroker.getStatus(name);
    if (status === 'failed' && lastErrorCode === SerialBrokerErrorCode.CONFIGURATION_CONFLICT) {
      await SerialBroker.release(name);
    }
  }
  try {
    await SerialBroker.setup(name, options);
  } catch (error: unknown) {
    const refused =
      isSerialBrokerError(error) &&
      error.code === SerialBrokerErrorCode.CONFIGURATION_CONFLICT &&
      SerialBroker.exists(name);
    if (!refused) {
      throw error;
    }
    await SerialBroker.release(name);
    await SerialBroker.setup(name, options);
  }
}

/** The store for one configuration name. Obtain it with {@link getSerialConnection}. */
export class SerialConnection {
  readonly name: string;

  #options: SerialBrokerOptions;
  readonly #maxLines: number;
  readonly #maxLineLength: number;

  #state: SerialState = { status: 'idle', lastError: null, lines: [] };
  readonly #listeners = new Set<() => void>();
  #unsubscribes: Unsubscribe[] = [];
  /**
   * Bumped whenever what is under way is superseded - a stop, a release, a restart - so that a
   * `setup()` that resolves late does not subscribe for a subscriber who has left.
   */
  #generation = 0;
  /** Set by `release()` and cleared by `restart()`: a remount must not take the device back. */
  #released = false;

  #complete: SerialLine[] = [];
  #partial = '';
  #partialTimestamp = 0;
  #afterCarriageReturn = false;
  #nextLineId = 1;

  constructor(name: string, options: SerialBrokerOptions, settings: SerialConnectionSettings = {}) {
    this.name = name;
    this.#options = options;
    this.#maxLines = settings.maxLines ?? 500;
    this.#maxLineLength = settings.maxLineLength ?? 1000;
  }

  /** The current state. The same object until something changes, as `useSyncExternalStore` needs. */
  readonly getState = (): SerialState => this.#state;

  /**
   * Adds a change listener; the first one sets the configuration up and starts listening to it.
   *
   * @returns Removes the listener; removing the last one stops listening to the library. The
   *   configuration stays set up - leaving a page is not releasing a device.
   */
  readonly subscribe = (onChange: () => void): (() => void) => {
    this.#listeners.add(onChange);
    if (this.#listeners.size === 1) {
      this.#start();
    }
    return () => {
      if (this.#listeners.delete(onChange) && this.#listeners.size === 0) {
        this.#stop();
      }
    };
  };

  /**
   * Shows the browser's port picker.
   *
   * **Call it first thing in a click handler.** The browser shows the picker only during the
   * click, and an `await` before this call uses the click up. This method awaits nothing before
   * `requestAccess()` for the same reason.
   *
   * @returns `true` once a device is available, `false` when the user closed the picker or the
   *   call failed - the failure is in `lastError`.
   */
  readonly connect = (): Promise<boolean> =>
    SerialBroker.requestAccess(this.name).then(
      (granted) => granted,
      (error: unknown) => {
        this.#report(error);
        return false;
      },
    );

  /**
   * Sends data, from whichever tab holds the port. Nothing is appended: no line ending.
   *
   * @returns `true` once the bytes were handed to the device, `false` when the write failed - the
   *   failure is in `lastError`. `OWNER_LOST_DURING_WRITE` means the device may or may not have
   *   received them; decide per command whether to send it again.
   */
  readonly send = async (data: SendableData): Promise<boolean> => {
    try {
      await SerialBroker.send(this.name, data);
      return true;
    } catch (error: unknown) {
      this.#report(error);
      return false;
    }
  };

  /**
   * Stops using the configuration in this tab. Other tabs keep the device, and one of them takes
   * the port over. It stays released - across remounts too - until {@link SerialConnection.restart}.
   */
  readonly release = async (options?: ReleaseOptions): Promise<void> => {
    this.#generation += 1;
    this.#released = true;
    try {
      await SerialBroker.release(this.name, options);
    } catch (error: unknown) {
      this.#report(error);
    }
    // The library delivered `released` as the last event and removed the listeners itself;
    // unsubscribing again is harmless and keeps this store's bookkeeping honest.
    this.#detach();
    this.#update({ status: 'released' });
  };

  /**
   * Sets the configuration up again: after `released`, or to start over from `failed`. See
   * {@link setUpAgain} for when that releases first.
   *
   * @param options - Options to set up with from now on; the store's current ones otherwise.
   */
  readonly restart = async (options?: SerialBrokerOptions): Promise<void> => {
    this.#generation += 1;
    if (options !== undefined) {
      this.#options = options;
    }
    this.#released = false;
    this.#detach();
    this.#update({ status: 'idle', lastError: null });
    if (this.#listeners.size > 0) {
      this.#start(setUpAgain);
    }
  };

  /** Clears `lastError`, for an error the user has read. */
  readonly dismissError = (): void => {
    this.#update({ lastError: null });
  };

  /** @param setUp - How to set up: `setup()` itself, or {@link setUpAgain} for a restart. */
  #start(setUp = setUpOnce): void {
    if (this.#released) {
      this.#update({ status: 'released' });
      return;
    }
    this.#generation += 1;
    const generation = this.#generation;
    // Resolves once the configuration is registered, not once the port is open: opening may need
    // the user. Calling it again with the same options - another mount, a hot update - joins the
    // configuration that is set up, and leaves a working one alone.
    setUp(this.name, this.#options).then(
      () => {
        if (generation === this.#generation) {
          this.#attach();
        }
      },
      (error: unknown) => {
        if (generation === this.#generation) {
          // WEB_SERIAL_UNAVAILABLE outside Chromium or a secure context, CONFIGURATION_CONFLICT for
          // other options under the same name. Nothing is registered, so the library has no status
          // to report; `failed`, with the reason next to it, is what the user needs to see.
          this.#update({ status: 'failed', lastError: toSerialBrokerError(error, this.name) });
        }
      },
    );
  }

  #stop(): void {
    this.#generation += 1;
    this.#detach();
    // Nobody is listening from here on, so lines kept now would have a gap nobody could see.
    this.#complete = [];
    this.#partial = '';
    this.#afterCarriageReturn = false;
    this.#state = { ...this.#state, lines: [] };
  }

  #attach(): void {
    const { name } = this;
    try {
      this.#unsubscribes = [
        SerialBroker.subscribe(name, 'onStatusChange', (event) => {
          this.#onStatus(event.status);
        }),
        SerialBroker.subscribe(name, 'onReceive', (event) => {
          if (event.text === undefined) {
            this.#onReceive(toHex(event.data), event.timestamp, HEX_WIDTH);
          } else {
            this.#onReceive(event.text, event.timestamp, 1);
          }
        }),
        SerialBroker.subscribe(name, 'onError', (event) => {
          // Failures no call answers for: the device unplugged, the port not opening.
          this.#update({ lastError: event.error });
        }),
      ];
    } catch (error: unknown) {
      // Released by other code in this tab between setup() and here: UNKNOWN_CONFIGURATION.
      this.#detach();
      this.#report(error);
    }
  }

  #detach(): void {
    for (const unsubscribe of this.#unsubscribes) {
      unsubscribe();
    }
    this.#unsubscribes = [];
  }

  #onStatus(status: SerialBrokerStatus): void {
    // A retryable error is one the library was recovering from, and `open` means it has. Any other
    // error stays until it is dismissed: RECONNECT_EXHAUSTED or OWNER_LOST_DURING_WRITE happened,
    // even when the port is open again.
    const lastError = status === 'open' && this.#state.lastError?.isRetryable === true;
    this.#update(lastError ? { status, lastError: null } : { status });
  }

  /**
   * @param chunk - Decoded text, or bytes as `1A 2B ` triplets.
   * @param unit - Characters per unit that must not be cut: 1 for text, 3 for a byte's triplet.
   */
  #onReceive(chunk: string, timestamp: number, unit: number): void {
    if (chunk === '') {
      // Nothing to add, and a pending CR still waits for the LF that may follow it.
      return;
    }
    // A chunk is an arbitrary piece of the byte stream, not a line. A CR LF can be cut between two
    // chunks; its LF must not count as a second, empty line. That LF ends the CR LF, so the next
    // chunk's LF - even after a chunk that was only this one - is a line ending of its own.
    const lfOfCarriageReturn = this.#afterCarriageReturn && chunk.startsWith('\n');
    const text = lfOfCarriageReturn ? chunk.slice(1) : chunk;
    this.#afterCarriageReturn = text.endsWith('\r');

    const parts = `${this.#partial}${text}`.split(LINE_ENDING);
    this.#partial = parts.pop() ?? '';
    for (const part of parts) {
      this.#completeLine(part, timestamp);
    }
    // Bytes never contain a line ending, so they are always cut - at whole bytes, never between the
    // two digits of one.
    const cut = Math.max(unit, Math.floor(this.#maxLineLength / unit) * unit);
    while (this.#partial.length > cut) {
      this.#completeLine(this.#partial.slice(0, cut), timestamp);
      this.#partial = this.#partial.slice(cut);
    }
    this.#partialTimestamp = timestamp;

    const lines =
      this.#partial === ''
        ? this.#complete
        : [
            ...this.#complete,
            // The id the line will keep when it completes, so React keeps its element.
            {
              id: this.#nextLineId,
              text: this.#partial,
              timestamp: this.#partialTimestamp,
              complete: false,
            },
          ];
    this.#update({ lines });
  }

  #completeLine(text: string, timestamp: number): void {
    const line: SerialLine = { id: this.#nextLineId, text, timestamp, complete: true };
    this.#nextLineId += 1;
    this.#complete = [...this.#complete, line].slice(-this.#maxLines);
  }

  #report(error: unknown): void {
    this.#update({ lastError: toSerialBrokerError(error, this.name) });
  }

  #update(change: Partial<SerialState>): void {
    this.#state = { ...this.#state, ...change };
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

const connections = new Map<string, SerialConnection>();

/**
 * Returns the store for a configuration name, creating it on first use.
 *
 * The options are read when the store is created, and again by `restart(options)`. The library
 * sets a name up with one set of options per tab - other options under the same name are a
 * `CONFIGURATION_CONFLICT` - so a later call with other options does not reconfigure anything.
 */
export function getSerialConnection(
  name: string,
  options: SerialBrokerOptions,
  settings?: SerialConnectionSettings,
): SerialConnection {
  let connection = connections.get(name);
  if (connection === undefined) {
    connection = new SerialConnection(name, options, settings);
    connections.set(name, connection);
  }
  return connection;
}

/** Bytes as `1A 2B `, for a configuration without `encoding.decodeText`. */
function toHex(data: Uint8Array): string {
  return Array.from(data, (byte) => `${byte.toString(16).padStart(2, '0').toUpperCase()} `).join(
    '',
  );
}

/**
 * The library rejects only with `SerialBrokerError`; anything else - a bug further up - is kept
 * under `UNKNOWN`, with its remediation, rather than lost.
 */
function toSerialBrokerError(error: unknown, configName: string): SerialBrokerError {
  if (isSerialBrokerError(error)) {
    return error;
  }
  return new SerialBrokerError(
    SerialBrokerErrorCode.UNKNOWN,
    error instanceof Error ? error.message : String(error),
    { configName, cause: error },
  );
}
