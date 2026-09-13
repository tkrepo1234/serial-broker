import { NOOP_LOGGER, ScopedLogger } from '../core/logger.js';
import { decodeMessage, describeDecodeFailure } from '../protocol/decode.js';
import { SILENT_PARTICIPANT_TIMEOUT_MS, SWEEP_INTERVAL_MS } from '../protocol/heartbeat.js';
import type { ClientId, ProtocolMessage } from '../protocol/messages.js';

import { Broker } from './broker.js';

/**
 * The broker, as a `SharedWorker` script.
 *
 * One instance of this exists per origin, per protocol version, no matter how many tabs are
 * open - that is the entire reason it exists. Every tab connects a `MessagePort` to it, and
 * it routes between them (ADR-0006).
 *
 * It deliberately holds no important state: if the browser were to discard and restart it,
 * participants re-announce themselves with their next message and nothing is lost. The things
 * that must not be lost - which context owns the port, what happens to an in-flight write -
 * are held by the Web Lock and by the context that issued the write (ADR-0005, ADR-0013).
 *
 * This file never imports the Web Serial API. It cannot: `navigator.serial` is not exposed to
 * workers, which is the constraint the whole architecture is built around (ADR-0004).
 */

declare const self: {
  onconnect: ((event: { readonly ports: readonly MessagePort[] }) => void) | null;
};

const logger = new ScopedLogger(NOOP_LOGGER, { event: 'worker' });

/** Maps each connected port to the identity it announced, so disconnects can be attributed. */
const identities = new WeakMap<MessagePort, ClientId>();

const broker = new Broker({
  deliver(clientId, message) {
    const port = ports.get(clientId);
    if (port === undefined) {
      return;
    }
    try {
      port.postMessage(message);
    } catch {
      // A port belonging to a context that has just gone away. The sweep below forgets it;
      // failing the whole delivery loop over it would punish every other tab.
    }
  },
  logger,
  now: () => Date.now(),
});

/** Every live port, by the identity of the context behind it. */
const ports = new Map<ClientId, MessagePort>();

self.onconnect = (event): void => {
  const port = event.ports[0];
  if (port === undefined) {
    return;
  }

  port.addEventListener('message', (messageEvent: MessageEvent<unknown>) => {
    handleMessage(port, messageEvent.data);
  });

  // A `SharedWorker` port does not deliver anything until it is started.
  port.start();
};

function handleMessage(port: MessagePort, raw: unknown): void {
  const result = decodeMessage(raw);

  if (!result.ok) {
    // Nothing can be done about a message this worker cannot parse, and it must not be
    // allowed to take the broker down: dropping it keeps every other tab working.
    logger.warn('dropped a message', { reason: describeDecodeFailure(result.failure) });
    return;
  }

  const message: ProtocolMessage = result.message;
  register(port, message.from);

  if (message.type === 'goodbye') {
    disconnect(port, message.from);
    return;
  }

  broker.handleMessage(message.from, message);
}

function register(port: MessagePort, clientId: ClientId): void {
  if (identities.get(port) === clientId) {
    return;
  }

  identities.set(port, clientId);
  ports.set(clientId, port);
  broker.handleConnect(clientId);

  // There is no port-close event. A context that leaves politely says goodbye; one that dies
  // stops sending heartbeats, and the sweep forgets it (ADR-0021). `messageerror` covers the
  // case where a context sends something uncloneable and is likely to be in trouble.
  port.addEventListener('messageerror', () => {
    disconnect(port, clientId);
  });
}

function disconnect(port: MessagePort, clientId: ClientId): void {
  identities.delete(port);
  ports.delete(clientId);
  broker.handleDisconnect(clientId);

  try {
    port.close();
  } catch {
    // Closing an already-closed port throws in some engines and means nothing here.
  }
}

// A port reports nothing when the tab behind it dies, so participants that stay silent past the
// timeout are forgotten here (ADR-0021). Their port is dropped from the tables, never closed: a tab
// that was only throttled keeps its connection, and its next message registers it again.
setInterval(() => {
  for (const clientId of broker.forgetSilent(SILENT_PARTICIPANT_TIMEOUT_MS)) {
    const port = ports.get(clientId);
    ports.delete(clientId);
    if (port !== undefined) {
      identities.delete(port);
    }
  }
}, SWEEP_INTERVAL_MS);
