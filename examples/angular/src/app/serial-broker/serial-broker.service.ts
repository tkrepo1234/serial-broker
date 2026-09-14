import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import {
  isSerialBrokerError,
  REMEDIATION,
  SerialBroker,
  SerialBrokerErrorCode,
  type ReleaseOptions,
  type SendableData,
  type SerialBrokerStatus,
  type Unsubscribe,
} from 'serial-broker';

import { SERIAL_BROKER_CONFIGURATION } from './serial-broker.configuration';

/** One line of traffic, as {@link SerialBrokerService.lines} keeps it. */
export interface SerialLine {
  /** Unique within the service, increasing: a `track` expression for `@for`. */
  readonly id: number;
  /** `'in'` for what the device sent, `'out'` for what any tab sent to it. */
  readonly direction: 'in' | 'out';
  /**
   * The line without its line ending, or hexadecimal (`1A 2B`) for bytes that are not text.
   *
   * Without `encoding.decodeText`, the service cannot tell where a line ends: every received chunk
   * is one line of hexadecimal. A received text line longer than `maxLineLength` is split.
   */
  readonly text: string;
  /** For `'out'`: `true` when this tab sent it, `false` when another tab did. */
  readonly local: boolean;
  /** Epoch milliseconds, as the library reports them. */
  readonly timestamp: number;
}

/**
 * The most recent error, reduced to what a template shows.
 *
 * `code` is stable across versions - branch on it, never on `message`. `remediation` is one
 * sentence saying what to do, written for that code.
 */
export interface SerialErrorInfo {
  readonly code: SerialBrokerErrorCode;
  readonly message: string;
  readonly remediation: string;
  /** `true` when the library is already recovering: show it as a note, not as a problem. */
  readonly retryable: boolean;
  readonly timestamp: number;
}

const DEFAULT_MAX_LINES = 200;
const DEFAULT_MAX_LINE_LENGTH = 1024;

/**
 * Errors that belong to one `send()`: the command they concern may or may not have reached the
 * device, so they stay in `lastError` when the port opens again - the connection being back says
 * nothing about the command. The codes of "Writing" in the library's error reference.
 */
const WRITE_ERROR_CODES: ReadonlySet<SerialBrokerErrorCode> = new Set([
  SerialBrokerErrorCode.WRITE_TIMEOUT,
  SerialBrokerErrorCode.WRITE_FAILED,
  SerialBrokerErrorCode.WRITE_QUEUE_FULL,
  SerialBrokerErrorCode.OWNER_LOST_DURING_WRITE,
]);

/**
 * One serial-broker configuration as an Angular service: signals to read, methods to act.
 *
 * The service sets the configuration up as soon as it is created - on every page load, in every
 * tab, which is what the library expects - and keeps three signals in step with its events. A
 * template reads them; nothing has to subscribe, and nothing has to tell Angular that something
 * changed: a signal read in a template schedules change detection when it is set, with or
 * without zone.js.
 *
 * Nothing here refers to tabs. Every tab runs the same service; the library decides which one
 * holds the port, and every tab receives, sends and sees the same status.
 *
 * Provide it with `provideSerialBrokerConfiguration()`, after `provideSerialBroker()`.
 */
@Injectable()
export class SerialBrokerService {
  /** The configuration name this service runs. */
  readonly name: string;

  readonly #configuration = inject(SERIAL_BROKER_CONFIGURATION);
  readonly #maxLines = this.#configuration.maxLines ?? DEFAULT_MAX_LINES;
  readonly #maxLineLength = this.#configuration.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;

  readonly #status = signal<SerialBrokerStatus>('idle');
  readonly #lastError = signal<SerialErrorInfo | null>(null);
  readonly #lines = signal<readonly SerialLine[]>([]);
  readonly #partialLine = signal('');

  /**
   * The library's status, unchanged. Treat the set of values as growing: a later version may add
   * one, so a template falls through to something neutral for a value it does not know.
   */
  readonly status = this.#status.asReadonly();

  /**
   * The most recent error, from an event or from a call of this service, or `null`.
   *
   * Cleared when the port opens: whatever went wrong with the connection before, it is there now.
   * An error of a `send()` - `OWNER_LOST_DURING_WRITE`, `WRITE_FAILED`, `WRITE_TIMEOUT`,
   * `WRITE_QUEUE_FULL` - stays until it is dismissed, replaced or the service starts again: the
   * connection being back does not say whether the command reached the device.
   */
  readonly lastError = this.#lastError.asReadonly();

  /** Received and sent lines, oldest first, at most `maxLines`. */
  readonly lines = this.#lines.asReadonly();

  /**
   * What the device sent after its last line ending: a prompt, or a line still on its way. A
   * chunk is an arbitrary piece of the byte stream, not a line. Never longer than
   * `maxLineLength`, and always empty without `encoding.decodeText`.
   */
  readonly partialLine = this.#partialLine.asReadonly();

