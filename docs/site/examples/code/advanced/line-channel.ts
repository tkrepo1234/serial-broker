import { SerialBroker, type Unsubscribe } from 'serial-broker';

import { onLines } from '../features/lines.js';

/** How one request waits for its answer. */
export interface RequestOptions {
  /**
   * Which line is the answer. A device that also sends lines of its own - a scale streaming its
   * weight - needs this, or the next weight line would be taken for the answer. Default: any line.
   */
  readonly isAnswer?: (line: string) => boolean;
  /** How long to wait for the answer, counted from the moment `send()` has resolved. */
  readonly timeoutMs?: number;
  /**
   * How long the lock is kept after a timeout. An answer that arrives just late is then dropped here
   * instead of being taken by the next request, from this tab or another.
   */
  readonly lateAnswerGraceMs?: number;
  /** How long to wait for other tabs' requests before giving up. */
  readonly queueTimeoutMs?: number;
}

/** No answer came in time. The command may still have reached the device. */
export class NoAnswerError extends Error {
  override readonly name = 'NoAnswerError';
}

/**
 * Request and response for a device that answers a command with one line.
 *
 * Every tab receives every line the device sends, including the answers to other tabs' commands. A
 * simple line protocol carries no identifier to match an answer to its question, so "the next
 * answer line is mine" only holds while no other tab is asking. The channel therefore takes a Web
 * Lock of its own around each command and its answer. It is the application's lock, separate from
 * the one serial-broker uses for the port, and it spans every tab of the origin.
 */
export class LineChannel {
  readonly #name: string;
  readonly #lockName: string;
  readonly #stopListening: Unsubscribe;
  #awaitingAnswer: ((line: string) => void) | undefined;

  /** The configuration must be set up with `encoding: { decodeText: true }`. */
  constructor(name: string) {
    this.#name = name;
    this.#lockName = `app/line-channel/${name}`;
    // The splitter drops a half-received line before every delivery marked `afterGap`.
    this.#stopListening = onLines(name, (line) => {
      this.#awaitingAnswer?.(line);
    });
  }

  /**
   * Sends a command and resolves with the line that answers it.
   *
   * @throws NoAnswerError when no answer arrived within `timeoutMs` after the send. An answer the
   *   device sent while the port was changing tabs is lost, and this is what turns that into an
   *   error.
   * @throws The `SerialBrokerError` of a failed `send()`, and a `DOMException` named `TimeoutError`
   *   when other tabs' requests kept the lock for longer than `queueTimeoutMs`.
   */
  async request(command: string, options: RequestOptions = {}): Promise<string> {
    const {
      isAnswer = () => true,
      timeoutMs = 2_000,
      lateAnswerGraceMs = 500,
      queueTimeoutMs = 10_000,
    } = options;

    return await navigator.locks.request(
      this.#lockName,
      { signal: AbortSignal.timeout(queueTimeoutMs) },
      async () => {
        let answered: (line: string) => void = () => undefined;
        const answer = new Promise<string>((resolve) => {
          answered = resolve;
        });
        // Listening before sending: the answer can arrive before this tab hears that `send()`
        // resolved, which crosses the bus from the tab holding the port.
        this.#awaitingAnswer = (line) => {
          if (isAnswer(line)) {
            this.#awaitingAnswer = undefined;
            answered(line);
          }
        };

        try {
          await SerialBroker.send(this.#name, `${command}\r\n`);
        } catch (error) {
          this.#awaitingAnswer = undefined;
          throw error;
        }

        // Counted from here: `send()` itself may wait for a connection for up to
        // `connection.writeTimeoutMs`, and an answer cannot come before the command went out.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise<undefined>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        });
        const line = await Promise.race([answer, timedOut]);
        clearTimeout(timer);
        if (line !== undefined) {
          return line;
        }

        this.#awaitingAnswer = undefined;
        // Still holding the lock: a late answer reaches no request, so it cannot be mistaken for
        // the answer to the next one.
        await new Promise((resolve) => setTimeout(resolve, lateAnswerGraceMs));
        throw new NoAnswerError(`No answer to "${command}" within ${String(timeoutMs)} ms`);
      },
    );
  }

  close(): void {
    this.#stopListening();
  }
}
