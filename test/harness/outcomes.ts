import type { SerialBrokerClient } from '../../src/client/serial-broker-client.js';
import { ownerLockName } from '../../src/protocol/version.js';

import type { BrowserHarness } from './browser-harness.js';

/** How a promise settled, attached at once so a rejection is never unhandled. */
export function outcomeOf(promise: Promise<void>): Promise<unknown> {
  return promise.then(
    () => 'resolved',
    (error: unknown) => error,
  );
}

/** How many writes wait at the port of the tab holding it, as the diagnostics report says. */
export function queuedWritesAt(client: SerialBrokerClient): number | undefined {
  return client.diagnostics()?.configurations[0]?.connection?.queuedWrites;
}

/** What can be counted from outside, for the configuration `Reader`. */
export interface Footprint {
  readonly timers: number;
  readonly deviceListeners: number;
  readonly ownerLockQueue: number;
  readonly pendingWrites: number;
  readonly queuedWritesAtPort: number;
}

/**
 * Timers still scheduled, device listeners, tabs waiting for the port, and writes outstanding or
 * queued at the port, across the given tabs. Something that grows with time or with load shows up
 * as a difference between two of these.
 */
export function footprintOf(
  harness: BrowserHarness,
  clients: readonly SerialBrokerClient[],
): Footprint {
  let pendingWrites = 0;
  let queuedWritesAtPort = 0;
  for (const client of clients) {
    for (const configuration of client.diagnostics()?.configurations ?? []) {
      pendingWrites += configuration.pendingWrites.total;
      queuedWritesAtPort += configuration.connection?.queuedWrites ?? 0;
    }
  }
  return {
    timers: harness.clock.pendingTimerCount,
    deviceListeners: harness.serial.listenerCount,
    ownerLockQueue: harness.locks.queueLength(ownerLockName('Reader')),
    pendingWrites,
    queuedWritesAtPort,
  };
}
