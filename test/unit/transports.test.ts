import { describe, expect, it, vi } from 'vitest';

import {
  BroadcastChannelTransport,
  type BroadcastChannelLike,
} from '../../src/client/transport/broadcast-channel-transport.js';
import {
  SharedWorkerTransport,
  type SharedWorkerLike,
  type WorkerLoadFailure,
} from '../../src/client/transport/shared-worker-transport.js';
import { HEARTBEAT_INTERVAL_MS } from '../../src/protocol/heartbeat.js';
import type { ClientId, ProtocolMessage } from '../../src/protocol/messages.js';
import { PROTOCOL_VERSION } from '../../src/protocol/version.js';
import {
  envelope,
  FakeMessagePort,
  recordTransportRequest,
  type TransportRequestRecorder,
} from '../harness/transport-doubles.js';

const SELF = 'self' as ClientId;
const PEER = 'peer' as ClientId;

/** What the addressing tests send. Which message it is does not matter, only where it goes. */
const STATUS_REQUEST = { type: 'status-request', configName: 'Reader' };

describe('SharedWorkerTransport', () => {
  function create(): TransportRequestRecorder & {
    port: FakeMessagePort;
    transport: SharedWorkerTransport;
  } {
    const rec = recordTransportRequest(SELF);
    const port = new FakeMessagePort();
    const worker: SharedWorkerLike = { port, addEventListener: () => undefined };
    const transport = new SharedWorkerTransport(rec.request, () => worker, 'fake://worker');
    return { ...rec, port, transport };
  }

  it('announces itself as soon as it connects', () => {
    const { port } = create();

    expect((port.posted[0] as ProtocolMessage).type).toBe('hello');
  });

  it('sends attach and detach as messages, because the broker needs to know', () => {
    const { transport, port } = create();

    transport.attach('Reader');
    transport.detach('Reader');

    expect((port.posted[1] as ProtocolMessage).type).toBe('attach');
    expect((port.posted[2] as ProtocolMessage).type).toBe('detach');
  });

  it('delivers a valid message from the broker', () => {
    const { port, messages } = create();

    port.deliver(envelope(PEER, SELF, STATUS_REQUEST));

    expect(messages).toHaveLength(1);
  });

  it('reports a message it cannot parse instead of delivering it', () => {
    const { port, messages, decodeFailures } = create();

    port.deliver({ garbage: true });

    expect(messages).toHaveLength(0);
    expect(decodeFailures).toHaveLength(1);
  });

  it('ignores its own message coming back', () => {
    const { port, messages } = create();

    // Double-delivering every local event would be a miserable bug to find.
    port.deliver(envelope(SELF, 'all', STATUS_REQUEST));

    expect(messages).toHaveLength(0);
  });

  it('reports a failure to post rather than throwing into the caller', () => {
    const rec = recordTransportRequest(SELF);
    const port = new FakeMessagePort();
    Object.assign(port, {
      postMessage: () => {
        throw new Error('the port is closed');
      },
    });
    const worker: SharedWorkerLike = { port, addEventListener: () => undefined };

    const transport = new SharedWorkerTransport(rec.request, () => worker, 'fake://w');
    transport.attach('Reader');

    // A caller in the middle of a state transition has nothing useful to do with an exception
    // from a postMessage.
    expect(rec.transportErrors.length).toBeGreaterThan(0);
  });

  it('reports a message that failed to clone on the way in', () => {
    const { port, transportErrors } = create();

    port.failToClone();

    expect(transportErrors).toHaveLength(1);
  });

  it('says goodbye and closes the port', () => {
    const { transport, port } = create();

    transport.close();

    expect((port.posted.at(-1) as ProtocolMessage).type).toBe('goodbye');
    expect(port.closed).toBe(true);
  });

  it('is safe to close twice and sends nothing afterwards', () => {
    const { transport, port } = create();

    transport.close();
    const after = port.posted.length;
    transport.close();
    transport.attach('Reader');

    expect(port.posted).toHaveLength(after);
  });

  it('sends no message for an ownership change, which the broker learns from the claim', () => {
    const { transport, port } = create();
    const before = port.posted.length;

    transport.setOwnership('Reader', true);

    expect(port.posted).toHaveLength(before);
  });
});

