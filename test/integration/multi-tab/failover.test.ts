import { describe, expect, it } from 'vitest';

import { SerialBrokerErrorCode } from '../../../src/core/error-codes.js';
import { SerialBrokerError } from '../../../src/core/errors.js';
import { SerialBrokerStatus } from '../../../src/core/types.js';
import { ownerLockName } from '../../../src/protocol/version.js';
import { BrowserHarness, TRANSPORT_MODES } from '../../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../../harness/devices.js';

/**
 * What happens when the tab holding the port goes away.
 *
 * This is the hardest thing the library does and the reason ownership is a Web Lock rather
 * than an agreement between tabs (ADR-0005). The abrupt cases matter most: a tab killed by
 * the process manager runs no unload handler, sends no goodbye, and releases nothing on its
 * own - only the browser releasing its lock makes recovery possible.
 */
describe.each(TRANSPORT_MODES)('ownership failover (%s)', (transport) => {
  async function twoTabsSharingAPort(): Promise<{
    harness: BrowserHarness;
    device: ReturnType<BrowserHarness['serial']['addDevice']>;
    owner: ReturnType<BrowserHarness['openTab']>;
    peer: ReturnType<BrowserHarness['openTab']>;
  }> {
    const harness = new BrowserHarness({ transport });
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);

    const owner = harness.openTab();
    await owner.setup('Reader', READER_OPTIONS);
    const peer = harness.openTab();
    await peer.setup('Reader', READER_OPTIONS);

    return { harness, device, owner, peer };
  }

  it('promotes the remaining tab when the owning tab is closed gracefully', async () => {
    const { harness, device, owner, peer } = await twoTabsSharingAPort();

    await owner.close();

    expect(harness.locks.holderOf(ownerLockName('Reader'))).toBe(peer.id);
    expect(peer.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
    expect(device.openCount).toBe(2);
  });

  it('promotes the remaining tab when the owning tab is killed without warning', async () => {
    const { harness, device, owner, peer } = await twoTabsSharingAPort();

    // No unload handler, no goodbye, no close: a crashed renderer. Everything that follows
    // has to come from the browser releasing the lock.
    await owner.kill();

    expect(harness.locks.holderOf(ownerLockName('Reader'))).toBe(peer.id);
    expect(peer.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
    expect(device.openCount).toBe(2);
  });

  it('keeps delivering data to the surviving tab after a failover', async () => {
    const { harness, device, owner, peer } = await twoTabsSharingAPort();

    await owner.kill();
    device.emit('AFTER-FAILOVER');
    await harness.settle();

    expect(peer.receivedText('Reader')).toBe('AFTER-FAILOVER');
  });

  it('accepts writes from the surviving tab after a failover', async () => {
    const { harness, device, owner, peer } = await twoTabsSharingAPort();

    await owner.kill();
    await peer.client.send('Reader', 'STILL-HERE');
    await harness.settle();

    expect(device.writtenText()).toBe('STILL-HERE');
  });

  it('delivers a write to the new owner exactly once when the old one dies before it arrives', async () => {
    const { harness, device, owner, peer } = await twoTabsSharingAPort();

    // No settle between the two: the request is still in flight on the bus when the owner
    // vanishes, so it demonstrably never reached the device and is safe to deliver again.
    const write = peer.client.send('Reader', 'QUEUED');
    await owner.kill();
    await harness.settle();

    await expect(write).resolves.toBeUndefined();
    expect(device.writtenText()).toBe('QUEUED');
    expect(device.written).toHaveLength(1);
  });

  it('holds a write while no port is open and sends it once the connection comes up', async () => {
    const harness = new BrowserHarness({ transport });
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    device.faults.failOpenTimes = 1;

    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);
    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Reconnecting);

    const write = tab.client.send('Reader', 'HELD');
    await harness.advance(250);

    await expect(write).resolves.toBeUndefined();
    expect(device.writtenText()).toBe('HELD');
    expect(device.written).toHaveLength(1);
  });

  it('never repeats a write that had already begun when the owner died', async () => {
    const { harness, device, owner, peer } = await twoTabsSharingAPort();

    // The owner reports `write-started` and then vanishes. Whether the device received the
    // bytes is unknowable, so the only honest outcome is a specific error - and above all,
    // no retry. Repeating a command to industrial hardware is the one thing this library
    // must never do (ADR-0013).
    device.faults.hangOnWrite = true;
    // The handler is attached immediately: the rejection arrives during `kill`, and a promise
    // whose handler is attached a tick later shows up as an unhandled rejection.
    const outcome = peer.client.send('Reader', 'DANGEROUS').catch((reason: unknown) => reason);
    await harness.settle();

    await owner.kill();
    await harness.settle();

    expect(await outcome).toMatchObject({
      code: SerialBrokerErrorCode.OWNER_LOST_DURING_WRITE,
    });
    expect(device.written).toHaveLength(0);
  });

  it('explains what to do when a write is lost with the owner', async () => {
    const { harness, device, owner, peer } = await twoTabsSharingAPort();

    device.faults.hangOnWrite = true;
    const outcome = peer.client.send('Reader', 'X').catch((reason: unknown) => reason);
    await harness.settle();
    await owner.kill();
    await harness.settle();

    const error = await outcome;
    expect(error).toBeInstanceOf(SerialBrokerError);
    expect((error as SerialBrokerError).remediation).toContain('idempotent');
  });

  it('leaves no owner when the last tab goes, and elects one when a tab returns', async () => {
    const { harness, device, owner, peer } = await twoTabsSharingAPort();

    await owner.close();
    await peer.close();
    expect(harness.locks.holderOf(ownerLockName('Reader'))).toBeUndefined();

    const returning = harness.openTab();
    await returning.setup('Reader', READER_OPTIONS);

    expect(harness.locks.holderOf(ownerLockName('Reader'))).toBe(returning.id);
    // Three opens: the first tab, the successor after the first closed, and this one.
    expect(device.openCount).toBe(3);
  });

  it('does not leak lock requests when a configuration is released', async () => {
    const { harness, owner, peer } = await twoTabsSharingAPort();

    await peer.client.release('Reader');
    await harness.settle();

    // The peer was queued behind the owner. Releasing has to abort that request, or the peer
    // would silently take ownership of something it no longer participates in.
    expect(harness.locks.queueLength(ownerLockName('Reader'))).toBe(0);
    expect(harness.locks.holderOf(ownerLockName('Reader'))).toBe(owner.id);
  });
});
