import { describe, expect, it } from 'vitest';

import { SILENT_PARTICIPANT_TIMEOUT_MS } from '../../src/protocol/heartbeat.js';
import {
  MAX_IDENTIFIER_LENGTH,
  MAX_PARTICIPANTS,
  MAX_PORTS_PER_PARTICIPANT,
} from '../../src/protocol/limits.js';
import { BROKER_ID } from '../../src/protocol/messages.js';
import { WorkerPorts } from '../../src/worker/worker-ports.js';
import { fieldsOfEvent, recordingLogger, type LogRecord } from '../harness/recording-logger.js';
import { envelope, FakeMessagePort, hello } from '../harness/transport-doubles.js';

/**
 * What a port on the worker may say, and on whose behalf.
 *
 * Every script of the origin can start the worker and post anything on its port (SECURITY.md). These
 * tests speak for such a script - Mallory - next to well-behaved tabs, and assert on what the tabs
 * still receive.
 */

interface World {
  readonly ports: WorkerPorts<FakeMessagePort>;
  readonly records: LogRecord[];
  readonly time: { now: number };
}

function createWorld(): World {
  const { logger, records } = recordingLogger();
  const time = { now: 0 };
  const ports = new WorkerPorts<FakeMessagePort>({ logger, monotonicNow: () => time.now });
  return { ports, records, time };
}

/** A new port, not yet having said anything. */
function connect(): FakeMessagePort {
  return new FakeMessagePort();
}

/** A port that said hello as `id` and attached to Reader; what the worker answered is cleared. */
function join(world: World, id: string, port = connect()): FakeMessagePort {
  world.ports.receive(port, hello(id));
  world.ports.receive(port, envelope(id, 'all', { type: 'attach', configName: 'Reader' }));
  port.posted.length = 0;
  return port;
}

const HEARTBEAT = { type: 'heartbeat', configNames: ['Reader'] };

const probe = (from: string, to = 'all'): unknown =>
  envelope(from, to, { type: 'status-request', configName: 'Reader' });

