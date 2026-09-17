/**
 * Chromium's own serial port picker, answered the way a user answers it.
 *
 * The picker is browser UI: a page cannot see it, and the DevTools protocol has no command for it,
 * which is why steps 2 and 4a of the manual test plan stayed by hand. Windows UI Automation can
 * see it - it is what a screen reader uses - so `port-picker.ps1` finds the picker of the origin
 * under test in the browser started with the test's profile, and selects, connects or cancels.
 * Windows only, and only with a browser that shows a window.
 */

import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'port-picker.ps1');

/** The script's exit code when no picker of the origin is open (yet). */
const NO_PICKER = 2;

export class PortPicker {
  /**
   * @param profileDirectory - The profile the browser under test was started with; it tells that
   *   browser's windows from any other browser on the desktop.
   * @param origin - The origin that asks, as the picker names it in its title.
   */
  constructor(
    private readonly profileDirectory: string,
    private readonly origin: string,
  ) {}

  /** The names of the ports the picker offers, once it is open. */
  async offeredPorts(): Promise<readonly string[]> {
    return JSON.parse(await this.#whenOpen('list')) as string[];
  }

  /** Selects the port whose name contains `portName`, such as `COM3`, and connects. */
  async pick(portName: string): Promise<void> {
    await this.#whenOpen('pick', portName);
  }

  /** Dismisses the picker without choosing. */
  async cancel(): Promise<void> {
    await this.#whenOpen('cancel');
  }

  /** Whether a picker of the origin is open right now. */
  async isOpen(): Promise<boolean> {
    const { code } = await this.#run('list');
    return code === 0;
  }

  /** The picker opens a moment after the click that asks for it, so this waits for it. */
  async #whenOpen(action: string, portName = ''): Promise<string> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const { code, stdout, stderr } = await this.#run(action, portName);
      if (code === 0) {
        return stdout;
      }
      if (code !== NO_PICKER || Date.now() >= deadline) {
        throw new Error(`port-picker.ps1 -Action ${action} failed (${String(code)}): ${stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  #run(
    action: string,
    portName = '',
  ): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
    const args = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      SCRIPT,
      '-ProfileDirectory',
      this.profileDirectory,
      '-Origin',
      this.origin,
      '-Action',
      action,
      ...(portName === '' ? [] : ['-Port', portName]),
    ];
    return new Promise((resolve) => {
      execFile('powershell.exe', args, { encoding: 'utf8' }, (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolve({ code, stdout, stderr });
      });
    });
  }
}
