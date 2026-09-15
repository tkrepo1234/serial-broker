import { describe, expect, it } from 'vitest';

import { SerialBrokerErrorCode } from '../../../src/core/error-codes.js';
import { SerialBrokerError } from '../../../src/core/errors.js';
import { SerialBrokerStatus } from '../../../src/core/types.js';
import { DIAGNOSTICS_ANSWER_RATE, STATUS_ANSWER_RATE } from '../../../src/protocol/limits.js';
import {
  brokerChannelName,
  PROTOCOL_VERSION,
  termLockName,
} from '../../../src/protocol/version.js';
import { BrowserHarness } from '../../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../../harness/devices.js';
import { fieldsOfEvent, recordingLogger } from '../../harness/recording-logger.js';

/**
 * Tabs sharing a port while another script of the origin misbehaves on the bus (SECURITY.md).
 *
 * The script is not a tab: the test speaks for it, posting what any script of the origin can post.
 * What it cannot be stopped from - listening, and saying what a tab could say - is documented; these
 * tests hold the line on what it must not achieve.
 */

async function twoTabs(transport: 'sharedworker' | 'broadcastchannel'): Promise<{
  harness: BrowserHarness;
  device: ReturnType<BrowserHarness['serial']['addDevice']>;
  owner: ReturnType<BrowserHarness['openTab']>;
  other: ReturnType<BrowserHarness['openTab']>;
  records: ReturnType<typeof recordingLogger>['records'];
}> {
  const { logger, records } = recordingLogger();
  const harness = new BrowserHarness({ transport, logger });
  const device = harness.serial.addDevice(READER.vendorId, READER.productId);
  harness.serial.grant(device);
  const owner = harness.openTab();
  await owner.setup('Reader', READER_OPTIONS);
  const other = harness.openTab();
  await other.setup('Reader', READER_OPTIONS);
  return { harness, device, owner, other, records };
}

/** Every message a script of the origin posts on the channel carries this much. */
const FORGED = { v: PROTOCOL_VERSION, from: 'mallory', to: 'all' };

/**
 * A script of the origin on the `BroadcastChannel`: it hears every message and can post any.
 *
 * Listening is what makes the forgeries below realistic - the term of the tab holding the port, the
 * identity it speaks under and the id of a write in flight are all on the channel for anyone.
 */
function eavesdrop(harness: BrowserHarness): {
  heard: Record<string, unknown>[];
  post: (message: Record<string, unknown>) => void;
} {
  const heard: Record<string, unknown>[] = [];
  const channel = harness.bus.broadcastHub.create(brokerChannelName(), 'mallory');
  channel.addEventListener('message', (event: { data: unknown }) => {
    heard.push(event.data as Record<string, unknown>);
  });
  return { heard, post: (message) => channel.postMessage(message) };
}

/** The last message of `type` the script heard. */
function heardOf(
  heard: readonly Record<string, unknown>[],
  type: string,
): Record<string, unknown> | undefined {
  return [...heard].reverse().find((message) => message['type'] === type);
}

/** The term of the tab holding the port, as the script read it off the channel. */
function termOnTheBus(heard: readonly Record<string, unknown>[]): string {
  const claim = heardOf(heard, 'owner-claimed');
  if (claim === undefined) {
    throw new Error('no owner-claimed was heard');
  }
  return claim['term'] as string;
}

/** Two tabs sharing a port, with a script of the origin listening from before they started. */
async function twoWatchedTabs(): Promise<{
  harness: BrowserHarness;
  device: ReturnType<BrowserHarness['serial']['addDevice']>;
  owner: ReturnType<BrowserHarness['openTab']>;
  other: ReturnType<BrowserHarness['openTab']>;
  mallory: ReturnType<typeof eavesdrop>;
  records: ReturnType<typeof recordingLogger>['records'];
}> {
  const { logger, records } = recordingLogger();
  const harness = new BrowserHarness({ transport: 'broadcastchannel', logger });
  const device = harness.serial.addDevice(READER.vendorId, READER.productId);
  harness.serial.grant(device);
  const mallory = eavesdrop(harness);
  const owner = harness.openTab();
  await owner.setup('Reader', READER_OPTIONS);
  const other = harness.openTab();
  await other.setup('Reader', READER_OPTIONS);
  return { harness, device, owner, other, mallory, records };
}

