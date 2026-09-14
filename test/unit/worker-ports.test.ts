import { describe, expect, it } from 'vitest';

import { ScopedLogger } from '../../src/core/logger.js';
import { decodeMessage } from '../../src/protocol/decode.js';
import { SILENT_PARTICIPANT_TIMEOUT_MS } from '../../src/protocol/heartbeat.js';
import {
  MAX_BOUND_IDENTITIES,
  MAX_IDENTIFIER_LENGTH,
  MAX_LOG_RECORD_CHARACTERS,
  MAX_PARTICIPANTS,
  MAX_PORTS_PER_PARTICIPANT,
} from '../../src/protocol/limits.js';
import { BROKER_ID } from '../../src/protocol/messages.js';
import { PROTOCOL_VERSION } from '../../src/protocol/version.js';
import {
  FORWARD_INTERVAL_MS,
  MAX_FORWARDED_RECORDS,
  RecordForwarder,
} from '../../src/worker/record-forwarding.js';
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
  const ports = new WorkerPorts<FakeMessagePort>({
    logger: new ScopedLogger(logger, {}),
    now: () => time.now,
  });
  return { ports, records, time };
}

/** A new port, not yet having said anything. */
function connect(): FakeMessagePort {
  return new FakeMessagePort();
}

/**
 * A port that said hello as `id` and attached to Reader; what the worker answered is cleared.
 *
 * The secret is the one {@link hello} derives from the identity, so every port of one identity is
 * that context connecting again - unless the test passes a secret of its own (ADR-0028).
 */
function join(world: World, id: string, port = connect(), secret?: string): FakeMessagePort {
  world.ports.receive(port, hello(id, secret));
  world.ports.receive(port, envelope(id, 'all', { type: 'attach', configName: 'Reader' }));
  port.posted.length = 0;
  return port;
}

