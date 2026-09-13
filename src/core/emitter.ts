import { SerialBrokerErrorCode } from './error-codes.js';
import { describeUnknown, SerialBrokerError } from './errors.js';
import type { SerialBrokerEventMap, SerialBrokerEventName } from './types.js';

/** Receives errors thrown by application listeners, so they are reported and not swallowed. */
export type ListenerErrorReporter = (error: SerialBrokerError) => void;

/**
 * Event dispatch for one configuration.
 *
 * Two properties are load-bearing and both exist because application listeners are hostile
 * code as far as this library is concerned (docs/guidelines/defensive-programming.md):
 *
 * - **Re-entrancy safe.** Dispatch iterates a snapshot of the listener set, so a listener that
 *   calls `subscribe()` or `unsubscribe()` - or `send()`, which can synchronously emit -
 *   cannot corrupt the iteration or receive an event it registered for during that dispatch.
 * - **Fault isolating.** A listener that throws is caught, reported once as `LISTENER_THREW`,
 *   and the remaining listeners still receive the event.
 */
export class EventEmitter {
  readonly #listeners = new Map<SerialBrokerEventName, Set<(event: never) => void>>();

  constructor(
    private readonly reportListenerError: ListenerErrorReporter,
    private readonly now: () => number,
  ) {}

  /** Registers `listener`. Registering the same function twice has no additional effect. */
  add<TEvent extends SerialBrokerEventName>(
    event: TEvent,
    listener: (payload: SerialBrokerEventMap[TEvent]) => void,
  ): void {
    let listeners = this.#listeners.get(event);
    if (listeners === undefined) {
      listeners = new Set();
      this.#listeners.set(event, listeners);
    }
    listeners.add(listener);
  }

  /** Removes `listener`. Removing one that was never added is a no-op. */
  remove<TEvent extends SerialBrokerEventName>(
    event: TEvent,
    listener: (payload: SerialBrokerEventMap[TEvent]) => void,
  ): void {
    this.#listeners.get(event)?.delete(listener);
  }

  /** `true` if at least one listener is registered for `event`. */
  has(event: SerialBrokerEventName): boolean {
    const listeners = this.#listeners.get(event);
    return listeners !== undefined && listeners.size > 0;
  }

  /** How many listeners each event has, for a diagnostics report (ADR-0018). */
  listenerCounts(): Record<SerialBrokerEventName, number> {
    const count = (event: SerialBrokerEventName): number => this.#listeners.get(event)?.size ?? 0;
    return {
      onReceive: count('onReceive'),
      onSend: count('onSend'),
      onError: count('onError'),
      onStatusChange: count('onStatusChange'),
    };
  }

  /**
   * Delivers `payload` to every listener of `event`.
   *
   * Never throws: a listener's exception is reported through the error channel instead. The
   * one exception is a listener that throws while handling an `onError` event - reporting
   * that through `onError` again would recurse, so it is dropped without being reported.
   */
  emit<TEvent extends SerialBrokerEventName>(
    event: TEvent,
    payload: SerialBrokerEventMap[TEvent],
  ): void {
    const listeners = this.#listeners.get(event);
    if (listeners === undefined || listeners.size === 0) {
      return;
    }

    // Snapshot: a listener may subscribe or unsubscribe during dispatch.
    for (const listener of [...listeners]) {
      try {
        (listener as (payload: SerialBrokerEventMap[TEvent]) => void)(payload);
      } catch (error) {
        this.#reportSafely(event, error);
      }
    }
  }

  /** Removes every listener. Used when a configuration is released. */
  clear(): void {
    this.#listeners.clear();
  }

  #reportSafely(event: SerialBrokerEventName, error: unknown): void {
    const wrapped = new SerialBrokerError(
      SerialBrokerErrorCode.LISTENER_THREW,
      `A listener for "${event}" threw: ${describeUnknown(error)}`,
      { context: { event }, timestamp: this.now(), cause: error },
    );

    if (event === 'onError') {
      // Reporting a failed onError listener through onError would recurse indefinitely.
      // The error is dropped here by design; the listener's own bug is its author's to find.
      return;
    }

    try {
      this.reportListenerError(wrapped);
    } catch {
      // The reporter itself is library code and must not throw. If it somehow does, there is
      // no channel left to report on, and losing the event is better than losing the tab.
    }
  }
}