  #subscriptions: Unsubscribe[] = [];
  /** Received text not yet ended by a line ending, with a trailing `\r` kept for a `\n` to come. */
  #pending = '';
  #nextLineId = 1;
  /** Setting up, releasing and setting up again run one after another, never interleaved. */
  #operations: Promise<void> = Promise.resolve();
  #destroyed = false;

  constructor() {
    this.name = this.#configuration.name;
    inject(DestroyRef).onDestroy(() => {
      this.#destroy();
    });
    this.#enqueue(() => this.#setUp());
  }

  /**
   * Shows the browser's port picker.
   *
   * **Call it first thing in a click handler.** The browser shows its picker only during the
   * click, and an `await` before the call uses the click up; the call then fails with
   * `USER_GESTURE_REQUIRED`. A template's `(click)="serial.connect()"` is exactly right.
   *
   * @returns Resolves with `true` once a port is granted, `false` when the user closed the picker
   *   or the call failed. A failure is in {@link SerialBrokerService.lastError}.
   */
  connect(): Promise<boolean> {
    // No await before this call, deliberately: see above.
    return SerialBroker.requestAccess(this.name).then(
      (granted) => granted,
      (error: unknown) => {
        this.#report(error);
        return false;
      },
    );
  }

  /**
   * Sends data to the device, from whichever tab holds the port.
   *
   * A failure is shown in {@link SerialBrokerService.lastError} and rejects the promise too, so
   * that code sending commands can branch on the code - above all on `OWNER_LOST_DURING_WRITE`,
   * where only the application knows whether the command may be sent again.
   *
   * @param data - Text, encoded as UTF-8, or bytes. Nothing is appended: the line ending is the
   *   application's decision.
   * @returns Resolves once the bytes were handed to the device, not once it acted on them.
   */
  async send(data: SendableData): Promise<void> {
    try {
      await SerialBroker.send(this.name, data);
    } catch (error: unknown) {
      this.#report(error);
      throw error;
    }
  }

