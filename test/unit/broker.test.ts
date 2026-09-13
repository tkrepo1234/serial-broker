import { describe, expect, it } from 'vitest';

import { NOOP_LOGGER, ScopedLogger } from '../../src/core/logger.js';
import { BROKER_ID, type ClientId, type ProtocolMessage } from '../../src/protocol/messages.js';
import { PROTOCOL_VERSION } from '../../src/protocol/version.js';
import { Broker } from '../../src/worker/broker.js';

const ALICE = 'alice' as ClientId;
const BOB = 'bob' as ClientId;
const CAROL = 'carol' as ClientId;

interface Delivery {
  readonly to: ClientId;
  readonly message: ProtocolMessage;
}

function createBroker(): { broker: Broker; delivered: Delivery[]; time: { now: number } } {
  const delivered: Delivery[] = [];
  const time = { now: 0 };
  const broker = new Broker({
    deliver: (to, message) => delivered.push({ to, message }),
    logger: new ScopedLogger(NOOP_LOGGER, {}),
    now: () => time.now,
  });
  return { broker, delivered, time };
}

function message(
  from: ClientId,
  to: ProtocolMessage['to'],
  partial: Partial<ProtocolMessage> & { type: ProtocolMessage['type'] },
): ProtocolMessage {
  return { v: PROTOCOL_VERSION, from, to, ...partial } as ProtocolMessage;
}

const attach = (from: ClientId, configName = 'Reader'): ProtocolMessage =>
  message(from, 'all', { type: 'attach', configName } as never);

const claim = (from: ClientId, configName = 'Reader'): ProtocolMessage =>
  message(from, 'all', { type: 'owner-claimed', configName } as never);

/** A routable message with no side effects, used to observe where the broker sends things. */
const probe = (from: ClientId, to: ProtocolMessage['to'], configName = 'Reader'): ProtocolMessage =>
  message(from, to, { type: 'status-request', configName } as never);

const heartbeat = (
  from: ClientId,
  configNames: readonly string[],
  ownedConfigNames: readonly string[],
): ProtocolMessage =>
  message(from, 'all', { type: 'heartbeat', configNames, ownedConfigNames } as never);

/**
 * The broker in isolation.
 *
 * It resolves three delivery targets and forgets contexts that go away. That is deliberately
 * all it does - everything requiring judgement lives in the participants (ADR-0006) - so these
 * tests are about routing and nothing else.
 */
