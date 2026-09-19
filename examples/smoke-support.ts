/**
 * What the examples' smoke tests have in common: opening a page that records every sign of noise,
 * the loopback device of the Web Serial stand-in, and the things every example lets a user do -
 * connect with a click, send a line and see it echoed, and live through an unplugged device.
 *
 * Each `smoke.spec.ts` names its example's elements once, in an {@link ExampleUi}, and composes its
 * tests from these steps; what only one example does stays in its own spec. The steps assert what
 * every example that offers them shows, and nothing an example is free to show differently.
 */
import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test';

import {
  installWebSerialStandIn,
  type WebSerialStandInControl,
} from '../test/browser/stand-in/web-serial-stand-in.js';

/** The stand-in's controls, as the page sees them; `page.evaluate` cannot import the type. */
interface StandInWindow {
  readonly webSerialStandIn?: WebSerialStandInControl;
}

/** The elements of an example a smoke test drives, by selector. */
export interface ExampleUi {
  /** The page to load. */
  readonly url: string;
  /** The element whose text is the status. */
  readonly status: string;
  readonly connect: string;
  readonly sendInput: string;
  readonly sendButton: string;
  /** Where an echoed line shows up. */
  readonly received: string;
  readonly error: string;
  /** The code shown with an error, where the example shows it in an element of its own. */
  readonly errorCode?: string;
  /** The remediation shown with an error, where the example shows one. */
  readonly errorRemediation?: string;
}

/** The ids examples/README.md asks every example for, where an example keeps to them. */
export const USUAL_IDS = {
  status: '#status',
  connect: '#connect',
  sendInput: '#send-input',
  sendButton: '#send-button',
  received: '#received',
  error: '#error',
} as const;

/** The manifest the root reads, so that an example's port lives in one place. */
export interface ExampleManifest {
  readonly port: number;
  readonly readyPath: string;
}

/** The URL an example's `example.json`, next to `specUrl`, says it serves its page at. */
export function urlOfExample(manifest: ExampleManifest): string {
  return `http://localhost:${String(manifest.port)}${manifest.readyPath}`;
}

/**
 * Installs the stand-in's loopback device in every page the context opens from now on: before the
 * page's own scripts run, so the library finds it. The origin has not been given the device, so the
 * example's own connect path - the one step that needs the user - is what runs.
 */
export async function installLoopback(context: BrowserContext): Promise<void> {
  await context.addInitScript(installWebSerialStandIn, {
    devices: [{ id: 'loopback', granted: false }],
  });
}

/** One page of an example, and what it drives there. */
export class ExampleTab {
  /** Uncaught errors and console warnings or errors of the page: any of them fails the test. */
  readonly noise: string[] = [];

  private constructor(
    readonly page: Page,
    readonly ui: ExampleUi,
  ) {
    page.on('pageerror', (error) => this.noise.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'warning' || message.type() === 'error') {
        this.noise.push(`console.${message.type()}: ${message.text()}`);
      }
    });
  }

  /** Opens a new page of the context on the example. */
  static async open(context: BrowserContext, ui: ExampleUi): Promise<ExampleTab> {
    const tab = new ExampleTab(await context.newPage(), ui);
    await tab.page.goto(ui.url);
    return tab;
  }

  locator(selector: string): Locator {
    return this.page.locator(selector);
  }

  async expectStatus(status: string): Promise<void> {
    await expect(this.locator(this.ui.status)).toHaveText(status);
  }

  /**
   * No granted device: the example waits for permission until Connect is clicked - a real click, as
   * `requestPort()`, the stand-in's as much as the browser's, needs the transient activation of one.
   */
  async connectByClick(): Promise<void> {
    await this.expectStatus('awaiting-permission');
    await expect(this.locator(this.ui.sendButton)).toBeDisabled();

    await this.locator(this.ui.connect).click();

    await this.expectStatus('open');
    await expect(this.locator(this.ui.connect)).toBeHidden();
  }

  /** Sends a line and waits for the loopback's echo of it. */
  async sendLine(line: string): Promise<void> {
    await this.locator(this.ui.sendInput).fill(line);
    await this.locator(this.ui.sendButton).click();
    await expect(this.locator(this.ui.received)).toContainText(line);
  }

  /**
   * Unplugging is a failure the library recovers from by itself: the example shows the error next
   * to the reconnecting status - as a note (`data-retryable`) where it shows the code in an element
   * of its own - and clears it once the device is back and the port is open again.
   *
   * @param whileReconnecting - What else the example shows while the device is away.
   */
  async recoverFromUnplug(whileReconnecting?: () => Promise<void>): Promise<void> {
    await this.page.evaluate(() => {
      (window as unknown as StandInWindow).webSerialStandIn?.unplug();
    });
    await this.expectStatus('reconnecting');
    if (this.ui.errorCode === undefined) {
      await expect(this.locator(this.ui.error)).toContainText('DEVICE_DISCONNECTED');
    } else {
      await expect(this.locator(this.ui.error)).toHaveAttribute('data-retryable', 'true');
      await expect(this.locator(this.ui.errorCode)).toHaveText('DEVICE_DISCONNECTED');
    }
    if (this.ui.errorRemediation !== undefined) {
      await expect(this.locator(this.ui.errorRemediation)).not.toBeEmpty();
    }
    await expect(this.locator(this.ui.sendButton)).toBeDisabled();
    await whileReconnecting?.();

    await this.page.evaluate(() => {
      (window as unknown as StandInWindow).webSerialStandIn?.plug();
    });
    await this.expectStatus('open');
    // Gone, or - where the error is one line of text - empty again.
    await (this.ui.errorCode === undefined
      ? expect(this.locator(this.ui.error)).toBeEmpty()
      : expect(this.locator(this.ui.error)).toBeHidden());
  }

  expectQuiet(): void {
    expect(this.noise, 'the page wrote to the console or threw').toEqual([]);
  }
}
