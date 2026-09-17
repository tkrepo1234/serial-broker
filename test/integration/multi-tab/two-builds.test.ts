import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SerialBrokerClient } from '../../../src/client/serial-broker-client.js';
import type { BroadcastChannelTransport } from '../../../src/client/transport/broadcast-channel-transport.js';
import { SerialBrokerErrorCode } from '../../../src/core/error-codes.js';
import { SerialBrokerStatus } from '../../../src/core/types.js';
import type * as versionModule from '../../../src/protocol/version.js';
import { PROTOCOL_VERSION } from '../../../src/protocol/version.js';
import { VirtualTab } from '../../harness/browser-harness.js';
import { READER_OPTIONS, readerHarness } from '../../harness/devices.js';

/**
 * Row 13 of the scenario matrix with two real tabs: one of this build, and one of a build whose
 * protocol version is the next one (ADR-0007).
 *
 * The other build is this library loaded a second time with `protocol/version.js` replaced, so
 * every name it derives from the version - its locks and its broker channel - is its own. It runs
 * on the `BroadcastChannel` bus, whose transport it builds from its own modules too; the simulated
 * `SharedWorker` always runs this build's broker.
 */

const OTHER_VERSION = PROTOCOL_VERSION + 1;

/** The client class of a build whose protocol version is `version`. */
async function clientOfBuild(version: number): Promise<{
  Client: typeof SerialBrokerClient;
  Transport: typeof BroadcastChannelTransport;
}> {
  vi.resetModules();
  vi.doMock('../../../src/protocol/version.js', async (importOriginal) => {
    const actual = await importOriginal<typeof versionModule>();
    const renamed = (value: unknown): unknown =>
      typeof value === 'string'
        ? value.replace(`/v${String(actual.PROTOCOL_VERSION)}`, `/v${String(version)}`)
        : value;
    return Object.fromEntries(
      Object.entries(actual).map(([key, value]) => [
        key,
        key === 'PROTOCOL_VERSION'
          ? version
          : typeof value === 'function'
            ? (...args: unknown[]) => renamed((value as (...a: unknown[]) => unknown)(...args))
            : value,
      ]),
    );
  });
  const { SerialBrokerClient: Client } =
    await import('../../../src/client/serial-broker-client.js');
  const { BroadcastChannelTransport: Transport } =
    await import('../../../src/client/transport/broadcast-channel-transport.js');
  return { Client, Transport };
}

afterEach(() => {
  vi.doUnmock('../../../src/protocol/version.js');
  vi.resetModules();
});

describe('a tab of this build and a tab of the next protocol version', () => {
  it('do not share the port, and each reports the other once', async () => {
    const { Client, Transport } = await clientOfBuild(OTHER_VERSION);
    const { harness, device } = readerHarness({ transport: 'broadcastchannel' });
    const ours = harness.openTab();
    await ours.setup('Reader', READER_OPTIONS);
    const environment = harness.createEnvironment('other-build');
    const theirs = new VirtualTab(
      'other-build',
      new Client({
        ...environment,
        createTransport: (request) =>
          new Transport(request, (name) => harness.bus.broadcastHub.create(name, 'other-build')),
      }),
      harness,
    );

    await theirs.setup('Reader', READER_OPTIONS);
    await harness.advance(1_000);
    device.emit('for this build');
    await harness.settle();

    const mismatches = (tab: VirtualTab): unknown[] =>
      tab
        .recordFor('Reader')
        .errors.filter(
          (event) => event.error.code === SerialBrokerErrorCode.PROTOCOL_VERSION_MISMATCH,
        )
        .map((event) => event.error.context.theirVersion);
    expect(mismatches(ours)).toEqual([OTHER_VERSION]);
    expect(mismatches(theirs)).toEqual([PROTOCOL_VERSION]);
    // Not federated: the tab of the other build neither holds this build's open port nor hears it.
    expect(ours.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
    expect(ours.receivedText('Reader')).toBe('for this build');
    expect(theirs.client.getStatus('Reader').status).not.toBe(SerialBrokerStatus.Open);
    expect(theirs.receivedText('Reader')).toBe('');
    expect(device.openCount).toBe(1);
  });
});