describe('BroadcastChannelTransport', () => {
  function create(): TransportRequestRecorder & {
    transport: BroadcastChannelTransport;
    posted: unknown[];
    deliver: (raw: unknown) => void;
  } {
    const rec = recordTransportRequest(SELF);
    const posted: unknown[] = [];
    const listeners = new Map<string, (event: never) => void>();

    const channel = {
      postMessage: (message: unknown) => posted.push(message),
      close: () => undefined,
      addEventListener: (type: string, listener: (event: never) => void) => {
        listeners.set(type, listener);
      },
    } as unknown as BroadcastChannelLike;

    const transport = new BroadcastChannelTransport(rec.request, () => channel);
    return {
      ...rec,
      transport,
      posted,
      deliver: (raw) => listeners.get('message')?.({ data: raw } as never),
    };
  }

  it('accepts a broadcast for a configuration it has attached to', () => {
    const { transport, deliver, messages } = create();

    transport.attach('Reader');
    deliver(envelope(PEER, 'all', STATUS_REQUEST));

    expect(messages).toHaveLength(1);
  });

  it('discards a broadcast for a configuration it has not attached to', () => {
    const { deliver, messages } = create();

    // With no broker, every message reaches every context; filtering is the receiver's job.
    deliver(envelope(PEER, 'all', STATUS_REQUEST));

    expect(messages).toHaveLength(0);
  });

  it('accepts a message addressed to the owner only while it owns the port', () => {
    const { transport, deliver, messages } = create();
    transport.attach('Reader');

    deliver(envelope(PEER, 'owner', STATUS_REQUEST));
    expect(messages).toHaveLength(0);

    transport.setOwnership('Reader', true);
    deliver(envelope(PEER, 'owner', STATUS_REQUEST));
    expect(messages).toHaveLength(1);

    transport.setOwnership('Reader', false);
    deliver(envelope(PEER, 'owner', STATUS_REQUEST));
    expect(messages).toHaveLength(1);
  });

  it('accepts a message addressed to it by name', () => {
    const { deliver, messages } = create();

    deliver(envelope(PEER, SELF, STATUS_REQUEST));

    expect(messages).toHaveLength(1);
  });

  it('discards a message addressed to somebody else', () => {
    const { deliver, messages } = create();

    deliver(envelope(PEER, 'another-tab' as ClientId, STATUS_REQUEST));

    expect(messages).toHaveLength(0);
  });

  it('accepts a context-wide message that names no configuration', () => {
    const { deliver, messages } = create();

    deliver({ v: PROTOCOL_VERSION, from: PEER, to: 'all', type: 'hello' });

    expect(messages).toHaveLength(1);
  });

  it('stops accepting messages for a configuration it detached from', () => {
    const { transport, deliver, messages } = create();
    transport.attach('Reader');
    transport.setOwnership('Reader', true);

    transport.detach('Reader');
    deliver(envelope(PEER, 'all', STATUS_REQUEST));
    deliver(envelope(PEER, 'owner', STATUS_REQUEST));

    expect(messages).toHaveLength(0);
  });

  it('ignores its own message, should the channel ever echo one back', () => {
    const { transport, deliver, messages } = create();
    transport.attach('Reader');

    deliver(envelope(SELF, 'all', STATUS_REQUEST));

    expect(messages).toHaveLength(0);
  });

  it('reports a failure to post', () => {
    const rec = recordTransportRequest(SELF);
    const channel = {
      postMessage: () => {
        throw new Error('channel closed');
      },
      close: () => undefined,
      addEventListener: () => undefined,
    } as unknown as BroadcastChannelLike;

    new BroadcastChannelTransport(rec.request, () => channel);

    expect(rec.transportErrors.length).toBeGreaterThan(0);
  });

  it('closes cleanly and stops sending', () => {
    const { transport, posted } = create();

    transport.close();
    const after = posted.length;
    transport.attach('Reader');

    expect((posted.at(-1) as ProtocolMessage).type).toBe('goodbye');
    expect(posted).toHaveLength(after);
  });

  it('identifies itself as the fallback', () => {
    const { transport } = create();

    expect(transport.kind).toBe('broadcastchannel');
    expect(transport.clientId).toBe(SELF);
  });
});

