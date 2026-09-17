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

import { crashRenderer } from './crash.js';

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
    remember: false,
    ...overrides,
  };
}

/** Which page and which transport a tab loads with. */
export interface OpenTabOptions {
  /**
   * `tab.html` (the readable build), `tab-min.html` (the minified one) or `tab-global.html`
   * (the classic script build, which needs a `workerUrl`).
   */
  readonly page?: 'tab.html' | 'tab-min.html' | 'tab-global.html';
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

  /** Restores the remembered configurations; see `PageHarness.restore`. */
  async restore(): Promise<readonly string[]> {
    return await this.page.evaluate(() => (window as unknown as HarnessWindow).harness.restore());
  }

  /** Reloads the page and waits for its harness; what the page collected before is gone. */
  async reload(): Promise<void> {
    await this.page.reload();
    await this.page.waitForFunction(() => 'harness' in window);
  }

  async send(name: string, text: string): Promise<void> {
    await this.page.evaluate(
      ([configName, payload]) =>
        (window as unknown as HarnessWindow).harness.send(configName, payload),
      [name, text] as const,
    );
  }

  /** Starts a send and returns at once; {@link Tab.waitForSendOutcome} says how it ended. */
  async startSend(name: string, text: string): Promise<number> {
    return await this.page.evaluate(
      ([configName, payload]) =>
        (window as unknown as HarnessWindow).harness.startSend(configName, payload),
      [name, text] as const,
    );
  }

