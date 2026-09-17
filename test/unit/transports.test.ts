import { describe, expect, it } from 'vitest';

import {
  BroadcastChannelTransport,
  type BroadcastChannelLike,
} from '../../src/client/transport/broadcast-channel-transport.js';
import {
  SharedWorkerTransport,
  type SharedWorkerLike,
  type WorkerLoadFailure,
} from '../../src/client/transport/shared-worker-transport.js';
import type { Logger } from '../../src/core/types.js';
import { BROKER_ID, type ClientId, type ProtocolMessage } from '../../src/protocol/messages.js';
import { contextLockName, PROTOCOL_VERSION, workerLockName } from '../../src/protocol/version.js';
import { flushMicrotasks } from '../harness/fake-clock.js';
import { recordingLogger } from '../harness/recording-logger.js';
import {
  envelope,
  FakeMessagePort,
  holdLock,
  recordTransportRequest,
  type TransportRequestRecorder,
  welcome,
} from '../harness/transport-doubles.js';

const SELF = 'self' as ClientId;
const PEER = 'peer' as ClientId;

/** What the addressing tests send. Which message it is does not matter, only where it goes. */
const STATUS_REQUEST = { type: 'status-request', configName: 'Reader', retry: false };

describe('SharedWorkerTransport', () => {
  function create(logger?: Logger): TransportRequestRecorder & {
    port: FakeMessagePort;
    transport: SharedWorkerTransport;
  } {
    const rec = recordTransportRequest(SELF, logger);
    const port = new FakeMessagePort();
    const worker: SharedWorkerLike = { port, addEventListener: () => undefined };
    const transport = new SharedWorkerTransport(rec.request, () => worker, 'fake://worker');
    return { ...rec, port, transport };
  }

  it('announces itself once it holds its own lock', async () => {
    const { port, locks } = create();
    await flushMicrotasks();

    expect(port.posted).toEqual([expect.objectContaining({ type: 'hello', configNames: [] })]);
    // The worker waits on this lock, and forgets the tab once the browser lets go of it (ADR-0041).
    expect(locks.holderOf(contextLockName(SELF))).toBe(SELF);
  });

  it('says hello again, naming what it takes part in, whenever that changes', async () => {
    const { transport, port } = create();
    await flushMicrotasks();

    transport.attach('Reader');
    transport.attach('Scale');
    transport.detach('Reader');

    expect(port.posted.slice(1)).toEqual([
      expect.objectContaining({ type: 'hello', configNames: ['Reader'] }),
      expect.objectContaining({ type: 'hello', configNames: ['Reader', 'Scale'] }),
      expect.objectContaining({ type: 'hello', configNames: ['Scale'] }),
    ]);
  });

  it('sends nothing before its hello, and what waited follows it in order', async () => {
    const rec = recordTransportRequest(SELF);
    // Somebody else holds the lock for a moment: the transport waits for it.
    let release: () => void = () => undefined;
    void rec.locks.forContext('other').request(contextLockName(SELF), {}, async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const port = new FakeMessagePort();
    const transport = new SharedWorkerTransport(
      rec.request,
      () => ({ port, addEventListener: () => undefined }),
      'fake://worker',
    );

    transport.attach('Reader');
    transport.send(envelope(SELF, 'all', STATUS_REQUEST) as ProtocolMessage);
    await flushMicrotasks();
    const postedWhileWaiting = port.posted.length;
    release();
    await flushMicrotasks();

    expect(postedWhileWaiting).toBe(0);
    expect(port.posted).toEqual([
      expect.objectContaining({ type: 'hello', configNames: ['Reader'] }),
      expect.objectContaining({ type: 'status-request' }),
    ]);
  });

  it('delivers a valid message from the broker', () => {
    const { port, messages } = create();

    port.deliver(envelope(PEER, SELF, STATUS_REQUEST));

    expect(messages).toHaveLength(1);
  });

  it('logs a record the worker forwarded, as the worker recorded it', () => {
    const { logger, records } = recordingLogger();
    const { port, messages } = create(logger);

    port.deliver(
      envelope(BROKER_ID, SELF, {
        type: 'worker-log',
        level: 'warn',
        message: 'refused a message that names another sender than its port said hello as',
        fields: {
          event: 'worker.message-refused',
          reason: 'sender-mismatch',
          clientId: 'mallory',
        },
      }),
    );

    // The worker cannot reach an application's logger; a tab writes its records for it (ADR-0018).
    // `clientId` stays the identity the worker's record concerns, not this tab's.
    expect(records).toEqual([
      [
        'warn',
        'refused a message that names another sender than its port said hello as',
        {
          event: 'worker.message-refused',
          reason: 'sender-mismatch',
          clientId: 'mallory',
          reportedBy: SELF,
        },
      ],
    ]);
    expect(messages).toHaveLength(0);
  });

  it('ignores a forwarded record that did not come from the broker', () => {
    const { logger, records } = recordingLogger();
    const { port, messages } = create(logger);

    // Any script of the origin can say anything on a port of its own; only the broker's own records
    // are logged as the worker's, and the broker passes none of these on.
    port.deliver(
      envelope(PEER, SELF, {
        type: 'worker-log',
        level: 'error',
        message: 'the device caught fire',
        fields: { event: 'worker.message-refused' },
      }),
    );

    expect(records).toEqual([]);
    expect(messages).toHaveLength(0);
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

  it('reports a failure to post rather than throwing into the caller', async () => {
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
    await flushMicrotasks();

    // A caller in the middle of a state transition has nothing useful to do with an exception
    // from a postMessage.
    expect(rec.transportErrors.length).toBeGreaterThan(0);
  });

  it('reports a message that failed to clone on the way in', () => {
    const { port, transportErrors } = create();

    port.failToClone();

    expect(transportErrors).toHaveLength(1);
  });

  it('closes the port and lets go of its lock, which is all the worker needs to hear', async () => {
    const { transport, port, locks } = create();
    await flushMicrotasks();
    const posted = port.posted.length;

    transport.close();
    await flushMicrotasks();

    expect(port.posted).toHaveLength(posted);
    expect(port.closed).toBe(true);
    expect(locks.holderOf(contextLockName(SELF))).toBeUndefined();
  });

  it('is safe to close twice and sends nothing afterwards', async () => {
    const { transport, port } = create();
    await flushMicrotasks();

    transport.close();
    const after = port.posted.length;
    transport.close();
    transport.attach('Reader');

    expect(port.posted).toHaveLength(after);
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

    deliver(envelope(PEER, 'all', { type: 'diagnostics-request', requestId: 'd-1' }));

    expect(messages).toHaveLength(1);
  });

  it.each([
    ['hello', { configNames: ['Reader'] }],
    ['welcome', { worker: 'worker-1' }],
    ['worker-log', { level: 'warn', message: 'x', fields: { event: 'worker.message-refused' } }],
  ])('passes on no %s, which is meant for a broker and read by nobody above it', (type, body) => {
    const { transport, deliver, messages } = create();
    transport.attach('Reader');

    // Any script of the origin can post these on the channel. On the worker the broker keeps them.
    deliver(envelope(PEER, 'all', { type, ...body }));
    deliver(envelope(PEER, 'all', STATUS_REQUEST));

    expect(messages.map((message) => message.type)).toEqual(['status-request']);
  });

  it('stops accepting messages for a configuration it detached from', () => {
    const { transport, deliver, messages } = create();
    transport.attach('Reader');

    transport.detach('Reader');
    deliver(envelope(PEER, 'all', STATUS_REQUEST));

    expect(messages).toHaveLength(0);
  });

  it('reports a message it cannot parse instead of delivering it', () => {
    const { transport, deliver, messages, decodeFailures } = create();
    transport.attach('Reader');

    deliver('not a message');

    expect(decodeFailures).toHaveLength(1);
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

    new BroadcastChannelTransport(rec.request, () => channel).send(
      envelope(SELF, 'all', STATUS_REQUEST) as ProtocolMessage,
    );

    expect(rec.transportErrors.length).toBeGreaterThan(0);
  });

  it('posts no presence messages, and nothing once closed', () => {
    const { transport, posted } = create();

    // Nobody keeps track of presence on the channel, so attaching and closing post nothing.
    transport.attach('Reader');
    transport.close();
    transport.send(envelope(SELF, 'all', STATUS_REQUEST) as ProtocolMessage);

    expect(posted).toEqual([]);
  });

  it('identifies itself as the fallback', () => {
    const { transport } = create();

    expect(transport.kind).toBe('broadcastchannel');
    expect(transport.clientId).toBe(SELF);
  });
});

describe('SharedWorkerTransport, while its script is starting', () => {
  const WELCOME = welcome(SELF) as Record<string, unknown>;

  function start(): TransportRequestRecorder & {
    port: FakeMessagePort;
    ready: () => number;
    loadFailures: unknown[];
    failToLoad: () => void;
  } {
    const rec = recordTransportRequest(SELF);
    // The worker that will welcome this tab holds its lifetime lock, as a running worker does.
    holdLock(rec.locks, 'worker', workerLockName('worker-1'));
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

    // The worker's answer to hello, in its own version (ADR-0008). Such a worker drops everything
    // this tab says, so nothing sent so far reached anyone - as with a script that did not load.
    port.deliver({ ...WELCOME, v: PROTOCOL_VERSION + 1 });

    expect(ready()).toBe(0);
    expect(loadFailures).toEqual([
      { event: expect.anything() as unknown, reason: 'worker-other-protocol-version' },
    ]);
    expect(decodeFailures).toEqual([
      { reason: 'version-mismatch', theirVersion: PROTOCOL_VERSION + 1 },
    ]);
    expect(transportErrors).toHaveLength(0);
  });

  it('reports a message in another protocol version after the welcome only as a mismatch', () => {
    const { port, loadFailures, decodeFailures } = start();

    port.deliver(WELCOME);
    port.deliver({ ...WELCOME, v: PROTOCOL_VERSION + 1 });

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

    port.deliver({ ...WELCOME, v: PROTOCOL_VERSION + 1 });

    expect(loadFailures).toEqual([]);
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
