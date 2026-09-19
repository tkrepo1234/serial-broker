import { SerialBroker, type Unsubscribe } from 'serial-broker';

/** How lines are separated and how long one may grow. */
export interface LineOptions {
  /** What ends a line. Nothing is appended or stripped by serial-broker, so say what the device sends. */
  readonly separator?: string;
  /**
   * The longest line the device sends, in characters. Text that grows beyond it without a separator
   * is noise - a wrong baud rate, a device in another mode - and is discarded instead of kept.
   */
  readonly maxLineLength?: number;
  /** Told how many characters were discarded, and why. */
  readonly onDiscarded?: (length: number, reason: 'too-long' | 'after-gap') => void;
}

/**
 * Turns text, however it was split into deliveries, into complete lines. Bounded: it never holds more
 * than `maxLineLength` characters of an unfinished line.
 */
export class LineSplitter {
  readonly #separator: string;
  readonly #maxLineLength: number;
  readonly #onDiscarded: NonNullable<LineOptions['onDiscarded']>;
  #pending = '';

  constructor(options: LineOptions = {}) {
    this.#separator = options.separator ?? '\r\n';
    this.#maxLineLength = options.maxLineLength ?? 1_024;
    this.#onDiscarded = options.onDiscarded ?? (() => undefined);
  }

  /** Adds received text and returns the lines it completed, in order. */
  push(text: string): string[] {
    const lines: string[] = [];
    // Only the end of what was kept can hold the start of a separator split across two deliveries.
    const searchFrom = Math.max(0, this.#pending.length - this.#separator.length + 1);
    let pending = this.#pending + text;
    let lineStart = 0;

    for (;;) {
      const end = pending.indexOf(this.#separator, Math.max(searchFrom, lineStart));
      if (end === -1) {
        break;
      }
      lines.push(pending.slice(lineStart, end));
      lineStart = end + this.#separator.length;
    }
    pending = pending.slice(lineStart);

    if (pending.length > this.#maxLineLength) {
      this.#onDiscarded(pending.length, 'too-long');
      pending = '';
    }
    this.#pending = pending;
    return lines;
  }

  /** Drops an unfinished line, which must not be joined to text from after a gap. */
  reset(): void {
    if (this.#pending.length > 0) {
      this.#onDiscarded(this.#pending.length, 'after-gap');
      this.#pending = '';
    }
  }
}

/**
 * Hands complete lines to `onLine`, however the device's output was split into deliveries.
 *
 * The configuration needs `encoding: { decodeText: true }`. The decoder keeps a multi-byte
 * character that is split across two reads intact; this function only has to join the text.
 *
 * A delivery with `afterGap` may follow lost bytes - the port changed tabs or reconnected - so an
 * unfinished line is dropped before it. The first delivery of a tab is one too: the tab joins
 * mid-stream, and its first line can be the tail of one, so check lines against the device's format.
 *
 * @returns A function that stops listening.
 */
export function onLines(
  name: string,
  onLine: (line: string) => void,
  options: LineOptions = {},
): Unsubscribe {
  const splitter = new LineSplitter(options);
  return SerialBroker.subscribe(name, 'onReceive', (event) => {
    if (event.afterGap) {
      splitter.reset();
    }
    for (const line of splitter.push(event.text ?? '')) {
      onLine(line);
    }
  });
}
