import { describe, expect, it, vi } from 'vitest';

import {
  BroadcastChannelTransport,
  type BroadcastChannelLike,
} from '../../src/client/transport/broadcast-channel-transport.js';
import {
  SharedWorkerTransport,
  type MessagePortLike,
  type SharedWorkerLike,
} from '../../src/client/transport/shared-worker-transport.js';
import type { TransportRequest } from '../../src/client/transport/transport.js';
import { NOOP_LOGGER, ScopedLogger } from '../../src/core/logger.js';
import { HEARTBEAT_INTERVAL_MS } from '../../src/protocol/heartbeat.js';
import type { ClientId, ProtocolMessage } from '../../src/protocol/messages.js';
import { PROTOCOL_VERSION } from '../../src/protocol/version.js';
import { FakeClock } from '../harness/fake-clock.js';

const SELF = 'self' as ClientId;
const PEER = 'peer' as ClientId;

interface Recorder {
  readonly request: TransportRequest;
  readonly clock: FakeClock;
  readonly messages: ProtocolMessage[];
  readonly decodeFailures: unknown[];
  readonly transportErrors: unknown[];
}

function recorder(): Recorder {
  const messages: ProtocolMessage[] = [];
  const decodeFailures: unknown[] = [];
  const transportErrors: unknown[] = [];
  const clock = new FakeClock();

  return {
    clock,
    messages,
    decodeFailures,
    transportErrors,
    request: {
      clientId: SELF,
      onMessage: (message) => messages.push(message),
      onDecodeFailure: (failure) => decodeFailures.push(failure),
      onTransportError: (error) => transportErrors.push(error),
      logger: new ScopedLogger(NOOP_LOGGER, {}),
      clock,
    },
  };
}

function envelope(
  from: ClientId,
  to: ProtocolMessage['to'],
  extra: Record<string, unknown> = {},
): unknown {
  return { v: PROTOCOL_VERSION, from, to, type: 'status-request', configName: 'Reader', ...extra };
}

/** A `MessagePort` whose incoming messages a test can drive. */
function fakePort(): {
  port: MessagePortLike;
  posted: unknown[];
  deliver: (raw: unknown) => void;
  fail: (type: 'messageerror') => void;
  closed: () => boolean;
} {
  const posted: unknown[] = [];
  const listeners = new Map<string, (event: never) => void>();
  let isClosed = false;

  const port = {
    postMessage: (message: unknown) => posted.push(message),
    start: () => undefined,
    close: () => {
      isClosed = true;
    },
    addEventListener: (type: string, listener: (event: never) => void) => {
      listeners.set(type, listener);
    },
  } as unknown as MessagePortLike;

  return {
    port,
    posted,
    deliver: (raw) => listeners.get('message')?.({ data: raw } as never),
    fail: (type) => listeners.get(type)?.({} as never),
    closed: () => isClosed,
  };
}

