import { NOOP_LOGGER, ScopedLogger } from '../core/logger.js';
import { decodeMessage, describeDecodeFailure } from '../protocol/decode.js';
import { helloSenderOf, welcomeFor } from '../protocol/handshake.js';
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
 * It deliberately holds no important state. If the worker dies - it crashed, the browser ended it,
 * or someone terminated it - no tab is told: their ports simply go quiet. The broker answers every
 * heartbeat, so each tab notices within a few heartbeats, starts a new worker, and restores its
 * part there with a heartbeat (ADR-0021). What is lost is the traffic in between. The things that
 * must not be lost - which context owns the port, what happens to an in-flight write - are held by
 * the Web Lock and by the context that issued the write (ADR-0005, ADR-0013).
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

/** When each port connected, as a count of connections: a later port has a higher number. */
const connectionOrder = new WeakMap<MessagePort, number>();
let connectionCount = 0;

self.onconnect = (event): void => {
  const port = event.ports[0];
  if (port === undefined) {
    return;
  }
  connectionCount += 1;
  connectionOrder.set(port, connectionCount);

  port.addEventListener('message', (messageEvent: MessageEvent<unknown>) => {
    handleMessage(port, messageEvent.data);
  });

  // One message that could not be cloned is lost, and only that message. Added here, once per
  // port, because a port is forgotten and registered again every time its tab is throttled past
  // the sweep. The port stays open: closing it would cut a live tab - perhaps the owner - off from
  // every other for good, and nothing would tell it so, which is why ADR-0021 never closes ports.
  port.addEventListener('messageerror', () => {
    logger.warn('dropped a message that could not be cloned', {
      clientId: identities.get(port),
      event: 'worker.message-error',
    });
  });

  // A `SharedWorker` port does not deliver anything until it is started.
  port.start();
};

function handleMessage(port: MessagePort, raw: unknown): void {
  const result = decodeMessage(raw);

  if (!result.ok) {
    // A tab of another protocol version, which the browser started on this script: a worker file
    // copied from another release, or one kept by a cache. Its hello is the one message every
    // version answers. The welcome carries this worker's version, and so tells the tab that nothing
    // it sends arrives here; the tab is not registered, and nothing else it says is routed
    // (ADR-0024).
    const otherVersionSender =
      result.failure.reason === 'version-mismatch' ? helloSenderOf(raw) : undefined;
    if (otherVersionSender !== undefined) {
      logger.warn('answered a tab on another protocol version', {
        clientId: otherVersionSender,
        event: 'worker.other-protocol-version',
        reason: describeDecodeFailure(result.failure),
      });
      try {
        port.postMessage(welcomeFor(otherVersionSender));
      } catch {
        // The tab has already gone, and nothing else is owed to it.
      }
      return;
    }

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
  const registered = ports.get(clientId);
  if (registered === port && identities.get(port) === clientId) {
    return;
  }

  // A tab that gave up on this worker while it hung connects again on a new port, and a message
  // still queued on the port it left can arrive after the new one was registered. The message is
  // routed like any other, but the port it came on never takes the tab's place back: until the
  // tab's next message, everything for it would go into a port it has closed.
  if (
    registered !== undefined &&
    (connectionOrder.get(registered) ?? 0) > (connectionOrder.get(port) ?? 0)
  ) {
    return;
  }

  // There is no port-close event. A context that leaves politely says goodbye; one that dies
  // stops sending heartbeats, and the sweep forgets it (ADR-0021).
  identities.set(port, clientId);
  ports.set(clientId, port);
  broker.handleConnect(clientId);
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
