/**
 * A test page, driven through the harness it installs.
 *
 * One of these is one tab of the origin. Everything a spec does goes through this class, so that
 * the specs read as scenarios rather than as `page.evaluate()` plumbing, and so that the casts
 * that reach `window.harness` live in one place.
 *
 * See ADR-0035.
 */

import type { BrowserContext, CDPSession, Page } from '@playwright/test';

import type { SerialBrokerOptions } from '../../../src/core/types.js';
import type { HarnessLogRecord, HarnessSend, PageHarness } from '../pages/harness.js';
import {
  installWebSerialStandIn,
  type WebSerialStandInControl,
  type WebSerialStandInOptions,
} from '../stand-in/web-serial-stand-in.js';

/** The page's globals, as the harness leaves them. */
type HarnessWindow = Window & {
  harness: PageHarness;
  webSerialStandIn?: WebSerialStandInControl;
};

/** The loopback device the stand-in offers, and the filter that finds it. */
export const STAND_IN_DEVICE = { vendorId: 0x2341, productId: 0x0043 } as const;

/** A device the origin was granted on an earlier visit: `setup()` opens it with no prompt. */
export const GRANTED_DEVICE: WebSerialStandInOptions = {
  devices: [
    {
      id: 'loopback',
      usbVendorId: STAND_IN_DEVICE.vendorId,
      usbProductId: STAND_IN_DEVICE.productId,
      granted: true,
    },
  ],
};

/** The same device, never granted: `setup()` stops at `awaiting-permission`. */
export const UNGRANTED_DEVICE: WebSerialStandInOptions = {
  devices: [{ ...GRANTED_DEVICE.devices[0], id: 'loopback', granted: false }],
};

/** Options a configuration is set up with in most tests. */
export function echoConfiguration(
  overrides: Partial<SerialBrokerOptions> = {},
): SerialBrokerOptions {
  return {
    device: STAND_IN_DEVICE,
    serial: { baudRate: 9600 },
    encoding: { decodeText: true },
    persist: false,
    ...overrides,
  };
}

/** Which page and which transport a tab loads with. */
export interface OpenTabOptions {
  /** `tab.html` (the readable build) or `tab-min.html` (the minified one). */
  readonly page?: 'tab.html' | 'tab-min.html';
  readonly transport?: 'auto' | 'sharedworker' | 'broadcastchannel';
  readonly workerUrl?: string;
}

/**
 * Installs the Web Serial stand-in for every page this context will open.
 *
 * Must be called before the first page: `addInitScript` reaches only pages created afterwards,
 * which is exactly the point - the stand-in has to be there before the page's own scripts run.
 */
export async function installStandIn(
  context: BrowserContext,
  options: WebSerialStandInOptions,
): Promise<void> {
  await context.addInitScript(installWebSerialStandIn, options);
}

export class Tab {
  /** Uncaught errors and unhandled rejections in the page. Any of them fails a test. */
  readonly pageErrors: string[] = [];

  private constructor(readonly page: Page) {}

  /** Opens a tab and waits until its harness is installed. */
  static async open(context: BrowserContext, options: OpenTabOptions = {}): Promise<Tab> {
    const page = await context.newPage();
    const tab = new Tab(page);
    page.on('pageerror', (error) => tab.pageErrors.push(error.message));

    const query = new URLSearchParams();
    if (options.transport !== undefined) {
      query.set('transport', options.transport);
    }
    if (options.workerUrl !== undefined) {
      query.set('workerUrl', options.workerUrl);
    }
    const search = query.size === 0 ? '' : `?${query.toString()}`;

    await page.goto(`/${options.page ?? 'tab.html'}${search}`);
    await page.waitForFunction(() => 'harness' in window);
    return tab;
  }

  async setup(name: string, options: SerialBrokerOptions): Promise<void> {
    await this.page.evaluate(
      ([configName, configOptions]) =>
        (window as unknown as HarnessWindow).harness.setup(configName, configOptions),
      [name, options] as const,
    );
  }

  async release(name: string, forgetDevice = false): Promise<void> {
    await this.page.evaluate(
      ([configName, forget]) =>
        (window as unknown as HarnessWindow).harness.release(configName, forget),
      [name, forgetDevice] as const,
    );
  }

  async send(name: string, text: string): Promise<void> {
    await this.page.evaluate(
      ([configName, payload]) =>
        (window as unknown as HarnessWindow).harness.send(configName, payload),
      [name, text] as const,
    );
  }

  /** Sends a payload of the harness's pattern. `seed` picks the sequence; see `PageHarness`. */
  async sendPattern(name: string, byteLength: number, seed = 0): Promise<void> {
    await this.page.evaluate(
      ([configName, length, patternSeed]) =>
        (window as unknown as HarnessWindow).harness.sendPattern(configName, length, patternSeed),
      [name, byteLength, seed] as const,
    );
  }

