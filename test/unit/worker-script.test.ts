import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HEARTBEAT_INTERVAL_MS,
  SILENT_PARTICIPANT_TIMEOUT_MS,
  SWEEP_INTERVAL_MS,
} from '../../src/protocol/heartbeat.js';
import type { ClientId, ProtocolMessage } from '../../src/protocol/messages.js';
import { PROTOCOL_VERSION } from '../../src/protocol/version.js';
import { envelope, FakeMessagePort } from '../harness/transport-doubles.js';

/**
 * The `SharedWorker` entry point.
 *
 * Its job is to turn ports into broker calls and back. It is short, but it is the only part
 * of the library that runs in a context where a thrown exception takes every tab's coordination
 * with it - so its error handling is worth testing directly rather than inferring.
 */

let connect: (event: { ports: readonly unknown[] }) => void;

beforeEach(async () => {
  // The worker sweeps on an interval and reads the time: both are driven by the test.
  vi.useFakeTimers();
  const self = {} as { onconnect: ((event: { ports: readonly unknown[] }) => void) | null };
  vi.stubGlobal('self', self);

  // Imported fresh each time: the worker script installs a handler as a side effect of being
  // evaluated, which is exactly how a real worker behaves.
  vi.resetModules();
  await import('../../src/worker/serial-broker.worker.js');

  connect = self.onconnect as (event: { ports: readonly unknown[] }) => void;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('serial-broker.worker', () => {
  it('installs a connect handler when the script is evaluated', () => {
    expect(typeof connect).toBe('function');
  });

  it('welcomes a context that says hello, on its own port only', () => {
    const alice = new FakeMessagePort();
    const bob = new FakeMessagePort();
    connect({ ports: [alice] });
    connect({ ports: [bob] });
    bob.deliver(envelope('bob', 'all', { type: 'attach', configName: 'Reader' }));

    alice.deliver(envelope('alice', 'all', { type: 'hello' }));

    // The welcome is how a tab learns that this script loaded at all (ADR-0007).
    expect(alice.posted).toEqual([expect.objectContaining({ type: 'welcome', to: 'alice' })]);
    expect(bob.posted).toHaveLength(0);
  });

  it('forgets a port that falls silent, and knows it again from its next message', () => {
    const alice = new FakeMessagePort();
    const bob = new FakeMessagePort();
    connect({ ports: [alice] });
    connect({ ports: [bob] });
    alice.deliver(envelope('alice', 'all', { type: 'attach', configName: 'Reader' }));
    bob.deliver(envelope('bob', 'all', { type: 'attach', configName: 'Reader' }));

    // Bob keeps sending heartbeats; Alice's tab has stopped.
    const bobHeartbeat = { type: 'heartbeat', configNames: ['Reader'], ownedConfigNames: [] };
    for (
      let elapsed = 0;
      elapsed < SILENT_PARTICIPANT_TIMEOUT_MS + SWEEP_INTERVAL_MS;
      elapsed += HEARTBEAT_INTERVAL_MS
    ) {
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      bob.deliver(envelope('bob', 'all', bobHeartbeat));
    }
    bob.deliver(envelope('bob', 'all', { type: 'status-request', configName: 'Reader' }));
    expect(alice.posted).toHaveLength(0);
    expect(alice.closed).toBe(false);

    // Alice was only throttled. Her heartbeat brings her back.
    alice.deliver(
      envelope('alice', 'all', {
        type: 'heartbeat',
        configNames: ['Reader'],
        ownedConfigNames: [],
      }),
    );
    bob.deliver(envelope('bob', 'all', { type: 'status-request', configName: 'Reader' }));
    expect(alice.posted).toHaveLength(1);
  });

  it('ignores a connect event with no port', () => {
    expect(() => {
      connect({ ports: [] });
    }).not.toThrow();
  });

  it('routes a broadcast between two connected ports', () => {
    const alice = new FakeMessagePort();
    const bob = new FakeMessagePort();
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
    const alice = new FakeMessagePort();
    const bob = new FakeMessagePort();
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
    const alice = new FakeMessagePort();
    const bob = new FakeMessagePort();
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
    const alice = new FakeMessagePort();
    const bob = new FakeMessagePort();
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
    const alice = new FakeMessagePort();
    const hostile = new FakeMessagePort();
    const survivor = new FakeMessagePort();
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
    const port = new FakeMessagePort();
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