/**
 * Forgeries against the tabs sharing a port.
 *
 * Everything these post is well-formed and names the real configuration; several name the real term
 * of holding the port and the real identity of the tab holding it, both of which are on the channel.
 * What holds them off is not validation but the Web Lock of the term: a term is live while its lock
 * is held, and over when the browser frees it (ADR-0030).
 */
describe('a script of the origin that forges messages about the port', () => {
  it('cannot end a live term by claiming the port for a term nobody holds', async () => {
    const { harness, device, other } = await twoTabs('broadcastchannel');
    const mallory = eavesdrop(harness);

    mallory.post({
      ...FORGED,
      type: 'owner-claimed',
      configName: 'Reader',
      term: 't-invented',
      maxTabs: Number.POSITIVE_INFINITY,
    });
    await harness.settle();
    const sending = other.client.send('Reader', 'PING');
    await harness.settle();

    // The write still goes to the term that holds the port, rather than to the invented one.
    expect(device.writtenText()).toBe('PING');
    await expect(sending).resolves.toBeUndefined();
    expect(other.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
  });

  it('cannot make a tab withdraw by naming another tab limit for the real term', async () => {
    const { harness, device, owner, other, mallory } = await twoWatchedTabs();

    mallory.post({
      ...FORGED,
      from: owner.client.clientId,
      type: 'status',
      configName: 'Reader',
      status: SerialBrokerStatus.Open,
      maxTabs: 1,
      term: termOnTheBus(mallory.heard),
      timestamp: 1,
    });
    await harness.settle();
    const sending = other.client.send('Reader', 'PING');
    await harness.settle();

    // The tab limit is part of the name of the term's lock, so a status naming another one names
    // no term this configuration has (ADR-0025, ADR-0030).
    expect(other.errorCodes('Reader')).toEqual([]);
    expect(other.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
    await expect(sending).resolves.toBeUndefined();
    expect(device.writtenText()).toBe('PING');
  });

  it('cannot make a tab in auto mode adopt a device by stating one', async () => {
    const { logger, records } = recordingLogger();
    const harness = new BrowserHarness({ transport: 'broadcastchannel', logger });
    harness.serial.addDevice(READER.vendorId, READER.productId);
    const mallory = eavesdrop(harness);
    const owner = harness.openTab();
    await owner.setup('Reader', { serial: { baudRate: 9600 } });
    const other = harness.openTab();
    await other.setup('Reader', { serial: { baudRate: 9600 } });
    expect(other.client.getStatus('Reader').deviceKind).toBe('auto');
    const forged = {
      ...FORGED,
      type: 'status',
      configName: 'Reader',
      status: SerialBrokerStatus.AwaitingPermission,
      maxTabs: Number.POSITIVE_INFINITY,
      device: { kind: 'usb', vendorId: 0x0403, productId: 0x6001 },
      timestamp: 1,
    };

    // In the script's own name, for the real term; and in the holder's name, for a term it never
    // held. The lock of a term names the term and the tab speaking for it, so neither names a term
    // of this configuration (ADR-0030), and a tab waiting for a device is not handed one.
    mallory.post({ ...forged, term: termOnTheBus(mallory.heard) });
    mallory.post({ ...forged, from: owner.client.clientId, term: 't-invented' });
    await harness.settle();

    for (const tab of [owner, other]) {
      expect(tab.client.getStatus('Reader')).toMatchObject({
        status: SerialBrokerStatus.AwaitingPermission,
        deviceKind: 'auto',
        vendorId: undefined,
      });
    }
    // Refused by the term check, not by the decoder: both forgeries were well-formed.
    expect(fieldsOfEvent(records, 'client.malformed-message')).toEqual([]);
  });

  it('cannot end the term of the tab holding the port by saying goodbye for it', async () => {
    const { harness, device, owner, other, mallory } = await twoWatchedTabs();

    mallory.post({
      ...FORGED,
      from: owner.client.clientId,
      type: 'owner-released',
      configName: 'Reader',
      term: termOnTheBus(mallory.heard),
    });
    await harness.settle();
    const sending = other.client.send('Reader', 'PING');
    await harness.settle();

    expect(other.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
    await expect(sending).resolves.toBeUndefined();
    expect(device.writtenText()).toBe('PING');
  });

  it('cannot end that term by queueing on its lock and saying goodbye for it', async () => {
    const { harness, device, owner, other, mallory } = await twoWatchedTabs();
    const term = termOnTheBus(mallory.heard);

    // A request of the script's own on the real term's lock. It stays queued while the tab holding
    // the port holds that lock, and looks exactly like the goodbye request a tab queues before it
    // lets go - so the goodbye below must not be believed for it.
    void harness.locks
      .forContext('mallory')
      .request(
        termLockName('Reader', term, owner.client.clientId, Number.POSITIVE_INFINITY),
        { mode: 'exclusive' },
        async () => undefined,
      );
    await harness.settle();
    mallory.post({
      ...FORGED,
      from: owner.client.clientId,
      type: 'owner-released',
      configName: 'Reader',
      term,
    });
    await harness.settle();
    const sending = other.client.send('Reader', 'PING');
    await harness.settle();

    expect(other.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
    await expect(sending).resolves.toBeUndefined();
    expect(device.writtenText()).toBe('PING');
  });

  it('cannot settle a write in flight by answering it in another term', async () => {
    const { harness, device, other, mallory } = await twoWatchedTabs();

    device.pauseWrites();
    let outcome: unknown = 'pending';
    void other.client.send('Reader', 'PING').then(
      () => (outcome = 'resolved'),
      (error: unknown) => (outcome = error),
    );
    await harness.settle();

    const request = heardOf(mallory.heard, 'write-request');
    mallory.post({
      ...FORGED,
      to: request?.['from'],
      type: 'write-result',
      configName: 'Reader',
      requestId: request?.['requestId'],
      ok: true,
      error: undefined,
      term: termOnTheBus(mallory.heard),
    });
    await harness.settle();

    // Answering a write is the term's own business: resolving it here would tell the application
    // that bytes reached the device which are still waiting at the port.
    expect(outcome).toBe('pending');

    device.resumeWrites();
    await harness.settle();
    expect(outcome).toBe('resolved');
    expect(device.writtenText()).toBe('PING');
  });

  it('cannot deliver device data it made up', async () => {
    const { harness, device, other } = await twoTabs('broadcastchannel');
    const mallory = eavesdrop(harness);

    mallory.post({
      ...FORGED,
      type: 'data-received',
      configName: 'Reader',
      payload: new Uint8Array([0x46, 0x41, 0x4b, 0x45]),
      text: 'FAKE',
      timestamp: 1,
    });
    await harness.settle();
    device.emit('REAL');
    await harness.settle();

    expect(other.receivedText('Reader')).toBe('REAL');
  });
});

describe('a script of the origin that floods the bus with well-formed messages', () => {
  it('is answered only as often as the rate for status requests allows, and no tab is left without a status', async () => {
    const { harness } = await twoTabs('broadcastchannel');
    const mallory = eavesdrop(harness);

    for (let round = 0; round < 500; round += 1) {
      mallory.post({ ...FORGED, type: 'status-request', configName: 'Reader' });
    }
    await harness.settle();

    const answers = mallory.heard.filter((message) => message['type'] === 'status');
    expect(answers.length).toBeLessThanOrEqual(STATUS_ANSWER_RATE.burst);

    // The requests beyond the rate are answered together by the next answer it allows, so a tab
    // that joined during the flood still learns where the port is.
    const joining = harness.openTab();
    await joining.setup('Reader', READER_OPTIONS);
    await harness.advance(1_000);

    expect(joining.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
  });

  it('makes a tab joining during the flood miss the chunks that arrive before it learns the term', async () => {
    const { harness, device, records } = await twoTabs('broadcastchannel');
    const mallory = eavesdrop(harness);

    for (let round = 0; round < 2 * STATUS_ANSWER_RATE.burst; round += 1) {
      mallory.post({ ...FORGED, type: 'status-request', configName: 'Reader' });
    }
    await harness.settle();

    // This tab has asked for the status, and the answer that tells it which term holds the port
    // waits for the next one the rate allows. Device data cannot be told from what any script of
    // the origin says until then (ADR-0030), so it is dropped - once with a record, then silently.
    const joining = harness.openTab();
    await joining.client.setup('Reader', READER_OPTIONS);
    const received: string[] = [];
    joining.client.subscribe('Reader', 'onReceive', (event) => {
      received.push(new TextDecoder().decode(event.data));
    });
    device.emit('EARLY');
    await harness.settle();

    expect(received).toEqual([]);
    expect(fieldsOfEvent(records, 'session.data-without-a-term')).toHaveLength(1);

    // The answer arrives within the rate, and from then on the tab sees every chunk.
    await harness.advance(1_000);
    device.emit('LATE');
    await harness.settle();

    expect(received).toEqual(['LATE']);
    expect(joining.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
  });

  it('is answered only as often as the rate for diagnostics requests allows', async () => {
    const { harness } = await twoTabs('broadcastchannel');
    const mallory = eavesdrop(harness);

    for (let round = 0; round < 200; round += 1) {
      mallory.post({ ...FORGED, type: 'diagnostics-request', requestId: `d-${String(round)}` });
    }
    await harness.settle();

    const reports = mallory.heard.filter((message) => message['type'] === 'diagnostics-report');
    // Two tabs, each answering within its own rate.
    expect(reports.length).toBeLessThanOrEqual(2 * DIAGNOSTICS_ANSWER_RATE.burst);
    expect(reports.length).toBeGreaterThan(0);
  });

  it('never reaches an application`s onError with an error it made up', async () => {
    const { harness, other, mallory, records } = await twoWatchedTabs();
    const error = new SerialBrokerError(SerialBrokerErrorCode.WRITE_FAILED, 'made up').toJSON();

    for (let round = 0; round < 200; round += 1) {
      mallory.post({ ...FORGED, type: 'error', configName: 'Reader', error, timestamp: 1 });
    }
    await harness.settle();

    // Errors about the port are believed only from the tab holding it, as its data is.
    expect(other.errorCodes('Reader')).toEqual([]);
    expect(fieldsOfEvent(records, 'session.data-without-a-term')).toHaveLength(2);
  });

  it('is logged once per context, however many malformed messages arrive', async () => {
    const { harness, device, other, records } = await twoTabs('broadcastchannel');

    for (let round = 0; round < 200; round += 1) {
      harness.bus.broadcastHub.injectForeign(brokerChannelName(), {
        ...FORGED,
        type: 'status',
        configName: 'Reader',
      });
    }
    await harness.settle();
    device.emit('REAL');
    await harness.settle();

    // One record per context, and nothing else changes.
    expect(fieldsOfEvent(records, 'client.malformed-message')).toHaveLength(2);
    expect(other.receivedText('Reader')).toBe('REAL');
  });
});

describe('a script on the SharedWorker that uses the identity of a tab', () => {
  it('diverts no write, and delays none, by claiming to hold the port', async () => {
    const { harness, device, other } = await twoTabs('sharedworker');
    const mallory = harness.bus.workerHost.connectForeign();

    // A participant of its own that claims the port in a term it made up. A broker that routed what
    // is meant for the owner to the last claimant would hand it every write (ADR-0040).
    const forged = { v: PROTOCOL_VERSION, from: 'mallory', to: 'all', configName: 'Reader' };
    mallory.post({ ...forged, type: 'hello', configNames: ['Reader'] });
    mallory.post({ ...forged, type: 'owner-claimed', term: 't-forged', maxTabs: 1 });
    await harness.settle();
    const writing = other.client.send('Reader', 'PING');
    await harness.settle();

    await expect(writing).resolves.toBeUndefined();
    expect(device.writtenText()).toBe('PING');
    expect(other.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
  });

  it('does not make the worker forget a tab by leaving under its identity', async () => {
    const { harness, device, other, records } = await twoTabs('sharedworker');
    const mallory = harness.bus.workerHost.connectForeign();

    // Identities are no secret. The port that says hello as the tab is one more port of that
    // identity (ADR-0040); what ends the tab's participation is the tab's own lock, which a script
    // cannot let go of (ADR-0041).
    const forged = { v: PROTOCOL_VERSION, from: other.client.clientId, to: 'all' };
    mallory.post({ ...forged, type: 'hello', configNames: ['Reader'] });
    await harness.settle();
    device.emit('STILL HERE');
    await harness.settle();

    expect(other.receivedText('Reader')).toBe('STILL HERE');
    expect(fieldsOfEvent(records, 'worker.message-refused')).toEqual([]);
  });

  it('cannot speak for a tab from a port that said hello as something else', async () => {
    const { harness, device, owner, other, records } = await twoTabs('sharedworker');
    const mallory = harness.bus.workerHost.connectForeign();

    // An identity of its own: the port is served, and is held to the identity it said hello as.
    mallory.post({
      v: PROTOCOL_VERSION,
      from: 'mallory',
      to: 'all',
      type: 'hello',
      configNames: [],
    });
    mallory.post({
      v: PROTOCOL_VERSION,
      from: other.client.clientId,
      to: 'all',
      type: 'hello',
      configNames: [],
    });
    await harness.settle();
    device.emit('STILL HERE');
    await harness.settle();

    expect(other.receivedText('Reader')).toBe('STILL HERE');
    expect(fieldsOfEvent(records, 'worker.message-refused')).toEqual([
      expect.objectContaining({ reason: 'sender-mismatch', reportedBy: owner.client.clientId }),
      expect.objectContaining({ reason: 'sender-mismatch', reportedBy: other.client.clientId }),
    ]);
  });
});

describe('a script flooding the BroadcastChannel with messages beyond a limit', () => {
  it('is logged once in each tab, and the tabs go on sharing the port', async () => {
    const { harness, device, other, records } = await twoTabs('broadcastchannel');
    // Fake device data, from a sender whose identity is longer than any identifier may be.
    const oversized = {
      v: PROTOCOL_VERSION,
      from: 'm'.repeat(300),
      to: 'all',
      type: 'data-received',
      configName: 'Reader',
      payload: new Uint8Array([0x46, 0x41, 0x4b, 0x45]),
      text: 'FAKE',
      timestamp: 1,
    };

    for (let round = 0; round < 500; round += 1) {
      harness.bus.broadcastHub.injectForeign(brokerChannelName(), oversized);
    }
    await harness.settle();
    device.emit('REAL');
    await harness.settle();
    await other.client.send('Reader', 'PING');
    await harness.settle();

    expect(fieldsOfEvent(records, 'transport.limit-exceeded')).toHaveLength(2);
    expect(fieldsOfEvent(records, 'client.malformed-message')).toEqual([]);
    expect(other.receivedText('Reader')).toBe('REAL');
    expect(device.writtenText()).toBe('PING');
  });
});