  /** Clicks the page's "Choose device" button, which asks for the port from a user gesture. */
  async requestAccessByClick(name: string): Promise<string> {
    await this.page.evaluate((configName) => {
      (window as unknown as HarnessWindow).harness.armAccessRequest(configName);
    }, name);
    await this.page.click('#request-access');
    await this.page.waitForFunction(
      () => (window as unknown as HarnessWindow).harness.lastAccessRequest() !== undefined,
    );
    return (
      (await this.page.evaluate(() =>
        (window as unknown as HarnessWindow).harness.lastAccessRequest(),
      )) ?? 'none'
    );
  }

  async status(name: string): Promise<string> {
    return await this.page.evaluate(
      (configName) => (window as unknown as HarnessWindow).harness.status(configName),
      name,
    );
  }

  async waitForStatus(name: string, status: string, timeout = 20_000): Promise<void> {
    await this.page.waitForFunction(
      ([configName, wanted]) =>
        (window as unknown as HarnessWindow).harness.status(configName) === wanted,
      [name, status] as const,
      { timeout },
    );
  }

  async waitForReceivedText(name: string, text: string, timeout = 20_000): Promise<void> {
    await this.page.waitForFunction(
      ([configName, wanted]) =>
        (window as unknown as HarnessWindow).harness.receivedText(configName).includes(wanted),
      [name, text] as const,
      { timeout },
    );
  }

  async waitForReceivedBytes(name: string, byteCount: number, timeout = 20_000): Promise<void> {
    await this.page.waitForFunction(
      ([configName, wanted]) =>
        (window as unknown as HarnessWindow).harness.receivedByteCount(configName) >= wanted,
      [name, byteCount] as const,
      { timeout },
    );
  }

  /** Waits until an unbroken run of the sent pattern this long has arrived. */
  async waitForPatternRun(name: string, byteCount: number, timeout = 20_000): Promise<void> {
    await this.page.waitForFunction(
      ([configName, wanted]) =>
        (window as unknown as HarnessWindow).harness.receivedPatternLength(configName) >= wanted,
      [name, byteCount] as const,
      { timeout },
    );
  }

  async receivedText(name: string): Promise<string> {
    return await this.page.evaluate(
      (configName) => (window as unknown as HarnessWindow).harness.receivedText(configName),
      name,
    );
  }

  async receivedByteCount(name: string): Promise<number> {
    return await this.page.evaluate(
      (configName) => (window as unknown as HarnessWindow).harness.receivedByteCount(configName),
      name,
    );
  }

  async receivedPatternLength(name: string): Promise<number> {
    return await this.page.evaluate(
      (configName) =>
        (window as unknown as HarnessWindow).harness.receivedPatternLength(configName),
      name,
    );
  }

  async sends(name: string): Promise<readonly HarnessSend[]> {
    return await this.page.evaluate(
      (configName) => (window as unknown as HarnessWindow).harness.sends(configName),
      name,
    );
  }

  async statuses(name: string): Promise<readonly string[]> {
    return await this.page.evaluate(
      (configName) => (window as unknown as HarnessWindow).harness.statuses(configName),
      name,
    );
  }

  async errorCodes(): Promise<readonly string[]> {
    return await this.page.evaluate(() =>
      (window as unknown as HarnessWindow).harness.errorCodes(),
    );
  }

  async waitForErrorCode(code: string, timeout = 20_000): Promise<void> {
    await this.page.waitForFunction(
      (wanted) => (window as unknown as HarnessWindow).harness.errorCodes().includes(wanted),
      code,
      { timeout },
    );
  }

  async logEvents(): Promise<readonly string[]> {
    return await this.page.evaluate(() => (window as unknown as HarnessWindow).harness.logEvents());
  }

  async logRecords(): Promise<readonly HarnessLogRecord[]> {
    return await this.page.evaluate(() =>
      (window as unknown as HarnessWindow).harness.logRecords(),
    );
  }

  async waitForLogEvent(event: string, timeout = 20_000): Promise<void> {
    await this.page.waitForFunction(
      (wanted) => (window as unknown as HarnessWindow).harness.logEvents().includes(wanted),
      event,
      { timeout },
    );
  }

  async protocolVersion(): Promise<number> {
    return await this.page.evaluate(() =>
      (window as unknown as HarnessWindow).harness.protocolVersion(),
    );
  }

  /** `true` while this tab holds the stand-in device open. */
  async holdsPort(): Promise<boolean> {
    return await this.page.evaluate(() =>
      (window as unknown as HarnessWindow).harness.isPortOpenHere(),
    );
  }

