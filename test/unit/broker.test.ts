import { describe, expect, it } from 'vitest';

import { NOOP_LOGGER, ScopedLogger } from '../../src/core/logger.js';
import type { ClientId, ProtocolMessage } from '../../src/protocol/messages.js';
import { PROTOCOL_VERSION } from '../../src/protocol/version.js';
import { Broker } from '../../src/worker/broker.js';

const ALICE = 'alice' as ClientId;
const BOB = 'bob' as ClientId;
const CAROL = 'carol' as ClientId;

interface Delivery {
  readonly to: ClientId;
  readonly message: ProtocolMessage;
}

function createBroker(clients: readonly ClientId[] = [ALICE, BOB, CAROL]): {
  broker: Broker;
  delivered: Delivery[];
} {
  const delivered: Delivery[] = [];
  const broker = new Broker({
    deliver: (to, message) => delivered.push({ to, message }),
    clients: () => clients,
    logger: new ScopedLogger(NOOP_LOGGER, {}),
  });
  return { broker, delivered };
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

/** A routable message with no side effects, used to observe where the broker sends things. */
const probe = (from: ClientId, to: ProtocolMessage['to'], configName = 'Reader'): ProtocolMessage =>
  message(from, to, { type: 'status-request', configName } as never);

/**
 * The broker in isolation.
 *
 * It resolves two delivery targets and forgets contexts that go away. That is deliberately all it
 * does - everything requiring judgement lives in the participants (ADR-0006, ADR-0040) - so these
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

    broker.handleMessage(ALICE, probe(ALICE, 'all'));

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

  it('believes no claim of ownership: a write request goes to every participant', () => {
    const { broker, delivered } = createBroker();
    broker.handleMessage(ALICE, attach(ALICE));
    broker.handleMessage(BOB, attach(BOB));
    broker.handleMessage(CAROL, attach(CAROL));
    broker.handleMessage(
      CAROL,
      message(CAROL, 'all', { type: 'owner-claimed', configName: 'Reader' } as never),
    );
    delivered.length = 0;

    broker.handleMessage(
      BOB,
      message(BOB, 'all', { type: 'write-request', configName: 'Reader', term: 't-1' } as never),
    );

    // Only the tab holding the addressed term acts on it (ADR-0040); a forged claim diverts nothing.
    expect(delivered.map((entry) => entry.to)).toEqual([ALICE, CAROL]);
  });

  it('forgets a disconnected participant', () => {
    const { broker, delivered } = createBroker();
    broker.handleMessage(ALICE, attach(ALICE));
    broker.handleMessage(BOB, attach(BOB));

    broker.handleDisconnect(BOB);
    broker.handleMessage(ALICE, probe(ALICE, 'all'));

    expect(delivered).toHaveLength(0);
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

  it('ignores detaching from a configuration, or a disconnect, it knows nothing about', () => {
    const { broker } = createBroker();

    expect(() => {
      broker.handleMessage(
        ALICE,
        message(ALICE, 'all', { type: 'detach', configName: 'Unknown' } as never),
      );
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
  });

  it('delivers a diagnostics request to every connected context but the sender, attached or not', () => {
    const { broker, delivered } = createBroker();
    broker.handleMessage(ALICE, attach(ALICE));

    broker.handleMessage(
      CAROL,
      message(CAROL, 'all', { type: 'diagnostics-request', requestId: 'd1' } as never),
    );

    // The observer asking shares no configuration with anyone and must hear from everyone.
    expect(delivered.map((entry) => entry.to)).toEqual([ALICE, BOB]);
  });

  it.each(['hello', 'welcome', 'goodbye', 'worker-log'] as const)('passes on no %s', (type) => {
    const { broker, delivered } = createBroker();
    broker.handleMessage(BOB, attach(BOB));

    broker.handleMessage(ALICE, message(ALICE, 'all', { type } as never));

    expect(delivered).toHaveLength(0);
  });

  it('restores a participant it forgot from its heartbeat', () => {
    const { broker, delivered } = createBroker();
    broker.handleMessage(ALICE, attach(ALICE));
    broker.handleDisconnect(ALICE);

    // Alice was only throttled; her heartbeat still names what she takes part in.
    broker.handleMessage(
      ALICE,
      message(ALICE, 'all', { type: 'heartbeat', configNames: ['Reader'] } as never),
    );
    broker.handleMessage(BOB, probe(BOB, 'all'));

    expect(delivered.map((entry) => entry.to)).toEqual([ALICE]);
  });
});