/**
 * The types of the messages a port was posted, without the worker's forwarded records.
 *
 * Every connected port is posted the worker's own warnings (ADR-0029), which say nothing about the
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
  it('refuses what a port says before it has said hello', () => {
    const world = createWorld();
    const bob = join(world, 'bob');
    const mallory = connect();

    world.ports.receive(
      mallory,
      envelope('mallory', 'all', { type: 'attach', configName: 'Reader' }),
    );
    world.ports.receive(mallory, probe('mallory'));

    // A tab's first message is always hello (ADR-0024); one that is not comes from something else.
    expect(typesPosted(bob)).toEqual([]);
    expect(fieldsOfEvent(world.records, 'broker.connect')).toHaveLength(1);
  });

  it('refuses a message that names another sender than its port said hello as', () => {
    const world = createWorld();
    const alice = join(world, 'alice');
    const bob = join(world, 'bob');
    const mallory = join(world, 'mallory');

    // Without the check one port could speak for every context: here, end Alice's participation.
    world.ports.receive(mallory, envelope('alice', 'all', { type: 'goodbye' }));
    world.ports.receive(
      mallory,
      envelope('alice', 'all', { type: 'detach', configName: 'Reader' }),
    );
    world.ports.receive(bob, probe('bob'));

    expect(typesPosted(alice)).toEqual(['status-request']);
    expect(mallory.closed).toBe(false);
  });

  it('serves a tab that connects again on a new port, on both of its ports', () => {
    const world = createWorld();
    const firstPort = join(world, 'alice');
    const bob = join(world, 'bob');

    // Alice gave up on a worker that hung and connected again under the same identity.
    const secondPort = join(world, 'alice');
    world.ports.receive(bob, probe('bob'));

    expect(typesPosted(secondPort)).toEqual(['status-request']);
    expect(typesPosted(firstPort)).toEqual(['status-request']);
  });

  it('ends only the port that said goodbye, not the identity the tab still has ports for', () => {
    const world = createWorld();
    const firstPort = join(world, 'alice');
    const bob = join(world, 'bob');
    const secondPort = join(world, 'alice');

    world.ports.receive(secondPort, envelope('alice', 'all', { type: 'goodbye' }));
    world.ports.receive(bob, probe('bob'));

    expect(secondPort.closed).toBe(true);
    expect(typesPosted(firstPort)).toEqual(['status-request']);
    expect(fieldsOfEvent(world.records, 'broker.disconnect')).toEqual([]);
  });

  it('forgets a participant whose last port said goodbye', () => {
    const world = createWorld();
    const alice = join(world, 'alice');
    const bob = join(world, 'bob');

    world.ports.receive(alice, envelope('alice', 'all', { type: 'goodbye' }));
    world.ports.receive(bob, probe('bob'));

    expect(typesPosted(alice)).toEqual([]);
    expect(fieldsOfEvent(world.records, 'broker.disconnect')).toEqual([
      expect.objectContaining({ clientId: 'alice' }),
    ]);
  });

  it('sends the records it writes at warn to every connected port, as it wrote them', () => {
    const world = createWorld();
    const alice = join(world, 'alice');
    const bob = join(world, 'bob');
    const mallory = connect();

    world.ports.receive(mallory, probe('mallory'));

    // A worker has no logger of its own: what it records is seen only where a tab writes it
    // (ADR-0029). A port that has said nothing the worker accepted is no participant and gets none.
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

  it('answers a hello on the port it came on, not on the other ports of that identity', () => {
    const world = createWorld();
    const alice = join(world, 'alice');
    const mallory = connect();

    world.ports.receive(mallory, hello('alice'));

    expect(typesPosted(mallory)).toEqual(['welcome']);
    expect(typesPosted(alice)).toEqual([]);
  });

  it("refuses a hello that names the broker's own identity", () => {
    const world = createWorld();
    const bob = join(world, 'bob');
    const mallory = connect();

    world.ports.receive(mallory, hello(BROKER_ID));
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
        envelope('mallory', 'all', { type: 'status-request', configName: 'R'.repeat(129) }),
      );
    }
    world.ports.receive(mallory, probe('mallory'));

    expect(typesPosted(bob)).toEqual(['status-request']);
    expect(fieldsOfEvent(world.records, 'worker.limit-exceeded')).toEqual([
      expect.objectContaining({ limit: 'MAX_CONFIG_NAME_LENGTH', clientId: 'mallory' }),
    ]);
  });

  it('keeps no more than MAX_PARTICIPANTS participants, and admits another once one leaves', () => {
    const world = createWorld();
    const participants = Array.from({ length: MAX_PARTICIPANTS }, (_, index) =>
      join(world, `tab-${String(index)}`),
    );
    const late = connect();

    world.ports.receive(late, hello('late'));
    expect(typesPosted(late)).toEqual([]);
    expect(fieldsOfEvent(world.records, 'worker.limit-exceeded')).toEqual([
      expect.objectContaining({ limit: 'MAX_PARTICIPANTS' }),
    ]);

    // Its port keeps its identity, so its next heartbeat gets in once there is room.
    world.ports.receive(
      participants[0] as FakeMessagePort,
      envelope('tab-0', 'all', { type: 'goodbye' }),
    );
    world.ports.receive(late, envelope('late', 'all', { type: 'heartbeat', configNames: [] }));
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

  it('forgets a silent port of a tab that is still heard from on another', () => {
    const world = createWorld();
    const oldPort = join(world, 'alice');
    const bob = join(world, 'bob');
    world.time.now = SILENT_PARTICIPANT_TIMEOUT_MS / 2;
    const newPort = join(world, 'alice');
    world.ports.receive(bob, probe('bob'));
    expect(typesPosted(oldPort)).toEqual(['status-request']);
    oldPort.posted.length = 0;
    newPort.posted.length = 0;

    world.time.now = SILENT_PARTICIPANT_TIMEOUT_MS;
    world.ports.receive(bob, envelope('bob', 'all', HEARTBEAT));
    world.ports.sweep();
    world.ports.receive(bob, probe('bob'));

    expect(oldPort.posted).toHaveLength(0);
    expect(typesPosted(newPort)).toEqual(['status-request']);
    expect(fieldsOfEvent(world.records, 'broker.forgot-silent')).toEqual([]);
  });

  it('forgets a participant all of whose ports fell silent, and knows it again from its next message', () => {
    const world = createWorld();
    const alice = join(world, 'alice');
    const bob = join(world, 'bob');

    world.time.now = SILENT_PARTICIPANT_TIMEOUT_MS;
    world.ports.receive(bob, envelope('bob', 'all', HEARTBEAT));
    world.ports.sweep();
    world.ports.receive(bob, probe('bob'));
    expect(typesPosted(alice)).toEqual([]);
    expect(fieldsOfEvent(world.records, 'broker.forgot-silent')).toEqual([
      expect.objectContaining({ clientId: 'alice' }),
    ]);

    // Only throttled: the port still speaks as Alice, without a new hello.
    world.ports.receive(alice, envelope('alice', 'all', HEARTBEAT));
    world.ports.receive(bob, probe('bob'));
    expect(typesPosted(alice)).toEqual(['welcome', 'status-request']);
  });

  it('does not echo a sender of any length back in its welcome to another protocol version', () => {
    const world = createWorld();
    const mallory = connect();

    world.ports.receive(mallory, {
      v: 1,
      from: 'm'.repeat(MAX_IDENTIFIER_LENGTH + 1),
      to: 'all',
      type: 'hello',
    });

    expect(typesPosted(mallory)).toEqual([]);
  });
});
