import { describe, expect, it } from 'vitest';

import { SerialBrokerClient } from '../../../src/client/serial-broker-client.js';
import { SerialBrokerErrorCode } from '../../../src/core/error-codes.js';
import { SerialBrokerError } from '../../../src/core/errors.js';
import { LOCK_RETRY_DELAY_MS } from '../../../src/core/held-lock.js';
import { ScopedLogger } from '../../../src/core/logger.js';
import { SerialBrokerStatus } from '../../../src/core/types.js';
import { ownerLockName } from '../../../src/protocol/version.js';
import type { BrowserHarness } from '../../harness/browser-harness.js';
import { TRANSPORT_MODES } from '../../harness/browser-harness.js';
import { connectedTab, READER_OPTIONS, readerHarness } from '../../harness/devices.js';
import { fieldsOfEvent, recordingLogger } from '../../harness/recording-logger.js';

/**
 * What happens when the tab holding the port goes away.
 *
 * This is the hardest thing the library does and the reason ownership is a Web Lock rather
 * than an agreement between tabs (ADR-0005). The abrupt cases matter most: a tab killed by
 * the process manager runs no unload handler, sends no `owner-released`, and releases nothing on
 * its own - only the browser releasing its lock makes recovery possible.
 */
describe.each(TRANSPORT_MODES)('ownership failover (%s)', (transport) => {
  async function twoTabsSharingAPort(): Promise<{
    harness: BrowserHarness;
    device: ReturnType<BrowserHarness['serial']['addDevice']>;
    owner: ReturnType<BrowserHarness['openTab']>;
    peer: ReturnType<BrowserHarness['openTab']>;
  }> {
    const { harness, device } = readerHarness({ transport });

    const owner = harness.openTab();
    await owner.setup('Reader', READER_OPTIONS);
    const peer = harness.openTab();
    await peer.setup('Reader', READER_OPTIONS);

    return { harness, device, owner, peer };
  }

  // Killed: no unload handler, no owner-released, no close - a crashed renderer. Everything that
  // follows has to come from the browser releasing the lock.
  it.each(['closed gracefully', 'killed without warning'] as const)(
    'promotes the remaining tab, which receives and writes, when the owning tab is %s',
    async (ending) => {
      const { harness, device, owner, peer } = await twoTabsSharingAPort();

      await (ending === 'closed gracefully' ? owner.close() : owner.kill());
      device.emit('AFTER-FAILOVER');
      await harness.settle();
      await peer.client.send('Reader', 'STILL-HERE');
      await harness.settle();

      expect(harness.locks.holderOf(ownerLockName('Reader'))).toBe(peer.id);
      expect(peer.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
      expect(device.openCount).toBe(2);
      expect(peer.receivedText('Reader')).toBe('AFTER-FAILOVER');
      expect(device.writtenText()).toBe('STILL-HERE');
    },
  );

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
    const { harness, device } = readerHarness({ transport });
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

  it('fails a write the owner had begun as soon as the browser frees its lock, and never repeats it', async () => {
    const { harness, device, owner, peer } = await twoTabsSharingAPort();

    // The peer lets the owner begin the write, and the owner vanishes. Whether the device received
    // the bytes is unknowable, so the only honest outcome is a specific error - and above all,
    // no retry. Repeating a command to industrial hardware is the one thing this library
    // must never do (ADR-0013).
    device.faults.hangOnWrite = true;
    let outcome: unknown = 'pending';
    void peer.client.send('Reader', 'DANGEROUS').then(
      () => (outcome = 'resolved'),
      (reason: unknown) => (outcome = reason),
    );
    await harness.settle();
    const beforeTheCrash = outcome;

    // No waiting and no timer: the term is over the moment the browser frees its lock, which it
    // does as it tears the crashed tab down (ADR-0030). The clock does not move.
    await owner.kill();

    expect(beforeTheCrash).toBe('pending');
    expect(outcome).toBeInstanceOf(SerialBrokerError);
    expect(outcome).toMatchObject({ code: SerialBrokerErrorCode.OWNER_LOST_DURING_WRITE });
    // Whether to send it again is the application's decision, and the error says so.
    expect((outcome as SerialBrokerError).remediation).toContain('idempotent');
    expect(device.written).toHaveLength(0);
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

describe('handing the port over by releasing it', () => {
  it('lets the next tab open the port while the releasing tab stays open', async () => {
    const { harness, device, tab: owner } = await connectedTab();
    const other = harness.openTab();
    await other.setup('Reader', READER_OPTIONS);

    // The releasing tab lives on, so nothing but its own close() can free the device.
    await owner.client.release('Reader');
    await harness.settle();

    expect(other.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
    expect(device.openCount).toBe(2);
  });
});

/**
 * The lock of a term of holding the port is taken before the tab says anything in that term
 * (ADR-0030). A browser that refuses the request would otherwise leave a tab holding the ownership
 * lock without ever opening the port - the one state in which nobody can use the device.
 */
describe('a browser that refuses the lock for a term of holding the port', () => {
  it('opens the port once the request is made again', async () => {
    const { harness, device } = readerHarness();
    const { logger, records } = recordingLogger();
    const environment = harness.createEnvironment('tab1');
    let refusals = 1;
    const client = new SerialBrokerClient({
      ...environment,
      logger: new ScopedLogger(logger, {}),
      locks: {
        request: async (name, options, callback) => {
          if (name.startsWith('serial-broker/term/') && refusals > 0) {
            refusals -= 1;
            throw new Error('the browser refused this lock request');
          }
          return await environment.locks.request(name, options, callback);
        },
      },
    });

    await client.setup('Reader', READER_OPTIONS);
    await harness.settle();
    expect(client.getStatus('Reader').status).not.toBe('open');

    await harness.advance(LOCK_RETRY_DELAY_MS);

    expect(client.getStatus('Reader').status).toBe('open');
    expect(device.isOpen).toBe(true);
    expect(fieldsOfEvent(records, 'election.failed')).toHaveLength(1);
  });

  it('leaves no timer behind when the configuration is released while it waits', async () => {
    const { harness } = readerHarness();
    const environment = harness.createEnvironment('tab1');
    const client = new SerialBrokerClient({
      ...environment,
      locks: {
        request: async (name, options, callback) => {
          if (name.startsWith('serial-broker/term/')) {
            throw new Error('the browser refused this lock request');
          }
          return await environment.locks.request(name, options, callback);
        },
      },
    });
    await client.setup('Reader', READER_OPTIONS);
    await harness.settle();

    await client.release('Reader');

    expect(harness.clock.pendingTimerCount).toBe(0);
  });
});
