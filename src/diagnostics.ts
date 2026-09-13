/**
 * serial-broker/diagnostics - a read-only view into what every tab of an origin is doing.
 *
 * The main entry point deliberately hides how tabs coordinate (ADR-0011): an application must
 * not be able to ask which tab owns the port, because it would branch on the answer and be
 * wrong a moment later. An operator trying to understand a deployment needs exactly that answer.
 * This entry point gives it to them, and only to code that imports it on purpose (ADR-0018).
 *
 * It is independent of the main entry point: it opens its own connection to the message bus and
 * shares no state with `SerialBroker`, so it works from any page of the origin and from a
 * separate bundle alike.
 *
 * Everything exported here is covered by SemVer, with one qualification: report types may gain
 * fields in a minor release, because describing more is the point of a diagnostics surface.
 *
 * @packageDocumentation
 */

import { DiagnosticsObserver } from './client/diagnostics-observer.js';
import type { DiagnosticsSnapshot, ObservedEvent } from './core/diagnostics.js';
import type { Logger, TransportKind, Unsubscribe } from './core/types.js';
import { createBrowserEnvironment } from './environment/browser.js';

export { DEFAULT_COLLECT_WINDOW_MS } from './client/diagnostics-observer.js';
export {
  CONNECTION_STATES,
  type ConfigurationDiagnostics,
  type ConnectionDiagnostics,
  type ConnectionStateName,
  type DiagnosticsSnapshot,
  type EffectiveSettings,
  type LockDiagnostics,
  type ObservedEvent,
  type ObservedError,
  type ObservedOwnership,
  type ObservedReceived,
  type ObservedSent,
  type ObservedStatus,
  type ObservedEventBase,
  type ParticipantDiagnostics,
  type PendingWritesDiagnostics,
} from './core/diagnostics.js';

/** How to reach the tabs being observed. */
export interface DiagnosticsOptions {
  /**
   * URL of the broker script, which must be **the same URL the application uses**.
   *
   * A `SharedWorker` is identified by its URL: an observer that loads the script from anywhere
   * else talks to a broker of its own and sees nobody. Irrelevant on the `BroadcastChannel`
   * transport. See ADR-0006.
   */
  readonly workerUrl?: string | URL;
  /**
   * The transport to use, which must match the application's.
   * @defaultValue 'auto'
   */
  readonly transport?: TransportKind;
  /** Receives the observer's own diagnostics, such as reports it had to drop. */
  readonly logger?: Logger;
}

/** An open connection to the bus, for looking at every tab of the origin. */
export interface SerialBrokerDiagnostics {
  /** Which message bus the observer ended up on. Tabs on the other one cannot be seen. */
  readonly transport: 'sharedworker' | 'broadcastchannel';

  /**
   * Asks every tab for a report, and lists this library's Web Locks.
   *
   * Every tab with at least one configuration set up answers with its role, status, effective
   * settings, listener counts and pending writes; the tab that owns a port also describes its
   * connection - state, reconnect attempts, when the next attempt is due, bytes in and out.
   *
   * @param windowMs - How long to listen for answers, in milliseconds. Nothing announces how
   *   many tabs exist, so the collection cannot know when the last one has answered.
   *   @defaultValue 500
   * @returns What arrived within the window.
   * @throws A `SerialBrokerError` with code `INVALID_ARGUMENT` for a negative or fractional
   *   window, or `CONFIGURATION_RELEASED` after {@link SerialBrokerDiagnostics.close}.
   * @example
   * ```ts
   * const diagnostics = openDiagnostics({ workerUrl: '/assets/serial-broker.worker.js' });
   * const { participants, locks } = await diagnostics.collect();
   * for (const tab of participants) {
   *   for (const configuration of tab.configurations) {
   *     console.table({ tab: tab.clientId, ...configuration, settings: undefined });
   *   }
   * }
   * ```
   */
  collect(windowMs?: number): Promise<DiagnosticsSnapshot>;

  /**
   * Streams one configuration's traffic, status changes, errors and ownership changes, from
   * whichever tab they happen in.
   *
   * Watching does not set the configuration up and never makes the observer eligible to own
   * the port.
   *
   * @param configName - The configuration to watch.
   * @param listener - Receives each event.
   * @returns A function that stops the listener.
   * @throws A `SerialBrokerError` with code `INVALID_ARGUMENT` or `CONFIGURATION_RELEASED`.
   * @example
   * ```ts
   * const stop = diagnostics.watch('Scale', (event) => {
   *   if (event.kind === 'owner-claimed') console.info(`port moved to ${event.from}`);
   * });
   * ```
   */
  watch(configName: string, listener: (event: ObservedEvent) => void): Unsubscribe;

  /** Leaves the bus. Idempotent. */
  close(): void;
}

/**
 * Opens a diagnostics connection to every tab of this origin.
 *
 * @param options - Must name the same broker script and transport as the application.
 * @returns An open observer. Close it when done; a closing page closes it anyway.
 * @throws A `SerialBrokerError` with code `WEB_SERIAL_UNAVAILABLE`, `WEB_LOCKS_UNAVAILABLE` or
 *   `TRANSPORT_UNAVAILABLE` in a browser that cannot run the library at all.
 * @example
 * ```ts
 * import { openDiagnostics } from 'serial-broker/diagnostics';
 *
 * const diagnostics = openDiagnostics();
 * const snapshot = await diagnostics.collect();
 * console.log(`${snapshot.participants.length} tab(s) are using serial-broker`);
 * diagnostics.close();
 * ```
 */
export function openDiagnostics(options: DiagnosticsOptions = {}): SerialBrokerDiagnostics {
  const observer = new DiagnosticsObserver(
    createBrowserEnvironment({
      workerUrl: options.workerUrl,
      transport: options.transport,
      logger: options.logger,
    }),
  );

  return {
    get transport() {
      return observer.transportKind;
    },
    async collect(windowMs) {
      return await observer.collect(windowMs);
    },
    watch(configName, listener) {
      return observer.watch(configName, listener);
    },
    close() {
      observer.close();
    },
  };
}