  /**
   * Stops using the configuration in this tab. The other tabs keep the device, and one of them
   * takes the port over if this tab held it. The status ends at `released`.
   *
   * It acts on the name for the whole tab: another service in this tab that provides the same name
   * loses the device too, without being told.
   *
   * @param options - `{ forgetDevice: true }` revokes the browser's permission as well, for every
   *   tab of the origin.
   */
  release(options?: ReleaseOptions): Promise<void> {
    return this.#enqueue(async () => {
      await this.#release(options);
      this.#status.set('released');
    });
  }

  /**
   * Starts over: releases the configuration in this tab if it is still set up, and sets it up
   * again. The way back after `released`, and after `failed`.
   *
   * A configuration that shows `failed` is usually still set up, and `setup()` does nothing for a
   * name that is already set up with the same options - so it is released first. After
   * `RECONNECT_EXHAUSTED` that is only a way to try sooner: the configuration comes back by itself
   * when the device is plugged in again. After `CONFIGURATION_CONFLICT` it is the way back.
   *
   * Like {@link SerialBrokerService.release}, it acts on the name for the whole tab.
   */
  restart(): Promise<void> {
    return this.#enqueue(async () => {
      this.#lastError.set(null);
      await this.#release();
      await this.#setUp();
    });
  }

  /** Empties {@link SerialBrokerService.lines}. The device is not touched. */
  clearLines(): void {
    this.#lines.set([]);
    this.#partialLine.set('');
    this.#pending = '';
  }

  /** Clears {@link SerialBrokerService.lastError}, for an error box the user has closed. */
  clearError(): void {
    this.#lastError.set(null);
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.#operations.then(operation);
    // The chain goes on after a failure; the caller still sees it.
    this.#operations = next.catch(() => undefined);
    return next;
  }

  async #setUp(): Promise<void> {
    if (this.#destroyed) {
      // Destroyed while this waited in the queue: set up, it would hold the device for nobody.
      return;
    }
    try {
      // Resolves once the configuration is registered, not once the port is open: opening may
      // need the user. Rejects where there is no Web Serial - outside Chromium, or outside
      // https:// and localhost - with WEB_SERIAL_UNAVAILABLE, whose remediation says so.
      await SerialBroker.setup(this.name, this.#configuration.options);
    } catch (error: unknown) {
      this.#report(error);
      this.#status.set('failed');
      return;
    }
    if (this.#destroyed) {
      return;
    }
    this.#subscribe();
    // The status may have moved on between setup() resolving and the subscriptions above.
    this.#applyStatus(SerialBroker.getStatus(this.name).status);
  }

  async #release(options?: ReleaseOptions): Promise<void> {
    this.#unsubscribe();
    try {
      // A no-op for a name that is not set up, such as after a setup() that failed.
      await SerialBroker.release(this.name, options);
    } catch (error: unknown) {
      this.#report(error);
    }
  }

  #subscribe(): void {
    this.#unsubscribe();
    this.#subscriptions = [
      SerialBroker.subscribe(this.name, 'onStatusChange', (event) => {
        this.#applyStatus(event.status);
      }),
      SerialBroker.subscribe(this.name, 'onReceive', (event) => {
        if (event.text === undefined) {
          // No text decoding: nothing says where a line ends, so every chunk is a line of its own.
          this.#appendLines([
            { direction: 'in', text: toHex(event.data), local: false, timestamp: event.timestamp },
          ]);
        } else {
          this.#receive(event.text, event.timestamp);
        }
      }),
      SerialBroker.subscribe(this.name, 'onSend', (event) => {
        // Every write that reached the device, from any tab: 'local' when this tab issued it.
        this.#appendLines([
          {
            direction: 'out',
            text: toDisplayText(event.data),
            local: event.origin === 'local',
            timestamp: event.timestamp,
          },
        ]);
      }),
      SerialBroker.subscribe(this.name, 'onError', (event) => {
        // Failures no call answers for: the device unplugged, the port not opening.
        this.#report(event.error);
      }),
    ];
  }

  #unsubscribe(): void {
    for (const unsubscribe of this.#subscriptions) {
      unsubscribe();
    }
    this.#subscriptions = [];
  }

  #applyStatus(status: SerialBrokerStatus): void {
    this.#status.set(status);
    const error = this.#lastError();
    if (status === 'open' && error !== null && !WRITE_ERROR_CODES.has(error.code)) {
      this.#lastError.set(null);
    }
  }

  #receive(chunk: string, timestamp: number): void {
    // The library does no framing, so lines are assembled here. A `\r` at the end of a chunk is
    // held back: the `\n` of a `\r\n` may come with the next chunk, and must not make a second,
    // empty line.
    const combined = this.#pending + chunk;
    const heldBack = combined.endsWith('\r') ? '\r' : '';
    const parts = combined.slice(0, combined.length - heldBack.length).split(/\r\n|\n|\r/u);
    let partial = parts.pop() ?? '';
    // A device that never sends a line ending - a scanner with no suffix, STX/ETX frames - would
    // otherwise grow the tail for as long as the screen stays open. Full lengths become lines.
    while (partial.length > this.#maxLineLength) {
      parts.push(partial.slice(0, this.#maxLineLength));
      partial = partial.slice(this.#maxLineLength);
    }
    this.#pending = partial + heldBack;
    this.#partialLine.set(partial);
    if (parts.length > 0) {
      this.#appendLines(
        parts.map((text) => ({ direction: 'in', text, local: false, timestamp }) as const),
      );
    }
  }

  #appendLines(lines: readonly Omit<SerialLine, 'id'>[]): void {
    const numbered = lines.map((line) => ({ ...line, id: this.#nextLineId++ }));
    this.#lines.update((kept) => [...kept, ...numbered].slice(-this.#maxLines));
  }

  #report(error: unknown): void {
    this.#lastError.set(toErrorInfo(error));
  }

  #destroy(): void {
    this.#destroyed = true;
    this.#unsubscribe();
    if (this.#configuration.releaseOnDestroy === true) {
      // Through the queue: a setup() or restart() under way finishes first, and is then released,
      // rather than setting the configuration up after this release. Nobody is left to tell about
      // a failure here.
      void this.#enqueue(() => SerialBroker.release(this.name).catch(() => undefined));
    }
  }
}

/** Bytes as `1A 2B`, for data that is not text. */
function toHex(data: Uint8Array): string {
  return Array.from(data, (byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

/** Sent bytes for the list: the text without its line ending, or hexadecimal if it is not text. */
function toDisplayText(data: Uint8Array): string {
  const text = new TextDecoder().decode(data).replace(/(\r\n|\n|\r)$/u, '');
  // Control characters other than tab and line feed - a carriage return left inside the text
  // included - or bytes that did not decode (U+FFFD): not text.
  return /[\u0000-\u0008\u000B-\u001F\u007F\uFFFD]/u.test(text) ? toHex(data) : text;
}

/**
 * Everything the library reports is a `SerialBrokerError` with a code and a remediation. Anything
 * else - a bug in the application - is shown under `UNKNOWN` rather than swallowed.
 */
function toErrorInfo(error: unknown): SerialErrorInfo {
  if (isSerialBrokerError(error)) {
    return {
      code: error.code,
      message: error.message,
      remediation: error.remediation,
      retryable: error.isRetryable,
      timestamp: error.timestamp,
    };
  }
  return {
    code: SerialBrokerErrorCode.UNKNOWN,
    message: error instanceof Error ? error.message : String(error),
    remediation: REMEDIATION.UNKNOWN,
    retryable: false,
    timestamp: Date.now(),
  };
}
