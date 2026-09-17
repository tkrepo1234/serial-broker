/**
 * What the examples' smoke tests have in common: opening a page that records every sign of noise,
 * the loopback device of the Web Serial stand-in, and the four things every example lets a user do
 * - open a granted device on load, ask for one with a click, live through an unplugged device, and
 * release a configuration and set it up again.
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
  /** Whether the status element says its status in its text, or in `data-status`. */
  readonly statusIn: 'text' | 'data-status';
  readonly status: string;
  readonly connect: string;
  readonly sendInput: string;
  readonly sendButton: string;
  /** Where an echoed line shows up. */
  readonly received: string;
  readonly error: string;
  readonly errorCode: string;
  /** The remediation shown with an error, where the example shows one. */
  readonly errorRemediation?: string;
  /**
   * The button that releases the configuration, where the example has one.
   *
   * Optional, like the remediation above: three examples deliberately have no release button, and
   * a required field made them name ids their pages have never carried. A selector that matches
   * nothing reads like coverage and is not - it passes only for as long as no test clicks it.
   */
  readonly release?: string;
  /** The button that sets a released configuration up again, where the example has one. */
  readonly setUpAgain?: string;
  /** Whether a response of 400 or above counts as noise too. */
  readonly failedRequestsAreNoise?: boolean;
}

/** The ids examples/README.md asks every example for, where an example keeps to them. */
export const USUAL_IDS = {
  statusIn: 'text',
  status: '#status',
  connect: '#connect',
  sendInput: '#send-input',
  sendButton: '#send-button',
  received: '#received',
  error: '#error',
  errorCode: '#error-code',
  // No `release` here. Nine of the twelve examples have that button and name it themselves; a
  // default handed it to the three that do not, where it matched nothing and looked deliberate.
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
 * page's own scripts run, so the library finds it. `granted` is whether the origin was given the
 * device on an "earlier visit"; without it, the example's own connect path is what runs.
 */
export async function installLoopback(context: BrowserContext, granted: boolean): Promise<void> {
  await context.addInitScript(installWebSerialStandIn, {
    devices: [{ id: 'loopback', granted }],
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
    if (ui.failedRequestsAreNoise === true) {
      page.on('response', (response) => {
        if (response.status() >= 400) {
          this.noise.push(`${String(response.status())} ${response.url()}`);
        }
      });
    }
  }

  /** Opens a new page of the context on the example. */
  static async open(context: BrowserContext, ui: ExampleUi): Promise<ExampleTab> {
    const tab = new ExampleTab(await context.newPage(), ui);
    await tab.page.goto(ui.url);
    return tab;
  }

  /** Drives a page of the example that the example opened itself, from the time of this call. */
  static attach(page: Page, ui: ExampleUi): ExampleTab {
    return new ExampleTab(page, ui);
  }

  locator(selector: string, options?: Parameters<Page['locator']>[1]): Locator {
    return this.page.locator(selector, options);
  }

  async expectStatus(status: string): Promise<void> {
    const element = this.locator(this.ui.status);
    await (this.ui.statusIn === 'text'
      ? expect(element).toHaveText(status)
      : expect(element).toHaveAttribute('data-status', status));
  }

  /** A device granted on an earlier visit opens with no click, and Connect is not offered. */
  async expectOpenWithoutClick(): Promise<void> {
    await this.expectStatus('open');
    await expect(this.locator(this.ui.connect)).toBeHidden();
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
   * Unplugging is a failure the library recovers from by itself: the example shows the error as a
   * note (`data-retryable`) next to the reconnecting status, and clears it once the device is back
   * and the port is open again.
   *
   * @param whileReconnecting - What else the example shows while the device is away.
   */
  async recoverFromUnplug(whileReconnecting?: () => Promise<void>): Promise<void> {
    await this.page.evaluate(() => {
      (window as unknown as StandInWindow).webSerialStandIn?.unplug();
    });
    await this.expectStatus('reconnecting');
    await expect(this.locator(this.ui.error)).toHaveAttribute('data-retryable', 'true');
    await expect(this.locator(this.ui.errorCode)).toHaveText('DEVICE_DISCONNECTED');
    if (this.ui.errorRemediation !== undefined) {
      await expect(this.locator(this.ui.errorRemediation)).not.toBeEmpty();
    }
    await expect(this.locator(this.ui.sendButton)).toBeDisabled();
    await whileReconnecting?.();

    await this.page.evaluate(() => {
      (window as unknown as StandInWindow).webSerialStandIn?.plug();
    });
    await this.expectStatus('open');
    await expect(this.locator(this.ui.error)).toBeHidden();
  }

  /**
   * Releases the configuration in this tab, then sets it up again, which needs no click.
   *
   * @param whileReleased - What else the example shows while the configuration is released.
   */
  async releaseAndSetUpAgain(whileReleased?: () => Promise<void>): Promise<void> {
    const { release, setUpAgain } = this.ui;
    if (release === undefined || setUpAgain === undefined) {
      throw new Error(
        'releaseAndSetUpAgain needs both `release` and `setUpAgain` in the example UI; this ' +
          'example declares no such buttons.',
      );
    }
    await this.locator(release).click();
    await this.expectStatus('released');
    await expect(this.locator(this.ui.sendButton)).toBeDisabled();
    await whileReleased?.();

    await this.locator(setUpAgain).click();
    await this.expectStatus('open');
  }

  expectQuiet(): void {
    expect(this.noise, 'the page wrote to the console or threw').toEqual([]);
  }
}