describe('Broker', () => {
  it('delivers a broadcast to every participant except the sender', () => {
    const { broker, delivered } = createBroker();
    broker.handleMessage(ALICE, attach(ALICE));
    broker.handleMessage(BOB, attach(BOB));
    broker.handleMessage(CAROL, attach(CAROL));

    broker.handleMessage(ALICE, probe(ALICE, 'all'));

    // The sender emits its own events locally; echoing them back would deliver every chunk
    // twice in the owning tab.
    expect(delivered.map((entry) => entry.to)).toEqual([BOB, CAROL]);
  });

  it('does not deliver a broadcast to a context that never attached', () => {
    const { broker, delivered } = createBroker();
    broker.handleMessage(ALICE, attach(ALICE));
    broker.handleConnect(BOB);

    broker.handleMessage(ALICE, probe(ALICE, 'all'));

    expect(delivered).toHaveLength(0);
  });

  it('routes a message addressed to the owner', () => {
    const { broker, delivered } = createBroker();
    broker.handleMessage(ALICE, attach(ALICE));
    broker.handleMessage(BOB, attach(BOB));
    broker.handleMessage(ALICE, claim(ALICE));
    delivered.length = 0;

    broker.handleMessage(BOB, probe(BOB, 'owner'));

    expect(delivered.map((entry) => entry.to)).toEqual([ALICE]);
  });

  it('drops a message addressed to an owner that does not exist', () => {
    const { broker, delivered } = createBroker();
    broker.handleMessage(ALICE, attach(ALICE));

    broker.handleMessage(ALICE, probe(ALICE, 'owner'));

    // Nothing to do but drop it. The sender learns of the new owner through `owner-claimed`
    // and re-sends; inventing an owner here would be worse than silence.
    expect(delivered).toHaveLength(0);
  });

  it('routes a message addressed to one participant', () => {
    const { broker, delivered } = createBroker();
    broker.handleMessage(ALICE, attach(ALICE));
    broker.handleMessage(BOB, attach(BOB));

    broker.handleMessage(
      ALICE,
      message(ALICE, BOB, {
        type: 'write-started',
        configName: 'Reader',
        requestId: 'w1',
      } as never),
    );

    expect(delivered.map((entry) => entry.to)).toEqual([BOB]);
  });

  it('moves ownership to whichever context claimed it last', () => {
    const { broker, delivered } = createBroker();
    broker.handleMessage(ALICE, attach(ALICE));
    broker.handleMessage(BOB, attach(BOB));
    broker.handleMessage(ALICE, claim(ALICE));
    broker.handleMessage(BOB, claim(BOB));
    delivered.length = 0;

    broker.handleMessage(ALICE, probe(ALICE, 'owner'));

    expect(delivered.map((entry) => entry.to)).toEqual([BOB]);
  });

  it('ignores a release from a context that is no longer the owner', () => {
    const { broker, delivered } = createBroker();
    broker.handleMessage(ALICE, attach(ALICE));
    broker.handleMessage(BOB, attach(BOB));
    broker.handleMessage(ALICE, claim(ALICE));
    broker.handleMessage(BOB, claim(BOB));

    // A late `owner-released` from the previous owner must not clear the current one.
    broker.handleMessage(
      ALICE,
      message(ALICE, 'all', { type: 'owner-released', configName: 'Reader' } as never),
    );
    delivered.length = 0;
    broker.handleMessage(ALICE, probe(ALICE, 'owner'));

    expect(delivered.map((entry) => entry.to)).toEqual([BOB]);
  });

  it('forgets a disconnected participant', () => {
    const { broker, delivered } = createBroker();
    broker.handleMessage(ALICE, attach(ALICE));
    broker.handleMessage(BOB, attach(BOB));

    broker.handleDisconnect(BOB);
    broker.handleMessage(ALICE, probe(ALICE, 'all'));

    expect(delivered).toHaveLength(0);
    expect(broker.clientCount).toBe(1);
  });

  it('clears ownership when the owner disconnects', () => {
    const { broker, delivered } = createBroker();
    broker.handleMessage(ALICE, attach(ALICE));
    broker.handleMessage(BOB, attach(BOB));
    broker.handleMessage(ALICE, claim(ALICE));
    delivered.length = 0;

    broker.handleDisconnect(ALICE);
    broker.handleMessage(BOB, probe(BOB, 'owner'));

    expect(delivered).toHaveLength(0);
  });

  it('treats goodbye as a disconnect', () => {
    const { broker } = createBroker();
    broker.handleMessage(ALICE, attach(ALICE));

    broker.handleMessage(ALICE, message(ALICE, 'all', { type: 'goodbye' } as never));

    expect(broker.clientCount).toBe(0);
  });

  it('stops routing to a context that detached', () => {
    const { broker, delivered } = createBroker();
    broker.handleMessage(ALICE, attach(ALICE));
    broker.handleMessage(BOB, attach(BOB));

    broker.handleMessage(
      BOB,
      message(BOB, 'all', { type: 'detach', configName: 'Reader' } as never),
    );
    broker.handleMessage(ALICE, probe(ALICE, 'all'));

    expect(delivered).toHaveLength(0);
  });

  it('keeps configurations apart', () => {
    const { broker, delivered } = createBroker();
    broker.handleMessage(ALICE, attach(ALICE, 'Reader'));
    broker.handleMessage(BOB, attach(BOB, 'Scale'));

    broker.handleMessage(ALICE, probe(ALICE, 'all', 'Reader'));

    expect(delivered).toHaveLength(0);
  });

  it('ignores detaching from a configuration it knows nothing about', () => {
    const { broker } = createBroker();

    expect(() => {
      broker.handleMessage(
        ALICE,
        message(ALICE, 'all', { type: 'detach', configName: 'Unknown' } as never),
      );
    }).not.toThrow();
  });

  it('ignores a disconnect for a context it never saw', () => {
    const { broker } = createBroker();

    expect(() => {
      broker.handleDisconnect(CAROL);
    }).not.toThrow();
  });

  it('drops everything when disposed', () => {
    const { broker, delivered } = createBroker();
    broker.handleMessage(ALICE, attach(ALICE));
    broker.handleMessage(BOB, attach(BOB));

    broker.dispose();
    broker.handleMessage(ALICE, probe(ALICE, 'all'));

    expect(delivered).toHaveLength(0);
    expect(broker.clientCount).toBe(1);
  });

  it('delivers a diagnostics request to every connected context but the sender, attached or not', () => {
    const { broker, delivered } = createBroker();
    broker.handleMessage(ALICE, attach(ALICE));
    broker.handleConnect(BOB);
    broker.handleMessage(CAROL, message(CAROL, 'all', { type: 'hello' } as never));
    delivered.length = 0;

    broker.handleMessage(
      CAROL,
      message(CAROL, 'all', { type: 'diagnostics-request', requestId: 'd1' } as never),
    );

    // The observer asking shares no configuration with anyone and must hear from everyone.
    expect(delivered.map((entry) => entry.to)).toEqual([ALICE, BOB]);
  });

  it('answers hello with a welcome to that context alone, which proves the script runs', () => {
    const { broker, delivered } = createBroker();
    broker.handleMessage(BOB, attach(BOB));
    delivered.length = 0;

    broker.handleMessage(ALICE, message(ALICE, 'all', { type: 'hello' } as never));

    expect(delivered).toEqual([
      { to: ALICE, message: { type: 'welcome', v: PROTOCOL_VERSION, from: BROKER_ID, to: ALICE } },
    ]);
    expect(broker.clientCount).toBe(2);
  });

  it('ignores a welcome, which only the broker itself sends', () => {
    const { broker, delivered } = createBroker();
    broker.handleMessage(BOB, attach(BOB));

    broker.handleMessage(ALICE, message(ALICE, 'all', { type: 'welcome' } as never));

    expect(delivered).toHaveLength(0);
  });

  it('forgets a participant that has sent nothing for the timeout, its ownership included', () => {
    const { broker, delivered, time } = createBroker();
    broker.handleMessage(ALICE, attach(ALICE));
    broker.handleMessage(ALICE, claim(ALICE));
    broker.handleMessage(BOB, attach(BOB));

    time.now += 60_000;
    broker.handleMessage(BOB, heartbeat(BOB, ['Reader'], []));
    time.now += 60_000;

    expect(broker.forgetSilent(100_000)).toEqual([ALICE]);
    delivered.length = 0;
    broker.handleMessage(BOB, probe(BOB, 'owner'));
    broker.handleMessage(BOB, probe(BOB, 'all'));

    expect(delivered).toEqual([]);
    expect(broker.clientCount).toBe(1);
  });

  it('restores a forgotten participant from its heartbeat, without taking over a claimed port', () => {
    const { broker, delivered, time } = createBroker();
    broker.handleMessage(ALICE, claim(ALICE));
    time.now += 200_000;
    broker.forgetSilent(180_000);
    broker.handleMessage(BOB, claim(BOB));

    // Alice was only throttled; her heartbeat still says she owns the port.
    broker.handleMessage(ALICE, heartbeat(ALICE, ['Reader'], ['Reader']));
    broker.handleMessage(CAROL, attach(CAROL));
    delivered.length = 0;
    broker.handleMessage(CAROL, probe(CAROL, 'owner'));
    broker.handleMessage(CAROL, probe(CAROL, 'all'));

    expect(delivered.map((entry) => entry.to)).toEqual([BOB, BOB, ALICE]);
  });

  it('answers a heartbeat with a welcome to its sender, so the tab knows the broker still runs', () => {
    const { broker, delivered } = createBroker();
    broker.handleMessage(BOB, attach(BOB));

    broker.handleMessage(ALICE, heartbeat(ALICE, ['Reader'], []));

    // Without an answer a tab could not tell a worker that died from one with nothing to route.
    expect(delivered).toEqual([
      {
        to: ALICE,
        message: expect.objectContaining({
          type: 'welcome',
          from: BROKER_ID,
          to: ALICE,
        }) as unknown,
      },
    ]);
  });

  it('fills in an owner it does not know from a heartbeat', () => {
    const { broker, delivered } = createBroker();
    broker.handleMessage(ALICE, heartbeat(ALICE, ['Reader'], ['Reader']));
    broker.handleMessage(BOB, attach(BOB));
    delivered.length = 0;

    broker.handleMessage(BOB, probe(BOB, 'owner'));

    expect(delivered.map((entry) => entry.to)).toEqual([ALICE]);
  });
});