  /** Waits until a send from {@link Tab.startSend} has ended: `sent`, or `error:<code>`. */
  async waitForSendOutcome(handle: number, timeout = 20_000): Promise<string> {
    await this.page.waitForFunction(
      (id) => (window as unknown as HarnessWindow).harness.sendOutcome(id) !== 'pending',
      handle,
      { timeout },
    );
    return await this.page.evaluate(
      (id) => (window as unknown as HarnessWindow).harness.sendOutcome(id),
      handle,
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

  async receiveEventCount(name: string): Promise<number> {
    return await this.page.evaluate(
      (configName) => (window as unknown as HarnessWindow).harness.receiveEventCount(configName),
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

  /** Has the page send `line` every `everyMs` milliseconds, from a timer of its own. */
  async startTraffic(name: string, everyMs: number, line: string): Promise<void> {
    await this.page.evaluate(
      ([configName, interval, payload]) => {
        (window as unknown as HarnessWindow).harness.startTraffic(configName, interval, payload);
      },
      [name, everyMs, line] as const,
    );
  }

  async stopTraffic(): Promise<void> {
    await this.page.evaluate(() => {
      (window as unknown as HarnessWindow).harness.stopTraffic();
    });
  }

  async trafficCounts(name: string): Promise<{ readonly sent: number; readonly failed: number }> {
    return await this.page.evaluate(
      (configName) => (window as unknown as HarnessWindow).harness.trafficCounts(configName),
      name,
    );
  }

  /** Forgets everything the page harness collected, so that its memory is the library's. */
  async resetHistory(name: string): Promise<void> {
    await this.page.evaluate((configName) => {
      (window as unknown as HarnessWindow).harness.resetHistory(configName);
    }, name);
  }

  /**
   * What the page holds, after a garbage collection: heap in use, DOM nodes, event listeners.
   *
   * Read over CDP (`Performance.getMetrics`), as the memory panel of the developer tools reads
   * it; the collection first is what makes two readings comparable.
   */
  async memory(): Promise<MemorySample> {
    const session = await this.page.context().newCDPSession(this.page);
    try {
      await session.send('HeapProfiler.collectGarbage');
      await session.send('Performance.enable');
      const { metrics } = await session.send('Performance.getMetrics');
      return memorySampleOf(metrics);
    } finally {
      await session.detach();
    }
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

  /**
   * Freezes this tab, as Chromium does to one left in the background for minutes.
   *
   * A frozen page runs nothing at all - no timer, no callback, no message handler - which is the
   * state the manual plan's "hidden for more than five minutes" describes, reached without
   * waiting five minutes. This is the harshest form of a background tab, and the only one this
   * suite can ask the browser for: Chromium has no `Emulation.setPageVisibilityOverride`, and
   * `page.bringToFront()` leaves the other tabs `visible`, so a tab merely in the background
   * is staged by `test/browser/background-tab.mjs`, over the DevTools protocol alone.
   */
  async freeze(): Promise<void> {
    const session = await this.page.context().newCDPSession(this.page);
    await session.send('Page.setWebLifecycleState', { state: 'frozen' });
  }

  /** Thaws a frozen tab, as returning to it does. */
  async resume(): Promise<void> {
    const session = await this.page.context().newCDPSession(this.page);
    await session.send('Page.setWebLifecycleState', { state: 'active' });
  }

  /** Kills this tab's renderer: no unload handler runs, as in a crash or an out-of-memory kill. */
  async crash(): Promise<void> {
    await crashRenderer(this.page);
  }
}

/**
 * Opens `count` tabs, sets `name` up in every one of them and waits until all are connected.
 *
 * Every tab is set up before any is waited for, so the tabs contend for the port as tabs opened
 * together do.
 */
export async function openConnectedTabs(
  context: BrowserContext,
  count: number,
  name = 'Echo',
  options: SerialBrokerOptions = echoConfiguration(),
): Promise<[Tab, ...Tab[]]> {
  const tabs: Tab[] = [];
  for (let index = 0; index < count; index += 1) {
    tabs.push(await Tab.open(context));
  }
  for (const tab of tabs) {
    await tab.setup(name, options);
  }
  for (const tab of tabs) {
    await tab.waitForStatus(name, 'open');
  }
  const [first, ...rest] = tabs;
  if (first === undefined) {
    throw new Error('A scenario needs at least one tab.');
  }
  return [first, ...rest];
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
 * What step 28 of the manual test plan does from `chrome://inspect/#workers`: the broker is gone
 * with nothing of ours told about it, so the tabs have to notice by themselves (ADR-0041).
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

/** What a context holds, as `Performance.getMetrics` reports it. */
export interface MemorySample {
  /** `JSHeapUsedSize`, in MiB. */
  readonly heapMiB: number;
  /** `Nodes`: DOM nodes alive, detached ones included. */
  readonly nodes: number;
  /** `JSEventListeners`: listeners registered on event targets. */
  readonly listeners: number;
}

function memorySampleOf(metrics: readonly { name: string; value: number }[]): MemorySample {
  const valueOf = (name: string): number =>
    metrics.find((metric) => metric.name === name)?.value ?? Number.NaN;
  return {
    heapMiB: Math.round((valueOf('JSHeapUsedSize') / (1024 * 1024)) * 100) / 100,
    nodes: valueOf('Nodes'),
    listeners: valueOf('JSEventListeners'),
  };
}

/** What a worker holds: a worker has no DOM, and CDP counts no event listeners for it. */
export interface WorkerMemorySample {
  /** `Runtime.getHeapUsage().usedSize`, in MiB. */
  readonly heapMiB: number;
}

/**
 * What the `SharedWorker` of this tab's context holds, or `undefined` where it cannot be read.
 *
 * A worker is not a page, so the reading goes through the browser's own session: the worker
 * target is attached to, and the commands are sent to it through `Target.sendMessageToTarget`,
 * answered on `Target.receivedMessageFromTarget`. `Performance.getMetrics` is a page's domain and
 * a worker does not answer it; `Runtime.getHeapUsage` it does. Should a Chromium not answer even
 * that, `undefined` is the answer rather than a failure, and the record says so.
 */
export async function sharedWorkerMemory(tab: Tab): Promise<WorkerMemorySample | undefined> {
  const [worker] = await sharedWorkersOf(tab);
  if (worker === undefined) {
    return undefined;
  }
  const session = await browserSessionOf(tab);
  try {
    const { sessionId } = await session.send('Target.attachToTarget', {
      targetId: worker.targetId,
      flatten: false,
    });
    let nextId = 1;
    const ask = async (method: string): Promise<unknown> => {
      const id = nextId;
      nextId += 1;
      const answer = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          session.off('Target.receivedMessageFromTarget', onMessage);
          reject(new Error(`No answer to ${method} from the shared worker`));
        }, 5_000);
        const onMessage = (event: { sessionId: string; message: string }): void => {
          if (event.sessionId !== sessionId) {
            return;
          }
          const parsed = JSON.parse(event.message) as {
            id?: number;
            result?: unknown;
            error?: { message: string };
          };
          if (parsed.id !== id) {
            return;
          }
          clearTimeout(timer);
          session.off('Target.receivedMessageFromTarget', onMessage);
          if (parsed.error !== undefined) {
            reject(new Error(parsed.error.message));
          } else {
            resolve(parsed.result);
          }
        };
        session.on('Target.receivedMessageFromTarget', onMessage);
      });
      await session.send('Target.sendMessageToTarget', {
        sessionId,
        message: JSON.stringify({ id, method }),
      });
      return await answer;
    };
    try {
      await ask('HeapProfiler.collectGarbage');
      const { usedSize } = (await ask('Runtime.getHeapUsage')) as { usedSize: number };
      return { heapMiB: Math.round((usedSize / (1024 * 1024)) * 100) / 100 };
    } catch {
      // The worker did not answer, or answered with an error: a reading is not to be had from this
      // Chromium, and the caller says so in its record.
      return undefined;
    } finally {
      await session.send('Target.detachFromTarget', { sessionId }).catch(() => {
        // Already detached, or the worker went away meanwhile.
      });
    }
  } finally {
    await session.detach();
  }
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
