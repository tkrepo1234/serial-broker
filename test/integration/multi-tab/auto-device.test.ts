import { describe, expect, it } from 'vitest';

import { SerialBrokerClient } from '../../../src/client/serial-broker-client.js';
import { SerialBrokerErrorCode } from '../../../src/core/error-codes.js';
import { SerialBrokerStatus } from '../../../src/core/types.js';
import { BrowserHarness, TRANSPORT_MODES } from '../../harness/browser-harness.js';
import { READER } from '../../harness/devices.js';
import type { FakeDevice } from '../../harness/fake-serial.js';
import { fieldsOfEvent, recordingLogger } from '../../harness/recording-logger.js';
import { remember, rememberedEntry } from '../../harness/stored-configurations.js';

/**
 * Auto mode: a configuration set up without a device takes it from the port the user chooses,
 * remembers it, and shares it with the other tabs of the configuration (ADR-0036).
 */

/** Setup options in auto mode: no device at all. */
const AUTO = { serial: { baudRate: 9600 } };
const OTHER = { vendorId: 0x0403, productId: 0x6001 };

describe('a configuration in auto mode', () => {
  it('waits for the user even when exactly one port is granted', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);

    const tab = harness.openTab();
    await tab.setup('Reader', AUTO);

    // The safer default: the one granted port may belong to another configuration, and auto mode
    // promises the device the user chose, not the one that happened to be there.
    const status = tab.client.getStatus('Reader');
    expect(status.status).toBe(SerialBrokerStatus.AwaitingPermission);
    expect(status.deviceKind).toBe('auto');
    expect(status.vendorId).toBeUndefined();
    expect(device.isOpen).toBe(false);
  });

  it('takes no device from a picker that was still open when the tab released the configuration', async () => {
    const { logger, records } = recordingLogger();
    const harness = new BrowserHarness({ logger });
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.pickerQueue.push(device);
    // A picker that stays open until the test has the user choose.
    let choose = (): void => undefined;
    const open = new Promise<void>((resolve) => (choose = resolve));
    const environment = harness.createEnvironment('picking');
    const client = new SerialBrokerClient({
      ...environment,
      serial: {
        ...environment.serial,
        requestPort: async (options) => {
          await open;
          return await environment.serial.requestPort(options);
        },
      },
    });
    const other = harness.openTab();
    await client.setup('Reader', AUTO);
    await other.setup('Reader', AUTO);

    const asked = client.requestAccess('Reader');
    await client.release('Reader');
    choose();

    await expect(asked).rejects.toMatchObject({
      code: SerialBrokerErrorCode.CONFIGURATION_RELEASED,
    });
    await harness.settle();

    // A tab that has left gives the configuration nothing: the others would be sent to a device
    // by somebody who is no longer part of it.
    expect(fieldsOfEvent(records, 'session.device-resolved')).toEqual([]);
    expect(other.client.getStatus('Reader')).toMatchObject({ deviceKind: 'auto' });
    expect(other.client.getStatus('Reader').vendorId).toBeUndefined();
    expect(device.isOpen).toBe(false);
  });

  it('is the same with { auto: true } spelled out', async () => {
    const harness = new BrowserHarness();
    harness.serial.grant(harness.serial.addDevice(READER.vendorId, READER.productId));

    const tab = harness.openTab();
    await tab.setup('Reader', { device: { auto: true }, ...AUTO });

    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.AwaitingPermission);
  });

  it('takes the USB identity of the port the user picks, and connects to it', async () => {
    const { logger, records } = recordingLogger();
    const harness = new BrowserHarness({ logger });
    const other = harness.serial.addDevice(OTHER.vendorId, OTHER.productId);
    harness.serial.grant(other);
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);

    const tab = harness.openTab();
    await tab.setup('Reader', AUTO);
    harness.serial.pickerQueue.push(device);
    const granted = await tab.client.requestAccess('Reader');
    await harness.settle();

    expect(granted).toBe(true);
    expect(tab.client.getStatus('Reader')).toMatchObject({
      status: SerialBrokerStatus.Open,
      deviceKind: 'usb',
      vendorId: READER.vendorId,
      productId: READER.productId,
    });
    // The device the user chose, not the one that was granted before.
    expect(device.isOpen).toBe(true);
    expect(other.isOpen).toBe(false);
    expect(fieldsOfEvent(records, 'session.device-resolved')).toEqual([
      expect.objectContaining({
        configName: 'Reader',
        source: 'picker',
        device: 'usb',
        vendorId: READER.vendorId,
        productId: READER.productId,
      }),
    ]);
  });

  it('becomes a configuration for ports without USB identity when the picked port has none', async () => {
    const harness = new BrowserHarness();
    const usb = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(usb);
    const bare = harness.serial.addNonUsbPort();

    const tab = harness.openTab();
    await tab.setup('Reader', AUTO);
    harness.serial.pickerQueue.push(bare);
    await expect(tab.client.requestAccess('Reader')).resolves.toBe(true);
    await harness.settle();

    expect(tab.client.getStatus('Reader')).toMatchObject({
      status: SerialBrokerStatus.Open,
      deviceKind: 'non-usb',
      vendorId: undefined,
      productId: undefined,
    });
    expect(bare.isOpen).toBe(true);
    expect(usb.isOpen).toBe(false);

    // From now on the configuration matches only ports without a USB identity: when the port goes
    // away, the granted USB adapter is not taken in its place.
    harness.serial.unplug(bare);
    await harness.settle();
    await harness.advance(60_000);
    expect(usb.isOpen).toBe(false);
    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Reconnecting);
  });

  it('opens the picker unfiltered, so a port without USB identity can be chosen at all', async () => {
    const harness = new BrowserHarness();
    const bare = harness.serial.addNonUsbPort();

    const tab = harness.openTab();
    await tab.setup('Reader', AUTO);
    // The harness offers only what a filter admits; a non-USB port is admitted by no filter.
    harness.serial.pickerQueue.push(bare);

    await expect(tab.client.requestAccess('Reader')).resolves.toBe(true);
  });

  it('can ask for the port in the same gesture as setup(), before it holds the port', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.pickerQueue.push(device);

    const tab = harness.openTab();
    // No settling in between: the ownership election has not been decided when the picker opens,
    // which is exactly when a click that sets a configuration up would ask.
    await tab.client.setup('Reader', AUTO);
    const granted = await tab.client.requestAccess('Reader');
    await harness.settle();

    expect(granted).toBe(true);
    expect(tab.client.getStatus('Reader')).toMatchObject({
      status: SerialBrokerStatus.Open,
      deviceKind: 'usb',
      vendorId: READER.vendorId,
    });
    expect(device.isOpen).toBe(true);
  });

  it('lets a tab that does not hold the port choose the device, which the holding tab adopts', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    const owner = harness.openTab();
    await owner.setup('Reader', AUTO);
    const other = harness.openTab();
    await other.setup('Reader', AUTO);

    harness.serial.pickerQueue.push(device);
    await expect(other.client.requestAccess('Reader')).resolves.toBe(true);
    await harness.settle();

    expect(owner.client.getStatus('Reader')).toMatchObject({
      status: SerialBrokerStatus.Open,
      deviceKind: 'usb',
      vendorId: READER.vendorId,
    });
    expect(other.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
    expect(device.isOpen).toBe(true);
  });

  it('remembers the resolved device, so a later visit reconnects without a prompt', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);

    const first = harness.openTab();
    await first.setup('Reader', AUTO);
    harness.serial.pickerQueue.push(device);
    await first.client.requestAccess('Reader');
    await harness.settle();

    expect(rememberedEntry(harness.storage, 'Reader')).toMatchObject({
      device: { auto: true, resolved: READER },
    });
    await first.close();

    const reloaded = harness.openTab();
    await expect(reloaded.client.restore()).resolves.toEqual(['Reader']);
    await harness.settle();

    expect(reloaded.client.getStatus('Reader')).toMatchObject({
      status: SerialBrokerStatus.Open,
      deviceKind: 'usb',
      vendorId: READER.vendorId,
      productId: READER.productId,
    });
    expect(harness.serial.pickerQueue).toEqual([]);
  });

  it('restores a remembered auto-mode configuration that never resolved as one that waits', async () => {
    const harness = new BrowserHarness();
    harness.serial.grant(harness.serial.addDevice(READER.vendorId, READER.productId));
    remember(harness.storage, { Reader: { device: { auto: true }, serial: { baudRate: 9600 } } });

    const tab = harness.openTab();
    await expect(tab.client.restore()).resolves.toEqual(['Reader']);
    await harness.settle();

    expect(tab.client.getStatus('Reader')).toMatchObject({
      status: SerialBrokerStatus.AwaitingPermission,
      deviceKind: 'auto',
    });
  });

  it('remembers a non-USB resolution too', async () => {
    const harness = new BrowserHarness();
    const bare = harness.serial.addNonUsbPort();

    const first = harness.openTab();
    await first.setup('Reader', AUTO);
    harness.serial.pickerQueue.push(bare);
    await first.client.requestAccess('Reader');
    await harness.settle();
    await first.close();

    expect(rememberedEntry(harness.storage, 'Reader')).toMatchObject({
      device: { auto: true, resolved: { nonUsb: true } },
    });
    const reloaded = harness.openTab();
    await reloaded.client.restore();
    await harness.settle();

    expect(reloaded.client.getStatus('Reader')).toMatchObject({
      status: SerialBrokerStatus.Open,
      deviceKind: 'non-usb',
    });
  });

  it('does not conflict with a later setup() of the same name in auto mode', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);

    const tab = harness.openTab();
    await tab.setup('Reader', AUTO);
    harness.serial.pickerQueue.push(device);
    await tab.client.requestAccess('Reader');
    await harness.settle();

    // The usual pattern: `restore()` brought the resolved configuration back, and the page calls
    // `setup()` regardless. The running configuration keeps its device.
    await expect(tab.client.setup('Reader', AUTO)).resolves.toBeUndefined();
    await expect(tab.client.setup('Reader', { device: { auto: true }, ...AUTO })).resolves.toBe(
      undefined,
    );
    expect(tab.client.getStatus('Reader')).toMatchObject({
      status: SerialBrokerStatus.Open,
      vendorId: READER.vendorId,
    });
  });

  it('does not conflict with an explicit setup() of the device it resolved to, but with another', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);

    const tab = harness.openTab();
    await tab.setup('Reader', AUTO);
    harness.serial.pickerQueue.push(device);
    await tab.client.requestAccess('Reader');
    await harness.settle();

    await expect(tab.client.setup('Reader', { device: READER, ...AUTO })).resolves.toBe(undefined);
    await expect(tab.client.setup('Reader', { device: OTHER, ...AUTO })).rejects.toMatchObject({
      code: SerialBrokerErrorCode.CONFIGURATION_CONFLICT,
      context: {
        existing: { kind: 'auto', resolved: { kind: 'usb', ...READER } },
        requested: { kind: 'usb', ...OTHER },
      },
    });
  });

  it('lets auto mode follow an explicit configuration set up in the same tab first', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);

    const tab = harness.openTab();
    await tab.setup('Reader', { device: READER, ...AUTO });

    // Auto mode has committed to nothing, so it is compatible with whatever runs; the explicit
    // configuration stays what it is.
    await expect(tab.client.setup('Reader', AUTO)).resolves.toBeUndefined();
    expect(tab.client.getStatus('Reader')).toMatchObject({
      status: SerialBrokerStatus.Open,
      deviceKind: 'usb',
    });
  });
});