describe('SharedWorkerTransport', () => {
  function create(): ReturnType<typeof recorder> &
    ReturnType<typeof fakePort> & {
      transport: SharedWorkerTransport;
    } {
    const rec = recorder();
    const fake = fakePort();
    const worker: SharedWorkerLike = { port: fake.port, addEventListener: () => undefined };
    const transport = new SharedWorkerTransport(rec.request, () => worker, 'fake://worker');
    return { ...rec, ...fake, transport };
  }

  it('announces itself as soon as it connects', () => {
    const { posted } = create();

    expect((posted[0] as ProtocolMessage).type).toBe('hello');
  });

  it('sends attach and detach as messages, because the broker needs to know', () => {
    const { transport, posted } = create();

    transport.attach('Reader');
    transport.detach('Reader');

    expect((posted[1] as ProtocolMessage).type).toBe('attach');
    expect((posted[2] as ProtocolMessage).type).toBe('detach');
  });

  it('delivers a valid message from the broker', () => {
    const { deliver, messages } = create();

    deliver(envelope(PEER, SELF));

    expect(messages).toHaveLength(1);
  });

  it('reports a message it cannot parse instead of delivering it', () => {
    const { deliver, messages, decodeFailures } = create();

    deliver({ garbage: true });

    expect(messages).toHaveLength(0);
    expect(decodeFailures).toHaveLength(1);
  });

  it('ignores its own message coming back', () => {
    const { deliver, messages } = create();

    // Double-delivering every local event would be a miserable bug to find.
    deliver(envelope(SELF, 'all'));

    expect(messages).toHaveLength(0);
  });

  it('reports a failure to post rather than throwing into the caller', () => {
    const rec = recorder();
    const fake = fakePort();
    Object.assign(fake.port, {
      postMessage: () => {
        throw new Error('the port is closed');
      },
    });
    const worker: SharedWorkerLike = { port: fake.port, addEventListener: () => undefined };

    const transport = new SharedWorkerTransport(rec.request, () => worker, 'fake://w');
    transport.attach('Reader');

    // A caller in the middle of a state transition has nothing useful to do with an exception
    // from a postMessage.
    expect(rec.transportErrors.length).toBeGreaterThan(0);
  });

  it('reports a message that failed to clone on the way in', () => {
    const { fail, transportErrors } = create();

    fail('messageerror');

    expect(transportErrors).toHaveLength(1);
  });

  it('says goodbye and closes the port', () => {
    const { transport, posted, closed } = create();

    transport.close();

    expect((posted.at(-1) as ProtocolMessage).type).toBe('goodbye');
    expect(closed()).toBe(true);
  });

  it('is safe to close twice and sends nothing afterwards', () => {
    const { transport, posted } = create();

    transport.close();
    const after = posted.length;
    transport.close();
    transport.attach('Reader');

    expect(posted).toHaveLength(after);
  });

  it('ignores ownership changes, because the broker already knows', () => {
    const { transport, posted } = create();
    const before = posted.length;

    transport.setOwnership('Reader', true);

    expect(posted).toHaveLength(before);
  });
});

