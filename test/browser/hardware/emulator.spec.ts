/**
 * The library against the USB/IP emulator, attached to Windows by usbip-win2.
 *
 * Everything below the library is real here except the device: Chromium's Web Serial, the Windows
 * serial stack, `usbser.sys` and a COM port. The device is `emulator/`, which this file starts and
 * drives itself, so it covers what a board on a cable cannot be made to do on cue - pulled out,
 * hung mid-write, answering one byte at a time - and it counts what reached the device, where the
 * Arduino suite can only look at what came back. The step numbers are the manual test plan's.
 *
 * **Requires usbip-win2** (see emulator/README.md), so it runs only when
 * `SERIAL_BROKER_HARDWARE=emulator` is set, and never in CI. Nothing else may be listening on
 * port 3240. The browser gets the port through a seeded profile, as in `arduino.spec.ts`; no
 * prompt is answered and no machine-wide setting is touched. See ADR-0021.
 */

import { writeFile } from 'node:fs/promises';
import process from 'node:process';

import { expect, test as base, type BrowserContext } from '@playwright/test';

import type { SerialBrokerOptions } from '../../../src/core/types.js';
import { echoConfiguration, openConnectedTabs, Tab } from '../support/tab.js';

import { EMULATED_DEVICE, EmulatorProcess } from './support/emulator-process.js';
import {
  holderOf,
  launchWithSerialPermission,
  occurrences,
  recordTabHistories,
} from './support/hardware-context.js';

const CONFIGURATION = 'Emulated';

/** What the platform test keeps on the page between evaluations. */
interface Held {
  readonly port: SerialPort;
  readonly writer: WritableStreamDefaultWriter<Uint8Array>;
}

const test = base.extend<{ hardware: BrowserContext }, { emulator: EmulatorProcess }>({
  // One emulator for the whole file: attaching takes seconds, and the device is put back as it
  // started before each test instead.
  emulator: [
    // eslint-disable-next-line no-empty-pattern -- Playwright's fixture signature.
    async ({}, use) => {
      const emulator = await EmulatorProcess.start();
      await use(emulator);
      await emulator.stop();
    },
    { scope: 'worker', timeout: 60_000 },
  ],
  hardware: async ({ emulator }, use, testInfo) => {
    await emulator.reset();
    const mark = emulator.lineCount;
    const context = await launchWithSerialPermission(testInfo, EMULATED_DEVICE);
    await use(context);
    // What the device saw, and what each tab went through, are the first things to look at when a
    // scenario fails - and the tabs' side is gone once the context closes.
    if (testInfo.status !== testInfo.expectedStatus) {
      await recordTabHistories(context, testInfo, CONFIGURATION);
      await writeFile(testInfo.outputPath('emulator.log'), emulator.logSince(mark));
    }
    await context.close();
  },
});

/** Opens `count` tabs and connects them to the device. */
async function connectedTabs(
  context: BrowserContext,
  count: number,
  overrides: Partial<SerialBrokerOptions> = {},
): Promise<Tab[]> {
  return await openConnectedTabs(
    context,
    count,
    CONFIGURATION,
    echoConfiguration({ device: EMULATED_DEVICE, ...overrides }),
  );
}

