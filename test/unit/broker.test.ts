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

/** A `hello` saying that `from` takes part in exactly `configNames`. */
const hello = (from: ClientId, ...configNames: string[]): ProtocolMessage =>
  message(from, 'all', { type: 'hello', configNames } as never);

/** A routable message with no side effects, used to observe where the broker sends things. */
const probe = (from: ClientId, to: ProtocolMessage['to'], configName = 'Reader'): ProtocolMessage =>
  message(from, to, { type: 'status-request', configName } as never);

/**
 * The broker in isolation.
 *
 * It resolves two delivery targets from what each participant's latest `hello` says. That is
 * deliberately all it does - everything requiring judgement lives in the participants (ADR-0006,
 * ADR-0006) - so these tests are about routing and nothing else.
 */
describe('Broker', () => {
  it('delivers a broadcast to every participant except the sender', () => {
    const { broker, delivered } = createBroker();
    broker.handleMessage(ALICE, hello(ALICE, 'Reader'));
    broker.handleMessage(BOB, hello(BOB, 'Reader'));
    broker.handleMessage(CAROL, hello(CAROL, 'Reader'));

    broker.handleMessage(ALICE, probe(ALICE, 'all'));

    // The sender emits its own events locally; echoing them back would deliver every chunk
    // twice in the owning tab.
    expect(delivered.map((entry) => entry.to)).toEqual([BOB, CAROL]);
  });

  it('does not deliver a broadcast to a context whose hello names no such configuration', () => {
    const { broker, delivered } = createBroker();
    broker.handleMessage(ALICE, hello(ALICE, 'Reader'));
    broker.handleMessage(BOB, hello(BOB));

    broker.handleMessage(ALICE, probe(ALICE, 'all'));

    expect(delivered).toHaveLength(0);
  });

  it('routes a message addressed to one participant', () => {
    const { broker, delivered } = createBroker();
    broker.handleMessage(ALICE, hello(ALICE, 'Reader'));
    broker.handleMessage(BOB, hello(BOB, 'Reader'));

    broker.handleMessage(
      ALICE,
      message(ALICE, BOB, {
        type: 'write-ready',
        configName: 'Reader',
        requestId: 'w1',
      } as never),
    );

    expect(delivered.map((entry) => entry.to)).toEqual([BOB]);
  });

  it('believes no claim of ownership: a write request goes to every participant', () => {
    const { broker, delivered } = createBroker();
    broker.handleMessage(ALICE, hello(ALICE, 'Reader'));
    broker.handleMessage(BOB, hello(BOB, 'Reader'));
    broker.handleMessage(CAROL, hello(CAROL, 'Reader'));
    broker.handleMessage(
      CAROL,
      message(CAROL, 'all', { type: 'owner-claimed', configName: 'Reader' } as never),
    );
    delivered.length = 0;

    broker.handleMessage(
      BOB,
      message(BOB, 'all', { type: 'write-request', configName: 'Reader', term: 't-1' } as never),
    );

    // Only the tab holding the addressed term acts on it (ADR-0006); a forged claim diverts nothing.
    expect(delivered.map((entry) => entry.to)).toEqual([ALICE, CAROL]);
  });

  it('forgets a disconnected participant', () => {
    const { broker, delivered } = createBroker();
    broker.handleMessage(ALICE, hello(ALICE, 'Reader'));
    broker.handleMessage(BOB, hello(BOB, 'Reader'));

    broker.handleDisconnect(BOB);
    broker.handleMessage(ALICE, probe(ALICE, 'all'));

    expect(delivered).toHaveLength(0);
  });

  it('takes a later hello for everything the sender takes part in, dropping what it no longer names', () => {
    const { broker, delivered } = createBroker();
    broker.handleMessage(ALICE, hello(ALICE, 'Reader', 'Scale'));
    broker.handleMessage(BOB, hello(BOB, 'Reader', 'Scale'));

    broker.handleMessage(BOB, hello(BOB, 'Scale'));
    broker.handleMessage(ALICE, probe(ALICE, 'all', 'Reader'));
    broker.handleMessage(ALICE, probe(ALICE, 'all', 'Scale'));

    expect(
      delivered.map((entry) => [entry.to, (entry.message as { configName: string }).configName]),
    ).toEqual([[BOB, 'Scale']]);
  });

  it('keeps configurations apart', () => {
    const { broker, delivered } = createBroker();
    broker.handleMessage(ALICE, hello(ALICE, 'Reader'));
    broker.handleMessage(BOB, hello(BOB, 'Scale'));

    broker.handleMessage(ALICE, probe(ALICE, 'all', 'Reader'));

    expect(delivered).toHaveLength(0);
  });

  it('ignores a disconnect of a participant it knows nothing about', () => {
    const { broker } = createBroker();

    expect(() => {
      broker.handleDisconnect(CAROL);
    }).not.toThrow();
  });

  it('drops everything when disposed', () => {
    const { broker, delivered } = createBroker();
    broker.handleMessage(ALICE, hello(ALICE, 'Reader'));
    broker.handleMessage(BOB, hello(BOB, 'Reader'));

    broker.dispose();
    broker.handleMessage(ALICE, probe(ALICE, 'all'));

    expect(delivered).toHaveLength(0);
  });

  it('delivers a diagnostics request to every connected context but the sender, whatever its hello named', () => {
    const { broker, delivered } = createBroker();
    broker.handleMessage(ALICE, hello(ALICE, 'Reader'));

    broker.handleMessage(
      CAROL,
      message(CAROL, 'all', { type: 'diagnostics-request', requestId: 'd1' } as never),
    );

    // The observer asking shares no configuration with anyone and must hear from everyone.
    expect(delivered.map((entry) => entry.to)).toEqual([ALICE, BOB]);
  });

  it.each([
    ['hello', { configNames: ['Reader'] }],
    ['welcome', { worker: 'w-1' }],
    ['worker-log', {}],
  ] as const)('passes on no %s', (type, body) => {
    const { broker, delivered } = createBroker();
    broker.handleMessage(BOB, hello(BOB, 'Reader'));

    broker.handleMessage(ALICE, message(ALICE, 'all', { type, ...body } as never));

    expect(delivered).toHaveLength(0);
  });
});
