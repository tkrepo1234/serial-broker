import { describe, expect, it } from 'vitest';

import {
  MAX_IDENTIFIER_LENGTH,
  MAX_PARTICIPANTS,
  MAX_PORTS_PER_PARTICIPANT,
} from '../../src/protocol/limits.js';
import { BROKER_ID } from '../../src/protocol/messages.js';
import { contextLockName, PROTOCOL_VERSION, workerLockName } from '../../src/protocol/version.js';
import { WorkerPorts } from '../../src/worker/worker-ports.js';
import { flushMicrotasks } from '../harness/fake-clock.js';
import { FakeLockManager } from '../harness/fake-locks.js';
import { fieldsOfEvent, recordingLogger, type LogRecord } from '../harness/recording-logger.js';
import { envelope, FakeMessagePort, hello, holdLock } from '../harness/transport-doubles.js';

/**
 * What a port on the worker may say, on whose behalf, and for how long it is served.
 *
 * Every script of the origin can start the worker and post anything on its port (SECURITY.md). These
 * tests speak for such a script - Mallory - next to well-behaved tabs, and assert on what the tabs
 * still receive.
 */

const WORKER_ID = 'worker-1';

interface World {
  readonly ports: WorkerPorts<FakeMessagePort>;
  readonly records: LogRecord[];
  readonly locks: FakeLockManager;
}

function createWorld(): World {
  const { logger, records } = recordingLogger();
  const locks = new FakeLockManager();
  const ports = new WorkerPorts<FakeMessagePort>({
    logger,
    locks: locks.forContext(WORKER_ID),
    workerId: WORKER_ID,
  });
  return { ports, records, locks };
}

/** A new port, not yet having said anything. */
function connect(): FakeMessagePort {
  return new FakeMessagePort();
}

/**
 * A port of a live tab `id`: the tab holds its own lock, as a tab does before it says hello
 * (ADR-0041), and says hello naming Reader. What the worker answered is cleared.
 */
function join(world: World, id: string, port = connect()): FakeMessagePort {
  if (world.locks.holderOf(contextLockName(id)) === undefined) {
    holdLock(world.locks, id, contextLockName(id));
  }
  world.ports.receive(port, hello(id, ['Reader']));
  port.posted.length = 0;
  return port;
}

const probe = (from: string, to = 'all'): unknown =>
  envelope(from, to, { type: 'status-request', configName: 'Reader', retry: false });

/**
 * The types of the messages a port was posted, without the worker's forwarded records.
 *
 * Every connected port is posted the worker's own warnings (ADR-0018), which say nothing about the
 * routing these tests are about; {@link recordsPosted} is what asserts on those.
 */
const typesPosted = (port: FakeMessagePort): unknown[] =>
  port.posted
    .map((message) => (message as { type: unknown }).type)
    .filter((type) => type !== 'worker-log');

/** The worker's records that were forwarded to a port, as the tab behind it receives them. */
const recordsPosted = (port: FakeMessagePort): Record<string, unknown>[] =>
  port.posted.filter((message) => (message as { type: unknown }).type === 'worker-log') as Record<
    string,
    unknown
  >[];