test.describe('the USB/IP emulator, attached by usbip-win2', () => {
  // One device: these tests cannot overlap.
  test.describe.configure({ mode: 'serial' });
  test.skip(
    process.env['SERIAL_BROKER_HARDWARE'] !== 'emulator',
    'Needs usbip-win2 on Windows; set SERIAL_BROKER_HARDWARE=emulator to run it.',
  );

  test('echoes what a single tab sends (step 3)', async ({ hardware }) => {
    const [tab] = await connectedTabs(hardware, 1);

    await tab?.send(CONFIGURATION, 'HELLO');

    await tab?.waitForReceivedText(CONFIGURATION, 'HELLO');
  });

  test('reconnects after a reload from what it remembered, with no prompt (step 4)', async ({
    hardware,
  }) => {
    const [tab] = await connectedTabs(hardware, 1, { remember: true });

    await tab?.reload();

    // No setup(): the configuration comes back from what the library remembered, and the port
    // opens on the permission the browser kept.
    expect(await tab?.restore()).toEqual([CONFIGURATION]);
    await tab?.waitForStatus(CONFIGURATION, 'open', 30_000);
    await tab?.send(CONFIGURATION, 'AFTER-RELOAD');
    await tab?.waitForReceivedText(CONFIGURATION, 'AFTER-RELOAD');
  });

  test('writes once for two tabs, and both see the one echo (steps 5, 6)', async ({
    hardware,
    emulator,
  }) => {
    const tabs = await connectedTabs(hardware, 2);
    const before = await emulator.bytesFromHost();

    await tabs[1]?.send(CONFIGURATION, 'TWO-TABS');

    for (const tab of tabs) {
      await tab.waitForReceivedText(CONFIGURATION, 'TWO-TABS');
    }
    // Counted at the device, not inferred from the echo.
    expect((await emulator.bytesFromHost()) - before).toBe('TWO-TABS'.length);
    for (const tab of tabs) {
      expect(occurrences(await tab.receivedText(CONFIGURATION), 'TWO-TABS')).toBe(1);
    }
  });

  test('keeps echoing when the tab holding the port closes (step 9)', async ({ hardware }) => {
    const tabs = await connectedTabs(hardware, 3);
    const holder = await holderOf(tabs, CONFIGURATION);
    const survivors = tabs.filter((_, index) => index !== holder);

    await tabs[holder]?.page.close();

    await holderOf(survivors, CONFIGURATION);
    await survivors[0]?.send(CONFIGURATION, 'AFTER-FAILOVER');
    for (const tab of survivors) {
      await tab.waitForReceivedText(CONFIGURATION, 'AFTER-FAILOVER', 30_000);
    }
  });

  test('hands the port on until one tab is left, and a new tab after the last connects unprompted (steps 11, 12)', async ({
    hardware,
  }) => {
    let tabs = await connectedTabs(hardware, 3, { remember: true });

    while (tabs.length > 1) {
      const holder = await holderOf(tabs, CONFIGURATION);
      await tabs[holder]?.page.close();
      tabs = tabs.filter((_, index) => index !== holder);

      await holderOf(tabs, CONFIGURATION);
      const marker = `LEFT-${String(tabs.length)}`;
      await tabs[0]?.send(CONFIGURATION, marker);
      for (const tab of tabs) {
        await tab.waitForReceivedText(CONFIGURATION, marker, 30_000);
      }
    }
    await tabs[0]?.page.close();

    // Every tab of the origin is gone; the browser kept the permission and the library the
    // configuration.
    const fresh = await Tab.open(hardware);
    expect(await fresh.restore()).toEqual([CONFIGURATION]);
    await fresh.waitForStatus(CONFIGURATION, 'open', 30_000);
    await fresh.send(CONFIGURATION, 'NEW-TAB');
    await fresh.waitForReceivedText(CONFIGURATION, 'NEW-TAB');
  });

  test('brings every tab back when the device is unplugged and plugged in (steps 13-15)', async ({
    hardware,
    emulator,
  }) => {
    const tabs = await connectedTabs(hardware, 2);

    await emulator.unplug();
    for (const tab of tabs) {
      await tab.waitForStatus(CONFIGURATION, 'reconnecting');
    }
    await emulator.plug();

    for (const tab of tabs) {
      await tab.waitForStatus(CONFIGURATION, 'open', 30_000);
    }
    await tabs[1]?.send(CONFIGURATION, 'AFTER-REPLUG');
    for (const tab of tabs) {
      await tab.waitForReceivedText(CONFIGURATION, 'AFTER-REPLUG');
    }
  });

  test('slows its retries while the device stays away, and is back as soon as it returns (steps 14, 16)', async ({
    hardware,
    emulator,
  }) => {
    test.setTimeout(180_000);
    const [tab] = await connectedTabs(hardware, 1);
    const reconnectDelays = async (): Promise<number[]> =>
      ((await tab?.logRecords()) ?? [])
        .filter((record) => record.event === 'supervisor.reconnect')
        .map((record) => Number(record.fields['delayMs']));

    await emulator.unplug();
    await tab?.waitForStatus(CONFIGURATION, 'reconnecting');

    // The default backoff doubles from 250 ms up to 30 s and draws each delay from its upper
    // half, so every delay is at least the one before, until the cap; the first to reach half of
    // the cap comes about half a minute after the loss.
    let delays = await reconnectDelays();
    const deadline = Date.now() + 120_000;
    while (!delays.some((delay) => delay >= 15_000)) {
      expect(Date.now(), `retries slowing down, so far ${delays.join(', ')} ms`).toBeLessThan(
        deadline,
      );
      await tab?.page.waitForTimeout(500);
      delays = await reconnectDelays();
    }
    expect(delays).toEqual([...delays].sort((a, b) => a - b));
    expect(delays.length).toBeGreaterThanOrEqual(5);

    // Plugged in during that wait, the device is used at once: the browser's connect event cuts
    // the delay short.
    const waiting = delays.at(-1) ?? 0;
    const pluggedAt = Date.now();
    await emulator.plug();
    await tab?.waitForStatus(CONFIGURATION, 'open', 30_000);
    expect(Date.now() - pluggedAt).toBeLessThan(waiting);
    await tab?.send(CONFIGURATION, 'AFTER-BACKOFF');
    await tab?.waitForReceivedText(CONFIGURATION, 'AFTER-BACKOFF');
  });

  test('asks for the device again after releasing it with forgetDevice (step 19)', async ({
    hardware,
  }) => {
    const [tab] = await connectedTabs(hardware, 1);

    await tab?.release(CONFIGURATION, true);
    await tab?.setup(CONFIGURATION, echoConfiguration({ device: EMULATED_DEVICE }));

    // The browser no longer has a permission for the port: nothing opens until the user picks it,
    // in this tab or in a new one.
    await tab?.waitForStatus(CONFIGURATION, 'awaiting-permission');
    const other = await Tab.open(hardware);
    await other.setup(CONFIGURATION, echoConfiguration({ device: EMULATED_DEVICE }));
    await other.waitForStatus(CONFIGURATION, 'awaiting-permission');
  });

  test('resolves a write that fits the port buffer, though the hung device took none of it (step 17)', async ({
    hardware,
    emulator,
  }) => {
    const [tab] = await connectedTabs(hardware, 1, { connection: { writeTimeoutMs: 2_000 } });
    const before = await emulator.bytesFromHost();

    await emulator.run('hang', /hung: writes stay in flight/);
    const mark = emulator.lineCount;
    const handle = await tab?.startSend(CONFIGURATION, 'INTO-THE-BUFFER');

    // Chromium resolves a Web Serial write once its bytes are in the port's buffer
    // (`serial.bufferSize`, 255 bytes by default); that the device has not taken them is not
    // something the page is told. This pins that down, because the documentation has to say it.
    expect(await tab?.waitForSendOutcome(handle ?? -1, 15_000)).toBe('sent');
    await emulator.waitForLine(/write held/, mark);
    expect(await emulator.bytesFromHost()).toBe(before);

    // Once the device takes data again, the buffered bytes arrive, once.
    await emulator.run('resume', /resumed/);
    await tab?.waitForReceivedText(CONFIGURATION, 'INTO-THE-BUFFER');
  });

  test('fails a write larger than the port buffer with WRITE_TIMEOUT while the device hangs (step 17)', async ({
    hardware,
    emulator,
  }) => {
    const [tab] = await connectedTabs(hardware, 1, { connection: { writeTimeoutMs: 2_000 } });

    await emulator.run('hang', /hung: writes stay in flight/);
    const handle = await tab?.startSend(CONFIGURATION, 'X'.repeat(4_096));

    expect(await tab?.waitForSendOutcome(handle ?? -1, 15_000)).toBe('error:WRITE_TIMEOUT');

    // And once the device answers again, so does the port.
    await emulator.run('resume', /resumed/);
    await tab?.waitForStatus(CONFIGURATION, 'open', 30_000);
    await tab?.send(CONFIGURATION, 'AFTER-HANG');
    await tab?.waitForReceivedText(CONFIGURATION, 'AFTER-HANG', 30_000);
  });

  test('decodes text whose characters every read cuts apart (step 21)', async ({
    hardware,
    emulator,
  }) => {
    // Every read on its own, so that the decoder, not the collecting, has to join the pieces.
    const [tab] = await connectedTabs(hardware, 1, { receive: { idleMs: 0 } });
    const text = 'Grüße, 温度 - Grüße, 温度';

    await emulator.run('chunk 1', /reads capped at 1 bytes/);
    await tab?.send(CONFIGURATION, text);

    // One byte per read: every multi-byte character arrives in pieces.
    await tab?.waitForReceivedText(CONFIGURATION, text);
    expect(await tab?.receivedText(CONFIGURATION)).toBe(text);
  });

  test('delivers an answer read one byte at a time as one event (ADR-0002)', async ({
    hardware,
    emulator,
  }) => {
    const [tab] = await connectedTabs(hardware, 1);

    await emulator.run('chunk 1', /reads capped at 1 bytes/);
    await tab?.send(CONFIGURATION, '1234\r\n');

    await tab?.waitForReceivedText(CONFIGURATION, '1234\r\n');
    await tab?.page.waitForTimeout(300);
    expect(await tab?.receiveEventCount(CONFIGURATION)).toBe(1);
  });

  test('echoes 64 KiB of every byte value, in order (steps 20, 22)', async ({ hardware }) => {
    test.setTimeout(240_000);
    const [tab] = await connectedTabs(hardware, 1, {
      encoding: { decodeText: false },
      connection: { writeTimeoutMs: 120_000 },
    });
    const seed = Math.floor(Math.random() * 1_000_000);

    await tab?.sendPattern(CONFIGURATION, 65_536, seed);

    await tab?.waitForPatternRun(CONFIGURATION, 65_536, 180_000);
  });

  // Not the library: Web Serial alone. This is the platform behaviour ADR-0011 rests on, pinned so
  // that a browser which changes it fails here rather than silently.
  test('cannot abort, close or reopen a port while the device holds a write (ADR-0011)', async ({
    hardware,
    emulator,
  }) => {
    const page = await hardware.newPage();
    await page.goto('/tab.html');
    await page.evaluate(async () => {
      const [port] = await navigator.serial.getPorts();
      if (port === undefined) {
        throw new Error('The profile granted no port.');
      }
      await port.open({ baudRate: 9_600 });
      const writer = port.writable?.getWriter();
      if (writer === undefined) {
        throw new Error('The port opened without a writable stream.');
      }
      Object.assign(window, { held: { port, writer } });
    });

    await emulator.run('hang', /hung: writes stay in flight/);
    const mark = emulator.lineCount;
    await page.evaluate(() => {
      const { writer } = (window as unknown as { held: Held }).held;
      writer.write(new Uint8Array(4_096)).catch(() => undefined);
    });
    await emulator.waitForLine(/write held/, mark);

    const whileHung = await page.evaluate(async () => {
      const held = (window as unknown as { held: Held & { aborted?: Promise<void> } }).held;
      held.aborted = held.writer.abort();
      return await outcomeWithin(held.aborted, 3_000);

      async function outcomeWithin(operation: Promise<unknown>, ms: number): Promise<string> {
        return await Promise.race([
          operation.then(
            () => 'settled',
            (error: unknown) => `rejected: ${String(error)}`,
          ),
          new Promise<string>((resolve) => setTimeout(() => resolve('pending'), ms)),
        ]);
      }
    });
    expect(whileHung).toBe('pending');

    // Taking data again does not free it.
    await emulator.run('resume', /resumed/);
    const afterResume = await page.evaluate(async () => {
      const held = (window as unknown as { held: Held & { aborted: Promise<void> } }).held;
      const abort = await outcomeWithin(held.aborted, 3_000);
      held.writer.releaseLock();
      const close = await outcomeWithin(held.port.close(), 3_000);
      const reopen = await outcomeWithin(held.port.open({ baudRate: 9_600 }), 3_000);
      return { abort, close, reopen };

      async function outcomeWithin(operation: Promise<unknown>, ms: number): Promise<string> {
        return await Promise.race([
          operation.then(
            () => 'settled',
            (error: unknown) => `rejected: ${String(error)}`,
          ),
          new Promise<string>((resolve) => setTimeout(() => resolve('pending'), ms)),
        ]);
      }
    });
    expect(afterResume.abort).toBe('pending');
    expect(afterResume.close).toBe('pending');
    expect(afterResume.reopen).toContain('already open');
  });

  test('never repeats a write whose owner died in the middle of it (step 24)', async ({
    hardware,
    emulator,
  }) => {
    // Larger than the port's buffer, so that the write is still unfinished when its owner dies;
    // a smaller one is resolved by the browser before the device has taken anything.
    const payload = `ONCE-ONLY-${'x'.repeat(1_024)}`;
    const tabs = await connectedTabs(hardware, 2, { connection: { writeTimeoutMs: 30_000 } });
    const holder = await holderOf(tabs, CONFIGURATION);
    const writer = tabs[holder === 0 ? 1 : 0];
    const before = await emulator.bytesFromHost();

    // The write reaches the device and stays there, begun and unanswered, while its owner dies.
    await emulator.run('hang', /hung: writes stay in flight/);
    const mark = emulator.lineCount;
    const handle = await writer?.startSend(CONFIGURATION, payload);
    await emulator.waitForLine(/write held/, mark);
    await tabs[holder]?.crash();

    // Undecidable, so it is failed - not handed to the next owner.
    expect(await writer?.waitForSendOutcome(handle ?? -1, 30_000)).toBe(
      'error:OWNER_LOST_DURING_WRITE',
    );
    await holderOf(writer === undefined ? [] : [writer], CONFIGURATION);
    await emulator.run('resume', /resumed/);
    await writer?.send(CONFIGURATION, 'AFTER-OWNER-LOST');
    await writer?.waitForReceivedText(CONFIGURATION, 'AFTER-OWNER-LOST');

    // The device got the bytes at most once, whether Windows cancelled the held write or not.
    const received = (await emulator.bytesFromHost()) - before - 'AFTER-OWNER-LOST'.length;
    expect(received).toBeLessThanOrEqual(payload.length);
    expect(
      occurrences((await writer?.receivedText(CONFIGURATION)) ?? '', 'ONCE-ONLY'),
    ).toBeLessThan(2);
  });
});