/**
 * The first visit: a tab sets the name up in auto mode, the user picks `device`, and the tab closes -
 * leaving the resolution remembered, as a page that is navigated away from does.
 */
async function chooseOnFirstVisit(harness: BrowserHarness, device: FakeDevice): Promise<void> {
  const first = harness.openTab();
  await first.setup('Reader', AUTO);
  harness.serial.pickerQueue.push(device);
  await first.client.requestAccess('Reader');
  await harness.settle();
  await first.close();
  await harness.settle();
}

describe.each(TRANSPORT_MODES)('a later visit in auto mode (%s)', (transport) => {
  it('opens the remembered device with setup() alone, without a prompt', async () => {
    const { logger, records } = recordingLogger();
    const harness = new BrowserHarness({ transport, logger });
    const other = harness.serial.addDevice(OTHER.vendorId, OTHER.productId);
    harness.serial.grant(other);
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    await chooseOnFirstVisit(harness, device);

    // The page the Quickstart teaches: `setup()` on every load, no `restore()`, and no
    // `requestAccess()` - so nothing could have opened a picker.
    const later = harness.openTab();
    await later.setup('Reader', AUTO);
    await harness.settle();

    expect(later.client.getStatus('Reader')).toMatchObject({
      status: SerialBrokerStatus.Open,
      deviceKind: 'usb',
      vendorId: READER.vendorId,
      productId: READER.productId,
    });
    expect(device.isOpen).toBe(true);
    expect(other.isOpen).toBe(false);
    expect(later.errorCodes('Reader')).toEqual([]);
    expect(fieldsOfEvent(records, 'session.device-resolved')).toContainEqual(
      expect.objectContaining({ configName: 'Reader', source: 'remembered', device: 'usb' }),
    );
  });

  it('keeps the resolution in the remembered entry that setup() saves', async () => {
    const harness = new BrowserHarness({ transport });
    const bare = harness.serial.addNonUsbPort();
    await chooseOnFirstVisit(harness, bare);

    const later = harness.openTab();
    await later.setup('Reader', { ...AUTO, serial: { baudRate: 19_200 } });
    await harness.settle();

    // The line settings are the ones this visit passed; the device is the one the user chose.
    expect(rememberedEntry(harness.storage, 'Reader')).toMatchObject({
      device: { auto: true, resolved: { nonUsb: true } },
      serial: { baudRate: 19_200 },
    });
    expect(later.client.getStatus('Reader')).toMatchObject({
      status: SerialBrokerStatus.Open,
      deviceKind: 'non-usb',
    });
    await later.close();
    expect(rememberedEntry(harness.storage, 'Reader')).toMatchObject({
      device: { auto: true, resolved: { nonUsb: true } },
    });
  });

  it('still lets restore() reconnect, after setup() and on the visit after that', async () => {
    const harness = new BrowserHarness({ transport });
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    await chooseOnFirstVisit(harness, device);

    const second = harness.openTab();
    await second.setup('Reader', AUTO);
    // Already set up in this tab, so there is nothing more to restore, and nothing is disturbed.
    await expect(second.client.restore()).resolves.toEqual([]);
    await harness.settle();
    expect(second.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
    await second.close();
    await harness.settle();

    const third = harness.openTab();
    await expect(third.client.restore()).resolves.toEqual(['Reader']);
    await harness.settle();
    expect(third.client.getStatus('Reader')).toMatchObject({
      status: SerialBrokerStatus.Open,
      deviceKind: 'usb',
      vendorId: READER.vendorId,
    });
  });

  it('lets an explicit setup() ignore a remembered auto-mode resolution of the same name', async () => {
    const harness = new BrowserHarness({ transport });
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const other = harness.serial.addDevice(OTHER.vendorId, OTHER.productId);
    harness.serial.grant(other);
    remember(harness.storage, {
      Reader: { device: { auto: true, resolved: READER }, serial: { baudRate: 9600 } },
    });

    const tab = harness.openTab();
    await tab.setup('Reader', { device: OTHER, ...AUTO });
    await harness.settle();

    expect(tab.client.getStatus('Reader')).toMatchObject({
      status: SerialBrokerStatus.Open,
      deviceKind: 'usb',
      vendorId: OTHER.vendorId,
      productId: OTHER.productId,
    });
    expect(other.isOpen).toBe(true);
    expect(device.isOpen).toBe(false);
    expect((rememberedEntry(harness.storage, 'Reader') as { device: unknown }).device).toEqual(
      OTHER,
    );

    // The name is set up now, so an auto-mode setup() is judged against what runs - compatible, as
    // an unresolved auto-mode filter always is - and reads nothing remembered.
    await expect(tab.client.setup('Reader', AUTO)).resolves.toBeUndefined();
    expect(tab.client.getStatus('Reader').vendorId).toBe(OTHER.vendorId);
  });
});

describe('what a later visit in auto mode takes from the remembered entry', () => {
  it.each([
    ['USB IDs', READER],
    ['any port', { any: true }],
    ['a port without USB identity', { nonUsb: true }],
  ])('takes nothing from an entry naming %s explicitly', async (_label, remembered) => {
    const harness = new BrowserHarness();
    harness.serial.grant(harness.serial.addDevice(READER.vendorId, READER.productId));
    harness.serial.grant(harness.serial.addNonUsbPort());
    remember(harness.storage, { Reader: { device: remembered, serial: { baudRate: 9600 } } });

    const tab = harness.openTab();
    await tab.setup('Reader', AUTO);
    await harness.settle();

    // Not a choice the user made in auto mode: the configuration waits for one, and says so.
    expect(tab.client.getStatus('Reader')).toMatchObject({
      status: SerialBrokerStatus.AwaitingPermission,
      deviceKind: 'auto',
    });
    expect(rememberedEntry(harness.storage, 'Reader')).toMatchObject({ device: { auto: true } });
  });

  it('takes nothing for a configuration set up with remember: false', async () => {
    const harness = new BrowserHarness();
    harness.serial.grant(harness.serial.addDevice(READER.vendorId, READER.productId));
    remember(harness.storage, {
      Reader: { device: { auto: true, resolved: READER }, serial: { baudRate: 9600 } },
    });

    const tab = harness.openTab();
    await tab.setup('Reader', { ...AUTO, remember: false });
    await harness.settle();

    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.AwaitingPermission);
  });

  it('lets a resolution passed to setup() win over the remembered one', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const other = harness.serial.addDevice(OTHER.vendorId, OTHER.productId);
    harness.serial.grant(other);
    remember(harness.storage, {
      Reader: { device: { auto: true, resolved: OTHER }, serial: { baudRate: 9600 } },
    });

    const tab = harness.openTab();
    await tab.setup('Reader', { device: { auto: true, resolved: READER }, ...AUTO });
    await harness.settle();

    expect(tab.client.getStatus('Reader').vendorId).toBe(READER.vendorId);
    expect(device.isOpen).toBe(true);
    expect(other.isOpen).toBe(false);
    expect(rememberedEntry(harness.storage, 'Reader')).toMatchObject({
      device: { auto: true, resolved: READER },
    });
  });
});

