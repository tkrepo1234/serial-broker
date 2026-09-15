/**
 * The USB/IP emulator (`emulator/`), run as a child process and driven through its terminal.
 *
 * The emulator is operated by typing commands, and it logs everything the device does. This starts
 * it the way `npm run emulator` does - it attaches itself through usbip-win2 - writes commands to
 * its standard input and reads its log, so that a scenario can pull the cable, hang the device or
 * split its answers at the moment it needs to, and count what reached the device rather than
 * infer it from what came back.
 *
 * Windows only, like usbip-win2. See emulator/README.md and ADR-0035.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

import { findWindowsSerialDevices } from './windows-serial-device.js';

/** The IDs the emulator reports by default: pid.codes' test PID, which no product uses. */
export const EMULATED_DEVICE = { vendorId: 0x1209, productId: 0x0001 } as const;

/** Where usbip-win2 installs its command-line client; `SERIAL_BROKER_USBIP` overrides it. */
const USBIP_PATH = process.env['SERIAL_BROKER_USBIP'] ?? 'C:\\Program Files\\USBip\\usbip.exe';

/** How long attaching may take: usbip-win2, then Windows binding its driver and naming a port. */
const ATTACH_TIMEOUT_MS = 30_000;

/** The line Windows' enumeration ends with: it has chosen the device's configuration. */
const CONFIGURED = /configured \(configuration/;

export class EmulatorProcess {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #lines: string[] = [];
  #hasExited = false;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child;
    for (const stream of [child.stdout, child.stderr]) {
      createInterface({ input: stream }).on('line', (line) => {
        this.#lines.push(line);
      });
    }
    child.on('exit', () => {
      this.#hasExited = true;
    });
  }

  /** Starts the emulator, and returns once Windows has given the device a COM port. */
  static async start(): Promise<EmulatorProcess> {
    if (!existsSync(USBIP_PATH)) {
      throw new Error(
        `usbip-win2 is not installed at ${USBIP_PATH}. See emulator/README.md, or set ` +
          'SERIAL_BROKER_USBIP to where usbip.exe is.',
      );
    }
    // The same Node that runs the tests, which is new enough for the emulator's TypeScript if
    // it is new enough for this suite; launch.mjs says so plainly where it is not.
    const child = spawn(process.execPath, ['emulator/launch.mjs', '--usbip', USBIP_PATH], {
      stdio: 'pipe',
      windowsHide: true,
    });
    const emulator = new EmulatorProcess(child);
    try {
      await emulator.waitForLine(CONFIGURED, 0, ATTACH_TIMEOUT_MS);
      await emulator.#waitForSerialPort();
    } catch (error) {
      await emulator.stop();
      throw error;
    }
    return emulator;
  }

  /** How many lines it has logged; pass this to {@link waitForLine} to wait for later ones. */
  get lineCount(): number {
    return this.#lines.length;
  }

  /** What it logged after the first `after` lines, for a failed test's attachments. */
  logSince(after: number): string {
    return this.#lines.slice(after).join('\n');
  }

  /** Types a command into the emulator's terminal. */
  command(text: string): void {
    this.#child.stdin.write(`${text}\n`);
  }

  /** Waits for a line matching `pattern` among those logged after the first `after`. */
  async waitForLine(pattern: RegExp, after: number, timeoutMs = 10_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const line = this.#lines.slice(after).find((it) => pattern.test(it));
      if (line !== undefined) {
        return line;
      }
      if (this.#hasExited) {
        throw new Error(`The emulator exited.\n${this.#recentOutput()}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `The emulator logged nothing matching ${String(pattern)} within ` +
            `${String(timeoutMs)} ms.\n${this.#recentOutput()}`,
        );
      }
      await delay(50);
    }
  }

  /** Types a command and waits for the line that confirms it. */
  async run(command: string, confirmation: RegExp, timeoutMs?: number): Promise<string> {
    const mark = this.lineCount;
    this.command(command);
    return await this.waitForLine(confirmation, mark, timeoutMs);
  }

  /** How many bytes the device has received from the host since the emulator started. */
  async bytesFromHost(): Promise<number> {
    const line = await this.run('status', /bytes from host: \d+/);
    return Number(/bytes from host: (\d+)/.exec(line)?.[1]);
  }

  /** Pulls the cable: the connection closes, and Windows removes the device. */
  async unplug(): Promise<void> {
    await this.run('unplug', /unplugged; "plug"/);
  }

  /** Plugs it back in: usbip-win2 attaches it again, and Windows enumerates it. */
  async plug(): Promise<void> {
    await this.run('plug', CONFIGURED, ATTACH_TIMEOUT_MS);
  }

  /** Puts the device back as it started: plugged in, accepting writes, echoing, reads uncapped. */
  async reset(): Promise<void> {
    const status = await this.run('status', /plugged in: (yes|no)/);
    if (status.includes('plugged in: no')) {
      await this.plug();
    }
    await this.run('resume', /resumed/);
    await this.run('echo', /behaviour: echo/);
    await this.run('chunk off', /reads are no longer capped/);
  }

  /** Stops the emulator, which closes the connection and removes the device from Windows. */
  async stop(): Promise<void> {
    if (this.#hasExited) {
      return;
    }
    const exited = new Promise<void>((resolve) => {
      this.#child.once('exit', () => {
        resolve();
      });
    });
    this.command('quit');
    const killer = setTimeout(() => {
      this.#child.kill();
    }, 10_000);
    await exited;
    clearTimeout(killer);
  }

  async #waitForSerialPort(): Promise<void> {
    const deadline = Date.now() + ATTACH_TIMEOUT_MS;
    const { vendorId, productId } = EMULATED_DEVICE;
    while (findWindowsSerialDevices(vendorId, productId).length === 0) {
      if (Date.now() >= deadline) {
        throw new Error(
          `Windows gave the emulated device no COM port within ${String(ATTACH_TIMEOUT_MS)} ms.\n` +
            this.#recentOutput(),
        );
      }
      await delay(500);
    }
  }

  #recentOutput(): string {
    return `Last lines of its log:\n${this.#lines.slice(-30).join('\n')}`;
  }
}