describe('both transports', () => {
  it('report a decode failure rather than delivering an unparsable message', () => {
    const rec = recordTransportRequest(SELF);
    const listeners = new Map<string, (event: never) => void>();
    const channel = {
      postMessage: () => undefined,
      close: () => undefined,
      addEventListener: (type: string, listener: (event: never) => void) => {
        listeners.set(type, listener);
      },
    } as unknown as BroadcastChannelLike;

    new BroadcastChannelTransport(rec.request, () => channel);
    listeners.get('message')?.({ data: 'not a message' } as never);

    expect(rec.decodeFailures).toHaveLength(1);
    expect(rec.messages).toHaveLength(0);
  });

  it('never throw out of a message handler', () => {
    const rec = recordTransportRequest(SELF);
    const listeners = new Map<string, (event: never) => void>();
    const channel = {
      postMessage: () => undefined,
      close: () => undefined,
      addEventListener: (type: string, listener: (event: never) => void) => {
        listeners.set(type, listener);
      },
    } as unknown as BroadcastChannelLike;
    Object.assign(rec.request, { onMessage: vi.fn() });

    new BroadcastChannelTransport(rec.request, () => channel);

    expect(() => listeners.get('message')?.({ data: null } as never)).not.toThrow();
  });
});

describe('SharedWorkerTransport, while its script is starting', () => {
  const WELCOME = { v: PROTOCOL_VERSION, from: 'serial-broker/broker', to: SELF, type: 'welcome' };

  function start(): TransportRequestRecorder & {
    port: FakeMessagePort;
    ready: () => number;
    loadFailures: unknown[];
    failToLoad: () => void;
  } {
    const rec = recordTransportRequest(SELF);
    const port = new FakeMessagePort();
    let errorListener: (event: unknown) => void = () => undefined;
    const worker: SharedWorkerLike = {
      port,
      addEventListener: (_type, listener) => {
        errorListener = listener;
      },
    };
    let readyCount = 0;
    const loadFailures: { event: unknown; reason: WorkerLoadFailure }[] = [];

    new SharedWorkerTransport(rec.request, () => worker, 'fake://worker', {
      onReady: () => {
        readyCount += 1;
      },
      onLoadFailed: (event, reason) => loadFailures.push({ event, reason }),
    });

    return {
      ...rec,
      port,
      ready: () => readyCount,
      loadFailures,
      failToLoad: () => {
        errorListener({ type: 'error' });
      },
    };
  }

  it('reports the script running when the broker welcomes it, and keeps the welcome to itself', () => {
    const { port, ready, messages } = start();

    port.deliver(WELCOME);
    port.deliver(WELCOME);

    expect(ready()).toBe(1);
    expect(messages).toHaveLength(0);
  });

  it('reports a failure before the welcome as a load failure, not a transport error', () => {
    const { failToLoad, loadFailures, transportErrors } = start();

    failToLoad();

    expect(loadFailures).toEqual([{ event: { type: 'error' }, reason: 'worker-script-failed' }]);
    expect(transportErrors).toHaveLength(0);
  });

  it('reports a failure after the welcome as a transport error', () => {
    const { port, failToLoad, loadFailures, transportErrors } = start();

    port.deliver(WELCOME);
    failToLoad();

    expect(loadFailures).toHaveLength(0);
    expect(transportErrors).toHaveLength(1);
  });

  it('reports a worker script of another protocol version as a load failure, and the version as a mismatch', () => {
    const { port, ready, loadFailures, decodeFailures, transportErrors } = start();

    // The worker's answer to hello, in its own version (ADR-0024). Such a worker drops everything
    // this tab says, so nothing sent so far reached anyone - as with a script that did not load.
    port.deliver({ ...WELCOME, v: PROTOCOL_VERSION - 1 });

    expect(ready()).toBe(0);
    expect(loadFailures).toEqual([
      { event: expect.anything() as unknown, reason: 'worker-other-protocol-version' },
    ]);
    expect(decodeFailures).toEqual([
      { reason: 'version-mismatch', theirVersion: PROTOCOL_VERSION - 1 },
    ]);
    expect(transportErrors).toHaveLength(0);
  });

  it('reports a message in another protocol version after the welcome only as a mismatch', () => {
    const { port, loadFailures, decodeFailures } = start();

    port.deliver(WELCOME);
    port.deliver({ ...WELCOME, v: PROTOCOL_VERSION - 1 });

    expect(loadFailures).toHaveLength(0);
    expect(decodeFailures).toHaveLength(1);
  });

  it('does not go on to fall back when hearing the other version made the application close the bus', () => {
    const rec = recordTransportRequest(SELF);
    const port = new FakeMessagePort();
    const loadFailures: WorkerLoadFailure[] = [];
    const bus: { transport?: SharedWorkerTransport } = {};
    // The client turns the decode failure into PROTOCOL_VERSION_MISMATCH, synchronously, and an
    // application may answer that by disposing everything.
    const request = {
      ...rec.request,
      onDecodeFailure: () => {
        bus.transport?.close();
      },
    };
    bus.transport = new SharedWorkerTransport(
      request,
      () => ({ port, addEventListener: () => undefined }),
      'fake://worker',
      { onReady: () => undefined, onLoadFailed: (_event, reason) => loadFailures.push(reason) },
    );

    port.deliver({ ...WELCOME, v: PROTOCOL_VERSION - 1 });

    expect(loadFailures).toEqual([]);
  });
});

