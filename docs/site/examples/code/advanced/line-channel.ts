import { SerialBroker, type Unsubscribe } from 'serial-broker';

/**
 * Request and response for a device that answers each command with one line.
 *
 * Every tab receives every line the device sends, including the answers to other tabs'
 * commands. A simple line protocol carries no identifier to match an answer to its question, so
 * "the next line is my answer" only holds while no other tab is asking. The channel therefore
 * takes a Web Lock of its own around each command and its answer. It is the application's lock,
 * separate from the one serial-broker uses for the port, and it spans every tab of the origin.
 */
export class LineChannel {
  readonly #name: string;
  readonly #lockName: string;
  readonly #stopListening: Unsubscribe;
  #pending = '';
  #awaitingAnswer: ((line: string) => void) | undefined;

  /** The configuration must be set up with `encoding: { decodeText: true }`. */
  constructor(name: string) {
    this.#name = name;
    this.#lockName = `app/line-channel/${name}`;
    this.#stopListening = SerialBroker.subscribe(name, 'onReceive', (event) => {
      const lines = (this.#pending + (event.text ?? '')).split('\r\n');
      this.#pending = lines.pop() ?? '';
      for (const line of lines) {
        this.#awaitingAnswer?.(line);
      }
    });
  }

  /**
   * Sends a command and resolves with the next line the device sends.
   *
   * @param timeoutMs - How long to wait for the answer. An answer the device sent while the
   *   port was changing tabs is lost, and this timeout is what turns that into an error.
   */
  async request(command: string, timeoutMs = 2_000): Promise<string> {
    return await navigator.locks.request(this.#lockName, async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const answer = new Promise<string>((resolve, reject) => {
        timer = setTimeout(() => {
          this.#awaitingAnswer = undefined;
          reject(new Error(`No answer to "${command}" within ${String(timeoutMs)} ms`));
        }, timeoutMs);
        this.#awaitingAnswer = (line) => {
          clearTimeout(timer);
          this.#awaitingAnswer = undefined;
          resolve(line);
        };
      });

      try {
        await SerialBroker.send(this.#name, `${command}\r\n`);
      } catch (error) {
        clearTimeout(timer);
        this.#awaitingAnswer = undefined;
        throw error;
      }
      return await answer;
    });
  }

  close(): void {
    this.#stopListening();
  }
}
