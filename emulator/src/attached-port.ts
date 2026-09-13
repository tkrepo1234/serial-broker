/**
 * Which usbip-win2 port the emulator's device is attached to, for the `detach` command.
 *
 * usbip.exe numbers its virtual ports itself and gives a freed number to the next device that
 * attaches, which may be a real device or another emulator. A remembered number is therefore
 * only safe to pass to `usbip.exe detach -p` while the attachment it was read from still
 * exists; once that attachment has ended, "detaching our port" could pull someone else's device.
 * This class holds the number and forgets it the moment the attachment is known to be gone.
 */

import type { ServerEvent } from './usbip-server.ts';

/** How one run of usbip.exe ended. */
export interface UsbipOutcome {
  /** Whether usbip.exe exited with status 0. */
  readonly isSuccess: boolean;
  /** Its standard output and standard error, together. */
  readonly output: string;
}

/** The port this emulator attached, as far as it can know. */
export class AttachedPort {
  #port: string | undefined;

  /** The port number, or `undefined` when no attachment made by this emulator is known to exist. */
  get port(): string | undefined {
    return this.#port;
  }

  /**
   * Takes the port number from a finished `usbip.exe attach`.
   *
   * @param outcome - The run. Output without a port number, such as a failed attach, changes
   *   nothing.
   */
  recordAttach(outcome: UsbipOutcome): void {
    const attached = /attached to port (\d+)/.exec(outcome.output);
    if (attached?.[1] !== undefined) {
      this.#port = attached[1];
    }
  }

  /**
   * Forgets the port after `usbip.exe detach -p <port>` has succeeded.
   *
   * @param port - The port that run detached.
   * @param outcome - The run. A failed detach leaves the attachment, and so the number, in place.
   */
  recordDetach(port: string, outcome: UsbipOutcome): void {
    // Compare, rather than forget unconditionally: had the device been attached again while
    // detach was running, the port now remembered belongs to that newer attachment.
    if (outcome.isSuccess && port === this.#port) {
      this.#port = undefined;
    }
  }

  /**
   * Forgets the port when the server reports the device detached.
   *
   * Unplugging, or the client closing its connection, ends the attachment on the Windows side
   * too, and frees the port number there, without usbip.exe detach ever being run.
   *
   * @param event - Any server event; only `'detached'` matters.
   */
  recordServerEvent(event: ServerEvent): void {
    if (event.kind === 'detached') {
      this.#port = undefined;
    }
  }
}