describe.each(TRANSPORT_MODES)('auto mode across tabs (%s)', (transport) => {
  it('adopts the device the tab holding the port resolved, and uses it when it takes over', async () => {
    const harness = new BrowserHarness({ transport });
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);

    const first = harness.openTab();
    await first.setup('Reader', AUTO);
    harness.serial.pickerQueue.push(device);
    await first.client.requestAccess('Reader');
    await harness.settle();

    const second = harness.openTab();
    await second.setup('Reader', AUTO);

    // The second tab learns the device from the first tab's status, and reports and remembers it
    // as its own.
    expect(second.client.getStatus('Reader')).toMatchObject({
      status: SerialBrokerStatus.Open,
      deviceKind: 'usb',
      vendorId: READER.vendorId,
      productId: READER.productId,
    });
    expect(second.client.diagnostics()?.configurations[0]?.settings.device).toEqual({
      auto: true,
      resolved: READER,
    });

    // With the first tab gone, the second opens the same device without asking anyone.
    await first.close();
    await harness.settle();
    expect(second.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
    expect(device.isOpen).toBe(true);
    expect(device.openCount).toBe(2);
    expect(harness.serial.pickerQueue).toEqual([]);
  });

  it('adopts a non-USB resolution as well', async () => {
    const harness = new BrowserHarness({ transport });
    const bare = harness.serial.addNonUsbPort();

    const first = harness.openTab();
    await first.setup('Reader', AUTO);
    harness.serial.pickerQueue.push(bare);
    await first.client.requestAccess('Reader');
    await harness.settle();

    const second = harness.openTab();
    await second.setup('Reader', AUTO);

    expect(second.client.getStatus('Reader')).toMatchObject({
      status: SerialBrokerStatus.Open,
      deviceKind: 'non-usb',
    });
  });

  it('filters its own picker by the adopted device', async () => {
    const harness = new BrowserHarness({ transport });
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    const other = harness.serial.addDevice(OTHER.vendorId, OTHER.productId);

    const first = harness.openTab();
    await first.setup('Reader', AUTO);
    harness.serial.pickerQueue.push(device);
    await first.client.requestAccess('Reader');
    await harness.settle();
    const second = harness.openTab();
    await second.setup('Reader', AUTO);
    await first.close();
    await harness.settle();

    // The second tab holds the port now. Its picker offers only the adopted device, so another one
    // cannot be chosen - the picker can only be dismissed.
    harness.serial.unplug(device);
    await harness.settle();
    harness.serial.pickerQueue.push(other);
    await expect(second.client.requestAccess('Reader')).resolves.toBe(false);
  });

  it('adopts the device of a tab set up explicitly, and an explicit tab adopts nothing', async () => {
    const harness = new BrowserHarness({ transport });
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const other = harness.serial.addDevice(OTHER.vendorId, OTHER.productId);
    harness.serial.grant(other);

    const explicit = harness.openTab();
    await explicit.setup('Reader', { device: READER, ...AUTO });
    const auto = harness.openTab();
    await auto.setup('Reader', AUTO);

    expect(auto.client.getStatus('Reader')).toMatchObject({
      status: SerialBrokerStatus.Open,
      deviceKind: 'usb',
      vendorId: READER.vendorId,
    });

    // An explicit configuration keeps its device whatever the tab holding the port runs: tab A
    // resolved to X, tab B named Y. Neither reports a conflict - serial-broker does not compare
    // devices between tabs - and each opens its own device when it holds the port.
    const named = harness.openTab();
    await named.setup('Reader', { device: OTHER, ...AUTO });
    expect(named.client.getStatus('Reader')).toMatchObject({
      status: SerialBrokerStatus.Open,
      vendorId: OTHER.vendorId,
    });
    expect(named.errorCodes('Reader')).toEqual([]);
    expect(explicit.errorCodes('Reader')).toEqual([]);
  });

  it('follows the tab holding the port when it resolves to something else than this tab chose', async () => {
    const harness = new BrowserHarness({ transport });
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    const other = harness.serial.addDevice(OTHER.vendorId, OTHER.productId);
    harness.serial.pickerQueue.push(other, device);

    // Both tabs ask in the same gesture as their setup, before either holds the port; the tab
    // that ends up holding it decides.
    const first = harness.openTab();
    await first.client.setup('Reader', AUTO);
    await first.client.requestAccess('Reader');
    const second = harness.openTab();
    await second.client.setup('Reader', AUTO);
    await second.client.requestAccess('Reader');
    await harness.settle();

    const holder = first.client.getStatus('Reader');
    expect(holder.status).toBe(SerialBrokerStatus.Open);
    expect(second.client.getStatus('Reader')).toMatchObject({
      status: SerialBrokerStatus.Open,
      vendorId: holder.vendorId,
      productId: holder.productId,
    });
    expect(rememberedEntry(harness.storage, 'Reader')).toMatchObject({
      device: { auto: true, resolved: { vendorId: holder.vendorId, productId: holder.productId } },
    });
  });
});