describe('BroadcastChannelTransport', () => {
  function create(): ReturnType<typeof recorder> & {
    transport: BroadcastChannelTransport;
    posted: unknown[];
    deliver: (raw: unknown) => void;
  } {
    const rec = recorder();
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
    deliver(envelope(PEER, 'all'));

    expect(messages).toHaveLength(1);
  });

  it('discards a broadcast for a configuration it has not attached to', () => {
    const { deliver, messages } = create();

    // With no broker, every message reaches every context; filtering is the receiver's job.
    deliver(envelope(PEER, 'all'));

    expect(messages).toHaveLength(0);
  });

  it('accepts a message addressed to the owner only while it owns the port', () => {
    const { transport, deliver, messages } = create();
    transport.attach('Reader');

    deliver(envelope(PEER, 'owner'));
    expect(messages).toHaveLength(0);

    transport.setOwnership('Reader', true);
    deliver(envelope(PEER, 'owner'));
    expect(messages).toHaveLength(1);

    transport.setOwnership('Reader', false);
    deliver(envelope(PEER, 'owner'));
    expect(messages).toHaveLength(1);
  });

  it('accepts a message addressed to it by name', () => {
    const { deliver, messages } = create();

    deliver(envelope(PEER, SELF));

    expect(messages).toHaveLength(1);
  });

  it('discards a message addressed to somebody else', () => {
    const { deliver, messages } = create();

    deliver(envelope(PEER, 'another-tab' as ClientId));

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
    deliver(envelope(PEER, 'all'));
    deliver(envelope(PEER, 'owner'));

    expect(messages).toHaveLength(0);
  });

  it('ignores its own message, should the channel ever echo one back', () => {
    const { transport, deliver, messages } = create();
    transport.attach('Reader');

    deliver(envelope(SELF, 'all'));

    expect(messages).toHaveLength(0);
  });

  it('reports a failure to post', () => {
    const rec = recorder();
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
    const rec = recorder();
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
    const rec = recorder();
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

  function start(): ReturnType<typeof recorder> &
    ReturnType<typeof fakePort> & {
      ready: () => number;
      loadFailures: unknown[];
      failToLoad: () => void;
    } {
    const rec = recorder();
    const fake = fakePort();
    let errorListener: (event: unknown) => void = () => undefined;
    const worker: SharedWorkerLike = {
      port: fake.port,
      addEventListener: (_type, listener) => {
        errorListener = listener;
      },
    };
    let readyCount = 0;
    const loadFailures: unknown[] = [];

    new SharedWorkerTransport(rec.request, () => worker, 'fake://worker', {
      onReady: () => {
        readyCount += 1;
      },
      onLoadFailed: (event) => loadFailures.push(event),
    });

    return {
      ...rec,
      ...fake,
      ready: () => readyCount,
      loadFailures,
      failToLoad: () => {
        errorListener({ type: 'error' });
      },
    };
  }

  it('reports the script running when the broker welcomes it, and keeps the welcome to itself', () => {
    const { deliver, ready, messages } = start();

    deliver(WELCOME);
    deliver(WELCOME);

    expect(ready()).toBe(1);
    expect(messages).toHaveLength(0);
  });

  it('reports a failure before the welcome as a load failure, not a transport error', () => {
    const { failToLoad, loadFailures, transportErrors } = start();

    failToLoad();

    expect(loadFailures).toHaveLength(1);
    expect(transportErrors).toHaveLength(0);
  });

  it('reports a failure after the welcome as a transport error', () => {
    const { deliver, failToLoad, loadFailures, transportErrors } = start();

    deliver(WELCOME);
    failToLoad();

    expect(loadFailures).toHaveLength(0);
    expect(transportErrors).toHaveLength(1);
  });
});

describe('SharedWorkerTransport heartbeats', () => {
  function start(): ReturnType<typeof recorder> &
    ReturnType<typeof fakePort> & { transport: SharedWorkerTransport } {
    const rec = recorder();
    const fake = fakePort();
    const worker: SharedWorkerLike = { port: fake.port, addEventListener: () => undefined };
    const transport = new SharedWorkerTransport(rec.request, () => worker, 'fake://worker');
    return { ...rec, ...fake, transport };
  }

  it('tells the broker periodically what this context takes part in and owns', async () => {
    const { transport, posted, clock } = start();
    transport.attach('Reader');
    transport.attach('Printer');
    transport.setOwnership('Reader', true);
    transport.detach('Printer');
    posted.length = 0;

    await clock.advance(HEARTBEAT_INTERVAL_MS);

    expect(posted).toEqual([
      expect.objectContaining({
        type: 'heartbeat',
        configNames: ['Reader'],
        ownedConfigNames: ['Reader'],
      }),
    ]);

    transport.setOwnership('Reader', false);
    await clock.advance(HEARTBEAT_INTERVAL_MS);
    expect(posted.at(-1)).toMatchObject({ configNames: ['Reader'], ownedConfigNames: [] });
  });

  it('stops sending heartbeats once closed', async () => {
    const { transport, posted, clock } = start();

    transport.close();
    posted.length = 0;
    await clock.advance(3 * HEARTBEAT_INTERVAL_MS);

    expect(posted).toEqual([]);
    expect(clock.pendingTimerCount).toBe(0);
  });
});

describe('SharedWorkerTransport once closed', () => {
  it('reports nothing the worker or its port says any more', () => {
    const rec = recorder();
    const fake = fakePort();
    let workerError: (event: unknown) => void = () => undefined;
    const worker: SharedWorkerLike = {
      port: fake.port,
      addEventListener: (_type, listener) => {
        workerError = listener;
      },
    };
    const transport = new SharedWorkerTransport(rec.request, () => worker, 'fake://worker');

    transport.close();
    workerError({ type: 'error' });
    fake.fail('messageerror');

    expect(rec.transportErrors).toEqual([]);
  });
});
