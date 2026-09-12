import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClientId, ProtocolMessage } from '../../src/protocol/messages.js';
import { PROTOCOL_VERSION } from '../../src/protocol/version.js';

/**
 * The `SharedWorker` entry point.
 *
 * Its job is to turn ports into broker calls and back. It is short, but it is the only part
 * of the library that runs in a context where a thrown exception takes every tab's coordination
 * with it - so its error handling is worth testing directly rather than inferring.
 */

interface FakePort {
  readonly posted: unknown[];
  deliver(raw: unknown): void;
  closed: boolean;
}

/** A `MessagePort` that records what the worker sends and replays what it is given. */
function createPort(): FakePort {
  const listeners = new Map<string, (event: unknown) => void>();

  return {
    posted: [],
    closed: false,
    deliver(raw: unknown) {
      listeners.get('message')?.({ data: raw });
    },
    // The worker only uses these four members.
    ...({
      postMessage(this: FakePort, message: unknown) {
        this.posted.push(message);
      },
      start: () => undefined,
      close(this: FakePort) {
        this.closed = true;
      },
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        listeners.set(type, listener);
      },
    } as object),
  } as FakePort;
}

function envelope(from: string, to: string, extra: Record<string, unknown>): unknown {
  return { v: PROTOCOL_VERSION, from, to, ...extra };
}

let connect: (event: { ports: readonly unknown[] }) => void;

beforeEach(async () => {
  const self = {} as { onconnect: ((event: { ports: readonly unknown[] }) => void) | null };
  vi.stubGlobal('self', self);

  // Imported fresh each time: the worker script installs a handler as a side effect of being
  // evaluated, which is exactly how a real worker behaves.
  vi.resetModules();
  await import('../../src/worker/serial-broker.worker.js');

  connect = self.onconnect as (event: { ports: readonly unknown[] }) => void;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('serial-broker.worker', () => {
  it('installs a connect handler when the script is evaluated', () => {
    expect(typeof connect).toBe('function');
  });

  it('ignores a connect event with no port', () => {
    expect(() => {
      connect({ ports: [] });
    }).not.toThrow();
  });

  it('routes a broadcast between two connected ports', () => {
    const alice = createPort();
    const bob = createPort();
    connect({ ports: [alice] });
    connect({ ports: [bob] });

    alice.deliver(envelope('alice', 'all', { type: 'attach', configName: 'Reader' }));
    bob.deliver(envelope('bob', 'all', { type: 'attach', configName: 'Reader' }));
    alice.deliver(envelope('alice', 'all', { type: 'status-request', configName: 'Reader' }));

    expect(bob.posted).toHaveLength(1);
    expect((bob.posted[0] as ProtocolMessage).type).toBe('status-request');
    expect(alice.posted).toHaveLength(0);
  });

  it('routes a write request to whichever port claimed ownership', () => {
    const alice = createPort();
    const bob = createPort();
    connect({ ports: [alice] });
    connect({ ports: [bob] });

    alice.deliver(envelope('alice', 'all', { type: 'attach', configName: 'Reader' }));
    bob.deliver(envelope('bob', 'all', { type: 'attach', configName: 'Reader' }));
    alice.deliver(envelope('alice', 'all', { type: 'owner-claimed', configName: 'Reader' }));
    alice.posted.length = 0;

    bob.deliver(
      envelope('bob', 'owner', {
        type: 'write-request',
        configName: 'Reader',
        requestId: 'w-1',
        payload: new Uint8Array([1]),
      }),
    );

    expect(alice.posted).toHaveLength(1);
  });

  it('drops a message it cannot parse, without disturbing anything else', () => {
    const alice = createPort();
    const bob = createPort();
    connect({ ports: [alice] });
    connect({ ports: [bob] });
    alice.deliver(envelope('alice', 'all', { type: 'attach', configName: 'Reader' }));
    bob.deliver(envelope('bob', 'all', { type: 'attach', configName: 'Reader' }));

    // A message from an unrelated script that happens to use the same channel name, or from a
    // build with a different protocol version.
    alice.deliver({ nonsense: true });
    alice.deliver({ v: PROTOCOL_VERSION + 99, from: 'alice', to: 'all', type: 'attach' });
    alice.deliver(envelope('alice', 'all', { type: 'status-request', configName: 'Reader' }));

    expect(bob.posted).toHaveLength(1);
  });

  it('stops routing to a port that said goodbye', () => {
    const alice = createPort();
    const bob = createPort();
    connect({ ports: [alice] });
    connect({ ports: [bob] });
    alice.deliver(envelope('alice', 'all', { type: 'attach', configName: 'Reader' }));
    bob.deliver(envelope('bob', 'all', { type: 'attach', configName: 'Reader' }));

    bob.deliver(envelope('bob', 'all', { type: 'goodbye' }));
    alice.deliver(envelope('alice', 'all', { type: 'status-request', configName: 'Reader' }));

    expect(bob.posted).toHaveLength(0);
    expect(bob.closed).toBe(true);
  });

  it('survives a port that throws when posted to', () => {
    const alice = createPort();
    const hostile = createPort();
    const survivor = createPort();
    Object.assign(hostile, {
      postMessage: () => {
        throw new Error('the port is gone');
      },
    });

    connect({ ports: [alice] });
    connect({ ports: [hostile] });
    connect({ ports: [survivor] });
    for (const [id, port] of [
      ['alice', alice],
      ['hostile', hostile],
      ['survivor', survivor],
    ] as const) {
      port.deliver(envelope(id, 'all', { type: 'attach', configName: 'Reader' }));
    }

    alice.deliver(envelope('alice', 'all', { type: 'status-request', configName: 'Reader' }));

    // One dead port must not cost every other tab its message.
    expect(survivor.posted).toHaveLength(1);
  });

  it('accepts a reconnecting context that reuses its port', () => {
    const port = createPort();
    connect({ ports: [port] });

    port.deliver(envelope('alice', 'all', { type: 'attach', configName: 'Reader' }));
    port.deliver(envelope('alice', 'all', { type: 'attach', configName: 'Reader' }));

    expect(() => {
      port.deliver(envelope('alice', 'all', { type: 'status-request', configName: 'Reader' }));
    }).not.toThrow();
  });

  it('never imports the Web Serial API', async () => {
    // `navigator.serial` is not exposed to workers at all (ADR-0004). A worker that reached
    // for it would throw on evaluation and take the broker down for every tab.
    const source = await import('node:fs/promises').then(
      async (fs) => await fs.readFile('src/worker/serial-broker.worker.ts', 'utf8'),
    );

    // Comments are allowed to mention it - the file explains why it must not use it - so the
    // check is against the code, not the prose.
    const code = source
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');

    expect(code).not.toContain('navigator');
    expect(code).not.toContain('SerialPort');
  });
});

/** Keeps the ClientId import meaningful for readers of this file. */
export type { ClientId };