const HEARTBEAT = { type: 'heartbeat', configNames: ['Reader'], ownedConfigNames: [] };

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
    expect(world.ports.clientCount).toBe(1);
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

  it('does not let a port that says hello as a tab with another secret hear what is addressed to it', () => {
    const world = createWorld();
    const alice = join(world, 'alice');
    world.ports.receive(
      alice,
      envelope('alice', 'all', { type: 'owner-claimed', configName: 'Reader', term: 't-1' }),
    );
    const bob = join(world, 'bob');

    // Identities are no secret: Mallory heard Alice's on the bus, and says hello as her. The secret
    // Alice bound her identity to is one thing Mallory never heard (ADR-0028).
    const mallory = join(world, 'alice', connect(), 'guessed');
    world.ports.receive(
      bob,
      envelope('bob', 'owner', {
        type: 'write-request',
        configName: 'Reader',
        requestId: 'w-1',
        payload: new Uint8Array([1]),
        term: 't-1',
      }),
    );

    expect(typesPosted(alice)).toEqual(['write-request']);
    expect(typesPosted(mallory)).toEqual([]);
  });

  it('serves a tab that connects again on a new port with the secret it bound', () => {
    const world = createWorld();
    const firstPort = join(world, 'alice');
    const bob = join(world, 'bob');

    // Alice gave up on a worker that hung and connected again; her transport shows the same secret.
    const secondPort = join(world, 'alice');
    world.ports.receive(bob, probe('bob'));

    expect(typesPosted(secondPort)).toEqual(['status-request']);
    expect(typesPosted(firstPort)).toEqual(['status-request']);
    expect(world.ports.clientCount).toBe(2);
  });

  it('logs a refused hello once per reason, naming the identity it claimed', () => {
    const world = createWorld();
    join(world, 'alice');

    for (let round = 0; round < 10; round += 1) {
      world.ports.receive(connect(), hello('alice', 'guessed'));
      world.ports.receive(connect(), envelope('alice', 'all', { type: 'hello' }));
    }

    expect(fieldsOfEvent(world.records, 'worker.message-refused')).toEqual([
      expect.objectContaining({ reason: 'secret-mismatch', claimedClientId: 'alice' }),
      expect.objectContaining({ reason: 'secret-missing', claimedClientId: 'alice' }),
    ]);
  });

  it('keeps an identity bound while the sweep has forgotten the tab holding it', () => {
    const world = createWorld();
    const alice = join(world, 'alice');
    const bob = join(world, 'bob');

    // Alice's tab was frozen long enough for the sweep to forget it.
    world.time.now = SILENT_PARTICIPANT_TIMEOUT_MS;
    world.ports.receive(bob, envelope('bob', 'all', HEARTBEAT));
    world.ports.sweep();
    expect(world.ports.clientCount).toBe(1);

    const mallory = join(world, 'alice', connect(), 'guessed');
    const returned = join(world, 'alice');
    world.ports.receive(bob, probe('bob'));

    expect(typesPosted(mallory)).toEqual([]);
    expect(typesPosted(returned)).toEqual(['status-request']);
    expect(alice.closed).toBe(false);
  });

  it('lets an identity be bound again once the context that bound it said goodbye', () => {
    const world = createWorld();
    const alice = join(world, 'alice');

    world.ports.receive(alice, envelope('alice', 'all', { type: 'goodbye' }));
    const sameIdentity = connect();
    world.ports.receive(sameIdentity, hello('alice', 'another-secret'));

    // Nothing is kept against a context that left: its identity is generated once per context, and
    // a binding kept for every context that ever connected would grow the worker without bound.
    expect(typesPosted(sameIdentity)).toEqual(['welcome']);
    expect(world.ports.clientCount).toBe(1);
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
    expect(world.ports.clientCount).toBe(2);
  });

  it('forgets the oldest binding of an identity with no port, and keeps the ones in use', () => {
    const world = createWorld();
    const alice = join(world, 'alice');

    // A script of the origin says hello under one identity after another and lets each fall silent.
    // The participants are forgotten by the sweep; their bindings outlive them, so they are what
    // reaches the limit (ADR-0028).
    for (let index = 0; index < MAX_BOUND_IDENTITIES; index += 1) {
      world.ports.receive(connect(), hello(`flood-${String(index)}`));
      if ((index + 1) % (MAX_PARTICIPANTS / 2) === 0) {
        world.time.now += SILENT_PARTICIPANT_TIMEOUT_MS;
        world.ports.receive(alice, envelope('alice', 'all', HEARTBEAT));
        world.ports.sweep();
      }
    }

    const claimedAgain = connect();
    world.ports.receive(claimedAgain, hello('flood-0', 'another-secret'));
    const asAlice = connect();
    world.ports.receive(asAlice, hello('alice', 'another-secret'));

    // The oldest binding nothing holds any more is let go of, and that identity can be claimed
    // again. Alice's is kept: her tab is still there.
    expect(typesPosted(claimedAgain)).toEqual(['welcome']);
    expect(typesPosted(asAlice)).toEqual([]);
    expect(fieldsOfEvent(world.records, 'worker.limit-exceeded')).toEqual([
      expect.objectContaining({ limit: 'MAX_BOUND_IDENTITIES', limitValue: MAX_BOUND_IDENTITIES }),
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

  it('forwards no more records in one interval than the budget, and reports what it dropped', () => {
    const world = createWorld();
    const alice = join(world, 'alice');

    for (let index = 0; index < MAX_FORWARDED_RECORDS + 5; index += 1) {
      // Each hello in a version of its own is a record the worker writes: nothing bounds how many
      // of them a script of the origin can cause (SECURITY.md).
      world.ports.receive(connect(), { v: 100 + index, from: 'mallory', to: 'all', type: 'hello' });
    }
    const withinTheInterval = recordsPosted(alice).length;
    world.time.now = FORWARD_INTERVAL_MS;
    world.ports.sweep();

    expect(withinTheInterval).toBe(MAX_FORWARDED_RECORDS);
    // The count is reported once the interval is over, so nothing is dropped in silence - here at
    // the sweep, since no further record came.
    expect(recordsPosted(alice).at(-1)).toEqual(
      expect.objectContaining({
        level: 'warn',
        fields: expect.objectContaining({
          event: 'worker.records-dropped',
          droppedRecords: 5,
        }) as unknown,
      }),
    );
  });

  it('holds a record it forwards to one budget, so that no tab refuses it', () => {
    const forwarded: unknown[] = [];
    const forwarder = new RecordForwarder({
      now: () => 0,
      forward: (level, message, fields) => {
        forwarded.push({
          v: PROTOCOL_VERSION,
          from: BROKER_ID,
          to: 'alice',
          type: 'worker-log',
          level,
          message,
          fields,
        });
      },
      reportDropped: () => undefined,
    });

    // Nothing the worker writes is this long, but a record over the budget must not become a record
    // no tab accepts: the message and the fields share the budget on both sides of the bus.
    forwarder
      .wrap({ log: () => undefined })
      .log('warn', 'm'.repeat(MAX_LOG_RECORD_CHARACTERS + 1), { event: 'worker.message-refused' });

    expect(forwarded).toHaveLength(1);
    expect(decodeMessage(forwarded[0]).ok).toBe(true);
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
      expect.objectContaining({ limit: 'MAX_PARTICIPANTS', limitValue: MAX_PARTICIPANTS }),
    ]);

    // Its port keeps its identity, so its next heartbeat gets in once there is room.
    world.ports.receive(
      participants[0] as FakeMessagePort,
      envelope('tab-0', 'all', { type: 'goodbye' }),
    );
    world.ports.receive(
      late,
      envelope('late', 'all', { type: 'heartbeat', configNames: [], ownedConfigNames: [] }),
    );
    expect(typesPosted(late)).toEqual(['welcome']);
    expect(world.ports.clientCount).toBe(MAX_PARTICIPANTS);
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
    expect(world.ports.clientCount).toBe(2);
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
