import { describe, expect, it } from 'vitest';

import { ScopedLogger } from '../../src/core/logger.js';
import { SILENT_PARTICIPANT_TIMEOUT_MS } from '../../src/protocol/heartbeat.js';
import {
  MAX_IDENTIFIER_LENGTH,
  MAX_PARTICIPANTS,
  MAX_PORTS_PER_PARTICIPANT,
} from '../../src/protocol/limits.js';
import { BROKER_ID } from '../../src/protocol/messages.js';
import { WorkerPorts } from '../../src/worker/worker-ports.js';
import { fieldsOfEvent, recordingLogger, type LogRecord } from '../harness/recording-logger.js';
import { envelope, FakeMessagePort } from '../harness/transport-doubles.js';

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

/** A port that said hello as `id` and attached to Reader; what the worker answered is cleared. */
function join(world: World, id: string, port = connect()): FakeMessagePort {
  world.ports.receive(port, envelope(id, 'all', { type: 'hello' }));
  world.ports.receive(port, envelope(id, 'all', { type: 'attach', configName: 'Reader' }));
  port.posted.length = 0;
  return port;
}

const probe = (from: string, to = 'all'): unknown =>
  envelope(from, to, { type: 'status-request', configName: 'Reader' });

const typesPosted = (port: FakeMessagePort): unknown[] =>
  port.posted.map((message) => (message as { type: unknown }).type);

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
    expect(bob.posted).toHaveLength(0);
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

  it('does not let a later port that says hello as a tab take the messages addressed to it', () => {
    const world = createWorld();
    const alice = join(world, 'alice');
    world.ports.receive(
      alice,
      envelope('alice', 'all', {
        type: 'owner-claimed',
        configName: 'Reader',
        term: 't-1',
        maxTabs: 1,
      }),
    );
    const bob = join(world, 'bob');

    // Identities are no secret: Mallory heard Alice's on the bus, and says hello as her.
    const mallory = join(world, 'alice');
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

    // The tab holding the port still gets the write; a copy to Mallory is what cannot be prevented.
    expect(typesPosted(alice)).toEqual(['write-request']);
    expect(typesPosted(mallory)).toEqual(['write-request']);
  });

  it('ends only the port that said goodbye, not the tab whose identity it said hello as', () => {
    const world = createWorld();
    const alice = join(world, 'alice');
    const bob = join(world, 'bob');
    const mallory = join(world, 'alice');

    world.ports.receive(mallory, envelope('alice', 'all', { type: 'goodbye' }));
    world.ports.receive(bob, probe('bob'));

    expect(mallory.closed).toBe(true);
    expect(typesPosted(alice)).toEqual(['status-request']);
    expect(world.ports.clientCount).toBe(2);
  });

  it('answers a hello on the port it came on, not on the other ports of that identity', () => {
    const world = createWorld();
    const alice = join(world, 'alice');
    const mallory = connect();

    world.ports.receive(mallory, envelope('alice', 'all', { type: 'hello' }));

    expect(typesPosted(mallory)).toEqual(['welcome']);
    expect(alice.posted).toHaveLength(0);
  });

  it("refuses a hello that names the broker's own identity", () => {
    const world = createWorld();
    const bob = join(world, 'bob');
    const mallory = connect();

    world.ports.receive(mallory, envelope(BROKER_ID, 'all', { type: 'hello' }));
    world.ports.receive(mallory, probe(BROKER_ID));

    expect(mallory.posted).toHaveLength(0);
    expect(bob.posted).toHaveLength(0);
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

    world.ports.receive(late, envelope('late', 'all', { type: 'hello' }));
    expect(late.posted).toHaveLength(0);
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

    world.ports.receive(oneTooMany, envelope('alice', 'all', { type: 'hello' }));
    world.ports.receive(join(world, 'bob'), probe('bob'));

    expect(oneTooMany.posted).toHaveLength(0);
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
    world.ports.receive(
      bob,
      envelope('bob', 'all', { type: 'heartbeat', configNames: ['Reader'], ownedConfigNames: [] }),
    );
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

    expect(mallory.posted).toHaveLength(0);
  });
});