describe('SharedWorkerTransport heartbeats', () => {
  function start(): TransportRequestRecorder & {
    port: FakeMessagePort;
    transport: SharedWorkerTransport;
  } {
    const rec = recordTransportRequest(SELF);
    const port = new FakeMessagePort();
    const worker: SharedWorkerLike = { port, addEventListener: () => undefined };
    const transport = new SharedWorkerTransport(rec.request, () => worker, 'fake://worker');
    return { ...rec, port, transport };
  }

  it('tells the broker periodically what this context takes part in and owns', async () => {
    const { transport, port, clock } = start();
    transport.attach('Reader');
    transport.attach('Printer');
    transport.setOwnership('Reader', true);
    transport.detach('Printer');
    port.posted.length = 0;

    await clock.advance(HEARTBEAT_INTERVAL_MS);

    expect(port.posted).toEqual([
      expect.objectContaining({
        type: 'heartbeat',
        configNames: ['Reader'],
        ownedConfigNames: ['Reader'],
      }),
    ]);

    transport.setOwnership('Reader', false);
    await clock.advance(HEARTBEAT_INTERVAL_MS);
    expect(port.posted.at(-1)).toMatchObject({ configNames: ['Reader'], ownedConfigNames: [] });
  });

  it('stops sending heartbeats once closed', async () => {
    const { transport, port, clock } = start();

    transport.close();
    port.posted.length = 0;
    await clock.advance(3 * HEARTBEAT_INTERVAL_MS);

    expect(port.posted).toEqual([]);
    expect(clock.pendingTimerCount).toBe(0);
  });
});

describe('SharedWorkerTransport once closed', () => {
  it('reports nothing the worker or its port says any more', () => {
    const rec = recordTransportRequest(SELF);
    const port = new FakeMessagePort();
    let workerError: (event: unknown) => void = () => undefined;
    const worker: SharedWorkerLike = {
      port,
      addEventListener: (_type, listener) => {
        workerError = listener;
      },
    };
    const transport = new SharedWorkerTransport(rec.request, () => worker, 'fake://worker');

    transport.close();
    workerError({ type: 'error' });
    port.failToClone();

    expect(rec.transportErrors).toEqual([]);
  });
});
