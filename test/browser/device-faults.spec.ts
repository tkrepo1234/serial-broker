/**
 * A device that misbehaves, and a port that is not USB, as the browser presents them.
 *
 * The in-process suite covers each of these against its fakes; here the same failures travel
 * through a real `ReadableStream`, `WritableStream`, Web Locks and message bus, and reach every tab
 * the way an application sees them (ADR-0011, ADR-0022). See ADR-0021.
 */

import { expect, test } from '@playwright/test';

import type { WebSerialStandInControl } from './stand-in/web-serial-stand-in.js';
import {
  echoConfiguration,
  GRANTED_DEVICE,
  installStandIn,
  openConnectedTabs,
  Tab,
  waitForPortHolder,
} from './support/tab.js';

test.describe('a port another program holds', () => {
  test('reports OPEN_FAILED in every tab, and opens once the port is free', async ({ context }) => {
    await installStandIn(context, GRANTED_DEVICE);
    const first = await Tab.open(context);
    const second = await Tab.open(context);
    await first.setDeviceFaults({ openFailsWith: 'NetworkError' }, [first, second]);

    await first.setup('Echo', echoConfiguration());
    await second.setup('Echo', echoConfiguration());
    await first.waitForErrorCode('OPEN_FAILED');
    await second.waitForErrorCode('OPEN_FAILED');
    expect(await first.statuses('Echo')).not.toContain('open');

    await first.setDeviceFaults({}, [first, second]);
    await first.waitForStatus('Echo', 'open');
    await second.waitForStatus('Echo', 'open');
    await second.send('Echo', 'AFTER-RELEASE');
    await first.waitForReceivedText('Echo', 'AFTER-RELEASE');
  });
});

test.describe('a write the device refuses', () => {
  test('fails with WRITE_FAILED in the tab that sent it, and the connection comes back', async ({
    context,
  }) => {
    await installStandIn(context, GRANTED_DEVICE);
    const tabs = await openConnectedTabs(context, 2, 'Echo', echoConfiguration());
    const sender = tabs[1 - (await waitForPortHolder(tabs))]!;

    await sender.setDeviceFaults({ writesFailWith: 'UnknownError' }, tabs);
    const refused = await sender.startSend('Echo', 'REFUSED');
    expect(await sender.waitForSendOutcome(refused)).toBe('error:WRITE_FAILED');

    await sender.setDeviceFaults({}, tabs);
    await sender.waitForStatus('Echo', 'open');
    await sender.send('Echo', 'AFTER-FAILURE');
    await sender.waitForReceivedText('Echo', 'AFTER-FAILURE');
    // A failed write makes the connection suspect, so the tab holding the port opened it again.
    expect(await sender.statuses('Echo')).toContain('reconnecting');
  });
});

test.describe('a device that takes no data', () => {
  test('fails the write with WRITE_TIMEOUT and delivers it once the device takes data again', async ({
    context,
  }) => {
    await installStandIn(context, GRANTED_DEVICE);
    const options = echoConfiguration({ connection: { writeTimeoutMs: 1_000 } });
    const tabs = await openConnectedTabs(context, 2, 'Echo', options);
    const sender = tabs[1 - (await waitForPortHolder(tabs))]!;

    await sender.setDeviceFaults({ writesHang: true }, tabs);
    const held = await sender.startSend('Echo', 'HELD');
    expect(await sender.waitForSendOutcome(held)).toBe('error:WRITE_TIMEOUT');
    // The browser cannot take a write back from a device holding it, so the port stays open.
    expect(await sender.statuses('Echo')).not.toContain('reconnecting');

    await sender.setDeviceFaults({}, tabs);
    await sender.waitForReceivedText('Echo', 'HELD');
    await sender.send('Echo', 'NEXT');
    await sender.waitForReceivedText('Echo', 'HELDNEXT');
  });
});

test.describe('a port without USB identity', () => {
  test('is found by the nonUsb filter, beside a granted USB adapter it leaves alone', async ({
    context,
  }) => {
    await installStandIn(context, {
      devices: [
        { ...GRANTED_DEVICE.devices[0], id: 'adapter' },
        { id: 'rs232', usb: false, granted: true },
      ],
    });
    const tab = await Tab.open(context);

    await tab.setup('Line', echoConfiguration({ device: { nonUsb: true } }));
    await tab.waitForStatus('Line', 'open');
    await tab.send('Line', 'OVER-RS232');
    await tab.waitForReceivedText('Line', 'OVER-RS232');

    const open = await tab.page.evaluate(() => {
      const control = (window as unknown as { webSerialStandIn: WebSerialStandInControl })
        .webSerialStandIn;
      return { rs232: control.isOpenHere('rs232'), adapter: control.isOpenHere('adapter') };
    });
    expect(open).toEqual({ rs232: true, adapter: false });
  });
});
