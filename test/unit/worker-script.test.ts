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

  it('answers a hello in another protocol version with a welcome in its own, and nothing more', () => {
    const alice = new FakeMessagePort();
    const bob = new FakeMessagePort();
    connect({ ports: [alice] });
    connect({ ports: [bob] });
    bob.deliver(envelope('bob', 'all', { type: 'attach', configName: 'Reader' }));

    // A tab of another build that was served this worker script: a copied file left over from an
    // earlier release, or a cached one (ADR-0024).
    const otherVersion = { v: PROTOCOL_VERSION + 1, from: 'alice', to: 'all' };
    alice.deliver({ ...otherVersion, type: 'hello' });
    alice.deliver({ ...otherVersion, type: 'attach', configName: 'Reader' });
    bob.deliver(envelope('bob', 'all', { type: 'status-request', configName: 'Reader' }));

    // The welcome carries this worker's version, which is how the tab learns that the two differ.
    // Everything else the tab says is still dropped, so it never takes part.
    expect(alice.posted).toEqual([
      expect.objectContaining({ type: 'welcome', v: PROTOCOL_VERSION, to: 'alice' }),
    ]);
    expect(bob.posted).toHaveLength(0);
  });

  it('does not answer a hello in another protocol version that names no sender', () => {
    const alice = new FakeMessagePort();
    connect({ ports: [alice] });

    alice.deliver({ v: PROTOCOL_VERSION + 1, to: 'all', type: 'hello' });
    alice.deliver({ v: PROTOCOL_VERSION + 1, from: '', to: 'all', type: 'hello' });

    expect(alice.posted).toHaveLength(0);
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
    // The broker answers her heartbeat, and routes to her again.
    expect(alice.posted).toEqual([
      expect.objectContaining({ type: 'welcome' }),
      expect.objectContaining({ type: 'status-request' }),
    ]);
  });

  it('keeps a port whose message failed to clone, and goes on routing to it', () => {
    const alice = new FakeMessagePort();
    const bob = new FakeMessagePort();
    connect({ ports: [alice] });
    connect({ ports: [bob] });
    alice.deliver(envelope('alice', 'all', { type: 'attach', configName: 'Reader' }));
    alice.deliver(envelope('alice', 'all', { type: 'owner-claimed', configName: 'Reader' }));
    bob.deliver(envelope('bob', 'all', { type: 'attach', configName: 'Reader' }));
    alice.posted.length = 0;

    // One message from the owner could not be cloned. Only that message is lost: closing the port
    // would cut the owner off for good, with nothing to tell it so (ADR-0021).
    alice.failToClone();
    bob.deliver(
      envelope('bob', 'owner', {
        type: 'write-request',
        configName: 'Reader',
        requestId: 'w-1',
        payload: new Uint8Array([1]),
      }),
    );

    expect(alice.closed).toBe(false);
    expect(alice.posted).toEqual([expect.objectContaining({ type: 'write-request' })]);
  });

  it('listens for clone failures on a port once, however often the port is forgotten and returns', () => {
    const alice = new FakeMessagePort();
    connect({ ports: [alice] });
    const heartbeat = { type: 'heartbeat', configNames: ['Reader'], ownedConfigNames: [] };
    alice.deliver(envelope('alice', 'all', heartbeat));

    // A throttled tab: forgotten by the sweep, restored by its next heartbeat - three times over.
    for (let round = 0; round < 3; round += 1) {
      vi.advanceTimersByTime(SILENT_PARTICIPANT_TIMEOUT_MS + SWEEP_INTERVAL_MS);
      alice.deliver(envelope('alice', 'all', heartbeat));
    }

    expect(alice.listenerCount('messageerror')).toBe(1);
  });

  it('answers a heartbeat on the port it came from', () => {
    const alice = new FakeMessagePort();
    const bob = new FakeMessagePort();
    connect({ ports: [alice] });
    connect({ ports: [bob] });
    bob.deliver(envelope('bob', 'all', { type: 'attach', configName: 'Reader' }));

    alice.deliver(
      envelope('alice', 'all', {
        type: 'heartbeat',
        configNames: ['Reader'],
        ownedConfigNames: [],
      }),
    );

    // A tab that hears nothing back gives up on the worker and starts a new one (ADR-0021).
    expect(alice.posted).toEqual([expect.objectContaining({ type: 'welcome', to: 'alice' })]);
    expect(bob.posted).toHaveLength(0);
  });

  it('routes to the port a context came back on, even after a late message on the one it left', () => {
    const oldPort = new FakeMessagePort();
    const newPort = new FakeMessagePort();
    const bob = new FakeMessagePort();
    const heartbeat = { type: 'heartbeat', configNames: ['Reader'], ownedConfigNames: [] };
    connect({ ports: [oldPort] });
    oldPort.deliver(envelope('alice', 'all', heartbeat));
    vi.advanceTimersByTime(SILENT_PARTICIPANT_TIMEOUT_MS + SWEEP_INTERVAL_MS);

    // Alice's tab gave up on this worker while it was stuck, and connected again. A message still
    // queued on her old port arrives after the new port was registered, and nothing follows it.
    connect({ ports: [newPort] });
    newPort.deliver(envelope('alice', 'all', heartbeat));
    oldPort.deliver(envelope('alice', 'all', heartbeat));
    oldPort.posted.length = 0;
    newPort.posted.length = 0;

    connect({ ports: [bob] });
    bob.deliver(envelope('bob', 'all', { type: 'status-request', configName: 'Reader' }));

    expect(newPort.posted).toEqual([expect.objectContaining({ type: 'status-request' })]);
    expect(oldPort.posted).toHaveLength(0);
  });

  it('keeps routing to the port a context came back on when its old port speaks once more', () => {
    const oldPort = new FakeMessagePort();
    const newPort = new FakeMessagePort();
    const bob = new FakeMessagePort();
    const heartbeat = { type: 'heartbeat', configNames: ['Reader'], ownedConfigNames: [] };
    connect({ ports: [oldPort] });
    oldPort.deliver(envelope('alice', 'all', heartbeat));

    // No sweep in between: the worker hung for less than the timeout, and Alice's tab gave up on it
    // all the same, after three unanswered heartbeats (ADR-0021).
    connect({ ports: [newPort] });
    newPort.deliver(envelope('alice', 'all', heartbeat));
    oldPort.deliver(envelope('alice', 'all', heartbeat));
    oldPort.posted.length = 0;
    newPort.posted.length = 0;

    connect({ ports: [bob] });
    bob.deliver(envelope('bob', 'all', { type: 'status-request', configName: 'Reader' }));

    expect(newPort.posted).toEqual([expect.objectContaining({ type: 'status-request' })]);
    expect(oldPort.posted).toHaveLength(0);
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
