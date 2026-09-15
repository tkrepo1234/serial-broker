import { NOOP_LOGGER, ScopedLogger } from '../core/logger.js';
import { SWEEP_INTERVAL_MS } from '../protocol/heartbeat.js';

import { WorkerPorts } from './worker-ports.js';

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
 * Any script of the origin can connect a port too. What a port may say, and on whose behalf, is
 * decided in `WorkerPorts`; this file only connects the browser to it.
 *
 * This file never imports the Web Serial API. It cannot: `navigator.serial` is not exposed to
 * workers, which is the constraint the whole architecture is built around (ADR-0004).
 */

declare const self: {
  onconnect: ((event: { readonly ports: readonly MessagePort[] }) => void) | null;
};

// Nothing here writes anywhere: a `SharedWorker` cannot reach the logger an application configured.
// What the worker records at `warn` is instead sent to the connected tabs, which log it through
// their own loggers (ADR-0029); `WorkerPorts` does that with every record it writes.
const logger = new ScopedLogger(NOOP_LOGGER, { event: 'worker' });

// `performance.now()` rather than `Date.now()`: the only thing timed in the worker is how long a
// tab has been silent, and the system clock being set forward must not make every tab look gone
// (ADR-0021, ADR-0032).
const ports = new WorkerPorts<MessagePort>({ logger, monotonicNow: () => performance.now() });

self.onconnect = (event): void => {
  const port = event.ports[0];
  if (port === undefined) {
    return;
  }

  port.addEventListener('message', (messageEvent: MessageEvent<unknown>) => {
    ports.receive(port, messageEvent.data);
  });

  // One message that could not be cloned is lost, and only that message. Added here, once per
  // port, because a port is forgotten and registered again every time its tab is throttled past
  // the sweep. The port stays open: closing it would cut a live tab - perhaps the owner - off from
  // every other for good, and nothing would tell it so, which is why ADR-0021 never closes ports.
  port.addEventListener('messageerror', () => {
    ports.reportMessageError(port);
  });

  // A `SharedWorker` port does not deliver anything until it is started.
  port.start();
};

// A port reports nothing when the tab behind it dies, so ports and participants that stay silent past
// the timeout are forgotten (ADR-0021). A forgotten port is never closed: a tab that was only
// throttled keeps its connection, and its next message registers it again.
setInterval(() => {
  ports.sweep();
}, SWEEP_INTERVAL_MS);