  /** `true` while this tab is the one holding the port. Works without the stand-in. */
  async holdsOwnerLock(name: string): Promise<boolean> {
    return await this.page.evaluate(
      (configName) => (window as unknown as HarnessWindow).harness.holdsOwnerLock(configName),
      name,
    );
  }

  /** Forgets what was received so far. */
  async clearReceived(name: string): Promise<void> {
    await this.page.evaluate((configName) => {
      (window as unknown as HarnessWindow).harness.clearReceived(configName);
    }, name);
  }

  /** Unplugs the device for every page of the origin. */
  async unplugDevice(): Promise<void> {
    await this.page.evaluate(() => {
      (window as unknown as HarnessWindow).webSerialStandIn?.unplug();
    });
  }

  /** Plugs it back in. */
  async plugDevice(): Promise<void> {
    await this.page.evaluate(() => {
      (window as unknown as HarnessWindow).webSerialStandIn?.plug();
    });
  }

  /** Kills this tab's renderer: no unload handler runs, as in a crash or an out-of-memory kill. */
  async crash(): Promise<void> {
    const session = await this.page.context().newCDPSession(this.page);
    // Never resolves for a page that is gone; the crash itself is the result.
    void session.send('Page.crash').catch(() => {
      // The target is gone, which is what was asked for.
    });
    await this.page.waitForEvent('crash');
  }
}

/**
 * Waits until exactly one of these tabs holds the device open, and says which.
 *
 * Polling the device rather than the library: a handover is not instantaneous, and the moment it
 * has happened is exactly the moment the device is open in one tab again.
 */
export async function waitForPortHolder(tabs: readonly Tab[], timeoutMs = 20_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await tabHoldingThePort(tabs);
    } catch (error) {
      if (Date.now() >= deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/** Which of these tabs holds the device open, by index. */
export async function tabHoldingThePort(tabs: readonly Tab[]): Promise<number> {
  const holders: number[] = [];
  for (const [index, tab] of tabs.entries()) {
    if (await tab.holdsPort()) {
      holders.push(index);
    }
  }
  if (holders.length !== 1) {
    throw new Error(`Expected exactly one tab to hold the device, found ${String(holders.length)}`);
  }
  return holders[0] as number;
}

/** One `SharedWorker` the browser hosts, as Chromium lists it. */
export interface SharedWorkerTarget {
  /** Chromium's handle for it; a new worker has a new one. */
  readonly targetId: string;
  /** The script it was constructed from. */
  readonly url: string;
}

/**
 * The shared workers Chromium hosts for this tab's browser context.
 *
 * The one thing about a `SharedWorker` no page can see: how many of them there are. Chromium
 * lists them as targets, which is what `chrome://inspect/#workers` shows, and the list is
 * filtered to this context because the files of this suite run in parallel contexts of the same
 * browser, each with a worker of its own.
 */
export async function sharedWorkersOf(tab: Tab): Promise<readonly SharedWorkerTarget[]> {
  const contextId = await browserContextIdOf(tab);
  const session = await browserSessionOf(tab);
  try {
    const { targetInfos } = await session.send('Target.getTargets');
    return targetInfos
      .filter((info) => info.type === 'shared_worker' && info.browserContextId === contextId)
      .map((info) => ({ targetId: info.targetId, url: info.url }));
  } finally {
    await session.detach();
  }
}

/**
 * Terminates every shared worker of this tab's context, and says which ones went.
 *
 * What step 29 of the manual test plan does from `chrome://inspect/#workers`: the broker is gone
 * with nothing of ours told about it, so the tabs have to notice by themselves (ADR-0021).
 * Killing it outright rather than crashing a renderer and hoping the worker lived there - which
 * Chromium is free to arrange either way.
 */
export async function terminateSharedWorkers(tab: Tab): Promise<readonly SharedWorkerTarget[]> {
  const workers = await sharedWorkersOf(tab);
  const session = await browserSessionOf(tab);
  try {
    for (const worker of workers) {
      await session.send('Target.closeTarget', { targetId: worker.targetId });
    }
  } finally {
    await session.detach();
  }
  return workers;
}

/** The id Chromium gives the browser context this tab lives in. */
async function browserContextIdOf(tab: Tab): Promise<string | undefined> {
  const session = await tab.page.context().newCDPSession(tab.page);
  try {
    const { targetInfo } = await session.send('Target.getTargetInfo');
    return targetInfo.browserContextId;
  } finally {
    await session.detach();
  }
}

/** A CDP session on the browser itself: targets that are not pages live outside a page session. */
async function browserSessionOf(tab: Tab): Promise<CDPSession> {
  const browser = tab.page.context().browser();
  if (browser === null) {
    throw new Error('The browser is not available for a CDP session; this needs Chromium.');
  }
  return await browser.newBrowserCDPSession();
}
