import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { contextLockName, PROTOCOL_VERSION } from '../../src/protocol/version.js';
import { flushMicrotasks } from '../harness/fake-clock.js';
import { FakeLockManager } from '../harness/fake-locks.js';
import { envelope, FakeMessagePort, hello, holdLock } from '../harness/transport-doubles.js';

/**
 * The `SharedWorker` entry point.
 *
 * Its job is to turn ports into broker calls and back. It is short, but it is the only part
 * of the library that runs in a context where a thrown exception takes every tab's coordination
 * with it - so its error handling is worth testing directly rather than inferring. What a port may
 * say, and for whom, is tested against `WorkerPorts` itself in `worker-ports.test.ts`.
 */

let connect: (event: { ports: readonly unknown[] }) => void;
let locks: FakeLockManager;

beforeEach(async () => {
  const self = {} as { onconnect: ((event: { ports: readonly unknown[] }) => void) | null };
  vi.stubGlobal('self', self);
  // The worker's own Web Locks: it holds one for its lifetime, and waits on every tab's (ADR-0041).
  locks = new FakeLockManager();
  vi.stubGlobal('navigator', { locks: locks.forContext('worker') });

  // Imported fresh each time: the worker script installs a handler as a side effect of being
  // evaluated, which is exactly how a real worker behaves.
  vi.resetModules();
  await import('../../src/worker/serial-broker.worker.js');

  connect = self.onconnect as (event: { ports: readonly unknown[] }) => void;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** What was routed to a port: everything but the worker's own records, which every port gets. */
const routed = (port: FakeMessagePort): unknown[] =>
  port.posted.filter((message) => (message as { type: unknown }).type !== 'worker-log');

/** The worker's records forwarded to a port (ADR-0029). */
const recordsPosted = (port: FakeMessagePort): unknown[] =>
  port.posted.filter((message) => (message as { type: unknown }).type === 'worker-log');

/**
 * Connects a port of a live tab and says hello on it as `id`, taking part in `configNames`, as
 * every tab's transport does first once it holds its own lock (ADR-0024, ADR-0041). What the worker
 * answered is cleared, so a test sees only what follows.
 */
function join(id: string, configNames: readonly string[] = ['Reader']): FakeMessagePort {
  holdLock(locks, id, contextLockName(id));
  const port = new FakeMessagePort();
  connect({ ports: [port] });
  port.deliver(hello(id, configNames));
  port.posted.length = 0;
  return port;
}

describe('serial-broker.worker', () => {
  it('starts a port only once the worker holds its lifetime lock', async () => {
    const port = new FakeMessagePort();

    connect({ ports: [port] });
    const startedAtOnce = port.started;
    await flushMicrotasks();

    // A tab welcomed earlier could wait on a lock the worker does not hold yet, and take it for a
    // worker that has ended.
    expect(startedAtOnce).toBe(false);
    expect(port.started).toBe(true);
  });

  it('answers a hello in another protocol version with a welcome in its own, and nothing more', () => {
    const alice = new FakeMessagePort();
    connect({ ports: [alice] });
    const bob = join('bob');

    // A tab of another build that was served this worker script: a copied file left over from an
    // earlier release, or a cached one (ADR-0024).
    const otherVersion = { v: PROTOCOL_VERSION + 1, from: 'alice', to: 'all' };
    alice.deliver({ ...otherVersion, type: 'hello' });
    alice.deliver({ ...otherVersion, type: 'status-request', configName: 'Reader' });
    bob.deliver(envelope('bob', 'all', { type: 'status-request', configName: 'Reader' }));

    // The welcome carries this worker's version, which is how the tab learns that the two differ.
    // Everything else the tab says is still dropped, so it never takes part.
    expect(alice.posted).toEqual([
      expect.objectContaining({ type: 'welcome', v: PROTOCOL_VERSION, to: 'alice' }),
    ]);
    expect(routed(bob)).toEqual([]);
    // Bob, on this version, is told what the worker recorded about it (ADR-0029).
    expect(recordsPosted(bob)).toEqual([
      expect.objectContaining({
        type: 'worker-log',
        level: 'warn',
        fields: expect.objectContaining({
          event: 'worker.other-protocol-version',
          clientId: 'alice',
        }) as unknown,
      }),
    ]);
  });

  it('answers a hello whose version is not a number at all, as the frozen handshake promises', () => {
    const alice = new FakeMessagePort();
    connect({ ports: [alice] });

    alice.deliver({ v: 'seven', from: 'alice', to: 'all', type: 'hello' });

    expect(alice.posted).toEqual([expect.objectContaining({ type: 'welcome', to: 'alice' })]);
  });

  it('does not answer a hello in another protocol version that names no sender', () => {
    const alice = new FakeMessagePort();
    connect({ ports: [alice] });

    alice.deliver({ v: PROTOCOL_VERSION + 1, to: 'all', type: 'hello' });
    alice.deliver({ v: PROTOCOL_VERSION + 1, from: '', to: 'all', type: 'hello' });

    expect(alice.posted).toHaveLength(0);
  });

  it('keeps a port whose message failed to clone, and goes on routing to it', () => {
    const alice = join('alice');
    alice.deliver(
      envelope('alice', 'all', {
        type: 'owner-claimed',
        configName: 'Reader',
        term: 't-1',
        maxTabs: 1,
      }),
    );
    const bob = join('bob');

    // One message from the owner could not be cloned. Only that message is lost: closing the port
    // would cut the owner off, with nothing to tell it so.
    alice.failToClone();
    bob.deliver(
      envelope('bob', 'all', {
        type: 'write-request',
        configName: 'Reader',
        requestId: 'w-1',
        payload: new Uint8Array([1]),
        term: 't-1',
        remainingMs: 5_000,
      }),
    );

    expect(alice.closed).toBe(false);
    expect(routed(alice)).toEqual([expect.objectContaining({ type: 'write-request' })]);
    // The tab also learns what the worker recorded about the message it lost (ADR-0029).
    expect(recordsPosted(alice)).toEqual([
      expect.objectContaining({
        fields: expect.objectContaining({ event: 'worker.message-error' }) as unknown,
      }),
    ]);
  });

  it('ignores a connect event with no port', () => {
    expect(() => {
      connect({ ports: [] });
    }).not.toThrow();
  });

  it('drops a message it cannot parse, without disturbing anything else', () => {
    const alice = join('alice');
    const bob = join('bob');

    // A message from an unrelated script that happens to use the same channel name, or from a
    // build with a different protocol version.
    alice.deliver({ nonsense: true });
    alice.deliver({ v: PROTOCOL_VERSION + 99, from: 'alice', to: 'all', type: 'status-request' });
    alice.deliver(envelope('alice', 'all', { type: 'status-request', configName: 'Reader' }));

    expect(bob.posted).toHaveLength(1);
  });

  it('survives a port that throws when posted to', () => {
    const alice = join('alice');
    holdLock(locks, 'hostile', contextLockName('hostile'));
    const hostile = new FakeMessagePort();
    connect({ ports: [hostile] });
    hostile.deliver(hello('hostile', ['Reader']));
    Object.assign(hostile, {
      postMessage: () => {
        throw new Error('the port is gone');
      },
    });
    const survivor = join('survivor');

    alice.deliver(envelope('alice', 'all', { type: 'status-request', configName: 'Reader' }));

    // One dead port must not cost every other tab its message.
    expect(survivor.posted).toHaveLength(1);
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

    expect(code).not.toContain('serial');
    expect(code).not.toContain('SerialPort');
  });
});
