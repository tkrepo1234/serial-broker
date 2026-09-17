import { NOOP_LOGGER } from '../core/logger.js';
import type { LockManagerLike } from '../environment/environment.js';

import { WorkerPorts } from './worker-ports.js';

/**
 * The broker, as a `SharedWorker` script.
 *
 * One instance of this exists per origin, per protocol version, no matter how many tabs are
 * open - that is the entire reason it exists. Every tab connects a `MessagePort` to it, and
 * it routes between them (ADR-0006).
 *
 * It deliberately holds no important state. If the worker dies - it crashed, the browser ended it,
 * or someone terminated it - its ports simply go quiet, but the browser lets go of the Web Lock it
 * held for its lifetime, and every tab waiting on that lock starts a new worker and says hello there
 * again (ADR-0041). What is lost is the traffic in between. The things that must not be lost - which
 * context owns the port, what happens to an in-flight write - are held by the Web Lock and by the
 * context that issued the write (ADR-0005, ADR-0013).
 *
 * Any script of the origin can connect a port too. What a port may say, and on whose behalf, is
 * decided in `WorkerPorts`; this file only connects the browser to it.
 *
 * This file never imports the Web Serial API. It cannot: `navigator.serial` is not exposed to
 * workers, which is the constraint the whole architecture is built around (ADR-0004).
 */

declare const self: {
  onconnect: ((event: { readonly ports: readonly MessagePort[] }) => void) | null;
};

declare const navigator: { readonly locks: LockManagerLike };

// Nothing here writes anywhere: a `SharedWorker` cannot reach the logger an application configured.
// What the worker records at `warn` is instead sent to the connected tabs, which log it through
// their own loggers (ADR-0018).
const ports = new WorkerPorts<MessagePort>({
  logger: NOOP_LOGGER,
  locks: navigator.locks,
  workerId: crypto.randomUUID(),
});

self.onconnect = (event): void => {
  const port = event.ports[0];
  if (port === undefined) {
    return;
  }

  port.addEventListener('message', (messageEvent: MessageEvent<unknown>) => {
    ports.receive(port, messageEvent.data);
  });

  // One message that could not be cloned is lost, and only that message. The port stays open:
  // closing it would cut a live tab - perhaps the owner - off from every other, and nothing would
  // tell it so.
  port.addEventListener('messageerror', () => {
    ports.reportMessageError(port);
  });

  // A `SharedWorker` port delivers nothing until it is started, and keeps what arrives meanwhile. It
  // is started once the worker holds its lifetime lock, so no tab waits on that lock before the
  // worker has it (ADR-0041).
  void ports.ready.then(() => {
    port.start();
  });
};