/** Two tabs in auto mode on `device`, chosen in the first, which holds the port. */
async function twoTabsOn(harness: BrowserHarness, device: FakeDevice) {
  const first = harness.openTab();
  await first.setup('Reader', AUTO);
  harness.serial.pickerQueue.push(device);
  await first.client.requestAccess('Reader');
  await harness.settle();
  const second = harness.openTab();
  await second.setup('Reader', AUTO);
  await harness.settle();
  return { first, second };
}

describe.each(TRANSPORT_MODES)('choosing a different device in auto mode (%s)', (transport) => {
  it.each(['holding', 'other'] as const)(
    'moves every tab to the new device when the %s tab chooses again while open',
    async (chooser) => {
      const harness = new BrowserHarness({ transport });
      const device = harness.serial.addDevice(READER.vendorId, READER.productId);
      const replacement = harness.serial.addDevice(OTHER.vendorId, OTHER.productId);
      const tabs = await twoTabsOn(harness, device);
      expect(tabs.second.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);

      const tab = chooser === 'holding' ? tabs.first : tabs.second;
      harness.serial.pickerQueue.push(replacement);
      await expect(tab.client.requestAccess('Reader', { chooseAgain: true })).resolves.toBe(true);
      await harness.settle();
      await harness.settle();

      expect(replacement.isOpen).toBe(true);
      expect(device.isOpen).toBe(false);
      for (const each of [tabs.first, tabs.second]) {
        expect(each.client.getStatus('Reader')).toMatchObject({
          status: SerialBrokerStatus.Open,
          deviceKind: 'usb',
          vendorId: OTHER.vendorId,
          productId: OTHER.productId,
        });
        expect(each.errorCodes('Reader')).toEqual([]);
      }
      expect(rememberedEntry(harness.storage, 'Reader')).toMatchObject({
        device: { auto: true, resolved: OTHER },
      });

      // The next tab to hold the port opens the new device too.
      await tabs.first.close();
      await harness.settle();
      expect(tabs.second.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
      expect(replacement.isOpen).toBe(true);
    },
  );

  it('offers every port in the picker, not only the device it resolved to', async () => {
    const harness = new BrowserHarness({ transport });
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    const bare = harness.serial.addNonUsbPort();
    const { first } = await twoTabsOn(harness, device);

    harness.serial.pickerQueue.push(bare);
    await expect(first.client.requestAccess('Reader', { chooseAgain: true })).resolves.toBe(true);
    await harness.settle();

    expect(first.client.getStatus('Reader')).toMatchObject({
      status: SerialBrokerStatus.Open,
      deviceKind: 'non-usb',
    });
    expect(bare.isOpen).toBe(true);
    expect(device.isOpen).toBe(false);
  });

  it('changes nothing when the picker is dismissed', async () => {
    const harness = new BrowserHarness({ transport });
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    const { first, second } = await twoTabsOn(harness, device);
    const opened = device.openCount;

    await expect(second.client.requestAccess('Reader', { chooseAgain: true })).resolves.toBe(false);
    await expect(first.client.requestAccess('Reader', { chooseAgain: true })).resolves.toBe(false);
    await harness.settle();

    expect(device.openCount).toBe(opened);
    expect(device.isOpen).toBe(true);
    for (const tab of [first, second]) {
      expect(tab.client.getStatus('Reader')).toMatchObject({
        status: SerialBrokerStatus.Open,
        vendorId: READER.vendorId,
      });
    }
    expect(rememberedEntry(harness.storage, 'Reader')).toMatchObject({
      device: { auto: true, resolved: READER },
    });
  });

  it('keeps the connection when the same device is chosen again', async () => {
    const harness = new BrowserHarness({ transport });
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    const { first } = await twoTabsOn(harness, device);
    const opened = device.openCount;

    harness.serial.pickerQueue.push(device);
    await expect(first.client.requestAccess('Reader', { chooseAgain: true })).resolves.toBe(true);
    await harness.settle();

    expect(device.openCount).toBe(opened);
    expect(first.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
  });

  it('is refused for a configuration that names its device', async () => {
    const harness = new BrowserHarness({ transport });
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const other = harness.serial.addDevice(OTHER.vendorId, OTHER.productId);
    const tab = harness.openTab();
    await tab.setup('Reader', { device: READER, ...AUTO });
    harness.serial.pickerQueue.push(other);

    await expect(tab.client.requestAccess('Reader', { chooseAgain: true })).rejects.toMatchObject({
      code: SerialBrokerErrorCode.INVALID_ARGUMENT,
      message: expect.stringContaining('set it up with the other device') as unknown,
    });
    expect(harness.serial.pickerQueue).toEqual([other]);
    expect(device.isOpen).toBe(true);
  });

  it('refuses options that are not an object, or a chooseAgain that is not a boolean', async () => {
    const harness = new BrowserHarness({ transport });
    const tab = harness.openTab();
    await tab.setup('Reader', AUTO);

    for (const options of ['yes', { chooseAgain: 'yes' }]) {
      await expect(tab.client.requestAccess('Reader', options as never)).rejects.toMatchObject({
        code: SerialBrokerErrorCode.INVALID_ARGUMENT,
      });
    }
  });
});