describe('WorkerPorts', () => {
  it('holds a lock for as long as the worker runs, and is ready once it does', async () => {
    const world = createWorld();

    await world.ports.ready;

    // Every tab waits on it: the browser lets it go the moment the worker ends (ADR-0041).
    expect(world.locks.holderOf(workerLockName(WORKER_ID))).toBe(WORKER_ID);
  });

  it('answers a hello with a welcome that names the worker, on the port it came on', () => {
    const world = createWorld();
    const alice = join(world, 'alice');
    const mallory = connect();

    world.ports.receive(mallory, hello('alice'));

    expect(mallory.posted).toEqual([
      expect.objectContaining({ type: 'welcome', to: 'alice', worker: WORKER_ID }),
    ]);
    expect(typesPosted(alice)).toEqual([]);
  });

  it('refuses what a port says before it has said hello', () => {
    const world = createWorld();
    const bob = join(world, 'bob');
    const mallory = connect();

    world.ports.receive(mallory, probe('mallory'));
    const beforeHello = typesPosted(bob);
    join(world, 'mallory', mallory);
    world.ports.receive(mallory, probe('mallory'));

    // A tab's first message is always hello (ADR-0008); one that is not comes from something else.
    expect(beforeHello).toEqual([]);
    expect(typesPosted(bob)).toEqual(['status-request']);
  });

  it('refuses a message that names another sender than its port said hello as', () => {
    const world = createWorld();
    const alice = join(world, 'alice');
    const bob = join(world, 'bob');
    const mallory = join(world, 'mallory');

    // Without the check one port could speak for every context: here, end Alice's participation.
    world.ports.receive(mallory, hello('alice', []));
    world.ports.receive(bob, probe('bob'));

    expect(typesPosted(alice)).toEqual(['status-request']);
    expect(mallory.closed).toBe(false);
  });

  it('serves a tab that connects again on a new port, on both of its ports', () => {
    const world = createWorld();
    const firstPort = join(world, 'alice');
    const bob = join(world, 'bob');

    const secondPort = join(world, 'alice');
    world.ports.receive(bob, probe('bob'));

    expect(typesPosted(secondPort)).toEqual(['status-request']);
    expect(typesPosted(firstPort)).toEqual(['status-request']);
  });

  it('routes by what the latest hello of a context names', () => {
    const world = createWorld();
    const alice = join(world, 'alice');
    const bob = join(world, 'bob');

    world.ports.receive(alice, hello('alice', []));
    world.ports.receive(bob, probe('bob'));
    world.ports.receive(alice, hello('alice', ['Reader']));
    world.ports.receive(bob, probe('bob'));

    expect(typesPosted(alice)).toEqual(['welcome', 'welcome', 'status-request']);
  });

  it('keeps a participant for as long as its lock is held, and forgets it once the browser lets go', async () => {
    const world = createWorld();
    const alice = join(world, 'alice');
    const bob = join(world, 'bob');
    await flushMicrotasks();
    world.ports.receive(bob, probe('bob'));
    const whileHeld = typesPosted(alice);

    // Alice's tab died, closed or was discarded: whichever, the browser lets go of her lock.
    world.locks.killContext('alice');
    await flushMicrotasks();
    world.ports.receive(bob, probe('bob'));

    expect(whileHeld).toEqual(['status-request']);
    expect(typesPosted(alice)).toEqual(['status-request']);
  });

  it('forgets at once an identity no context holds a lock for', async () => {
    const world = createWorld();
    const bob = join(world, 'bob');
    const alice = join(world, 'alice');
    const mallory = connect();

    world.ports.receive(mallory, hello('nobody', ['Reader']));
    await flushMicrotasks();
    world.ports.receive(bob, probe('bob'));

    expect(typesPosted(alice)).toEqual(['status-request']);
    expect(typesPosted(mallory)).toEqual(['welcome']);
  });

  it('stops waiting on the contexts once disposed', () => {
    const world = createWorld();
    join(world, 'alice');

    world.ports.dispose();

    expect(world.locks.queueLength(contextLockName('alice'))).toBe(0);
  });

  it('sends the records it writes at warn to every connected port, as it wrote them', () => {
    const world = createWorld();
    const alice = join(world, 'alice');
    const bob = join(world, 'bob');
    const mallory = connect();

    world.ports.receive(mallory, probe('mallory'));

    // A worker has no logger of its own: what it records is seen only where a tab writes it
    // (ADR-0018). A port that has said nothing the worker accepted is no participant and gets none.
    const record = {
      type: 'worker-log',
      level: 'warn',
      message: 'refused a message from a port that has not said hello',
      fields: expect.objectContaining({
        event: 'worker.message-refused',
        reason: 'before-hello',
      }) as unknown,
    };
    expect(recordsPosted(alice)).toEqual([expect.objectContaining({ ...record, to: 'alice' })]);
    expect(recordsPosted(bob)).toEqual([expect.objectContaining({ ...record, to: 'bob' })]);
    expect(recordsPosted(mallory)).toEqual([]);
  });

  it('sends no debug or info record to the tabs, however many the worker writes', () => {
    const world = createWorld();
    const alice = join(world, 'alice');

    // Connecting, disconnecting and routing are recorded at debug and info, once per message; a tab
    // that received all of them would be told more about the worker than about its own device.
    join(world, 'bob');
    world.ports.receive(alice, probe('alice'));

    expect(recordsPosted(alice)).toEqual([]);
  });

  it('forwards each kind of record once, however many a script of the origin causes', () => {
    const world = createWorld();
    const alice = join(world, 'alice');

    for (let index = 0; index < 20; index += 1) {
      // Each hello in a version of its own is a record the worker writes: nothing bounds how many
      // of them a script of the origin can cause (SECURITY.md).
      world.ports.receive(connect(), { v: 100 + index, from: 'mallory', to: 'all', type: 'hello' });
      world.ports.reportMessageError(alice);
    }

    expect(recordsPosted(alice).map((record) => record['fields'])).toEqual([
      expect.objectContaining({ event: 'worker.other-protocol-version', clientId: 'mallory' }),
      expect.objectContaining({ event: 'worker.message-error', clientId: 'alice' }),
    ]);
  });

  it("refuses a hello that names the broker's own identity", () => {
    const world = createWorld();
    const bob = join(world, 'bob');
    const mallory = connect();

    world.ports.receive(mallory, hello(BROKER_ID, ['Reader']));
    world.ports.receive(mallory, probe(BROKER_ID));

    expect(typesPosted(mallory)).toEqual([]);
    expect(typesPosted(bob)).toEqual([]);
  });

  it('logs each kind of refused message once, however often it is repeated', () => {
    const world = createWorld();
    const mallory = connect();

    for (let round = 0; round < 100; round += 1) {
      world.ports.receive(mallory, probe('mallory'));
    }

    expect(fieldsOfEvent(world.records, 'worker.message-refused')).toEqual([
      expect.objectContaining({ reason: 'before-hello', messageType: 'status-request' }),
    ]);
    expect(world.records.filter(([level]) => level === 'warn')).toHaveLength(1);
  });

  it('drops a message beyond a limit, and logs the limit once at warn', () => {
    const world = createWorld();
    const bob = join(world, 'bob');
    const mallory = join(world, 'mallory');

    for (let round = 0; round < 100; round += 1) {
      world.ports.receive(
        mallory,
        envelope('mallory', 'all', {
          type: 'status-request',
          configName: 'R'.repeat(129),
          retry: false,
        }),
      );
    }
    world.ports.receive(mallory, probe('mallory'));

    expect(typesPosted(bob)).toEqual(['status-request']);
    expect(fieldsOfEvent(world.records, 'worker.limit-exceeded')).toEqual([
      expect.objectContaining({ limit: 'MAX_CONFIG_NAME_LENGTH', clientId: 'mallory' }),
    ]);
  });

  it('keeps no more than MAX_PARTICIPANTS participants, and admits another once one leaves', async () => {
    const world = createWorld();
    for (let index = 0; index < MAX_PARTICIPANTS; index += 1) {
      join(world, `tab-${String(index)}`);
    }
    holdLock(world.locks, 'late', contextLockName('late'));
    const late = connect();

    world.ports.receive(late, hello('late'));
    expect(typesPosted(late)).toEqual([]);
    expect(fieldsOfEvent(world.records, 'worker.limit-exceeded')).toEqual([
      expect.objectContaining({ limit: 'MAX_PARTICIPANTS' }),
    ]);

    // Its port keeps its identity, so its next hello gets in once there is room.
    world.locks.killContext('tab-0');
    await flushMicrotasks();
    world.ports.receive(late, hello('late'));
    expect(typesPosted(late)).toEqual(['welcome']);
  });

  it('keeps no more than MAX_PORTS_PER_PARTICIPANT ports for one identity', () => {
    const world = createWorld();
    const alice = join(world, 'alice');
    for (let index = 1; index < MAX_PORTS_PER_PARTICIPANT; index += 1) {
      join(world, 'alice');
    }
    const oneTooMany = connect();

    world.ports.receive(oneTooMany, hello('alice'));
    world.ports.receive(join(world, 'bob'), probe('bob'));

    expect(typesPosted(oneTooMany)).toEqual([]);
    expect(typesPosted(alice)).toEqual(['status-request']);
    expect(fieldsOfEvent(world.records, 'worker.limit-exceeded')).toEqual([
      expect.objectContaining({ limit: 'MAX_PORTS_PER_PARTICIPANT' }),
    ]);
  });

  it('does not echo a sender of any length back in its welcome to another protocol version', () => {
    const world = createWorld();
    const mallory = connect();

    world.ports.receive(mallory, {
      v: PROTOCOL_VERSION + 1,
      from: 'm'.repeat(MAX_IDENTIFIER_LENGTH + 1),
      to: 'all',
      type: 'hello',
    });

    expect(typesPosted(mallory)).toEqual([]);
  });
});
