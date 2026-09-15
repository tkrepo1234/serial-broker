import type { Clock } from '../core/clock.js';
import { createSignal } from '../core/deadline.js';
import { describeUnknown, isAbortError } from '../core/errors.js';
import { HeldLock } from '../core/held-lock.js';
import type { ScopedLogger } from '../core/logger.js';
import type { LockManagerLike } from '../environment/environment.js';
import { tabSlotGateLockName, tabSlotLockName } from '../protocol/version.js';

/**
 * One of a configuration's `maxTabs` places, held for as long as this tab uses the configuration
 * (ADR-0025).
 *
 * Each place is a Web Lock. The browser releases a tab's locks when the tab goes away, however it
 * goes - closed, crashed, killed - exactly as it releases ownership (ADR-0005), so a place held by
 * a tab that died is never lost, and nothing has to notice the death.
 *
 * Web Locks cannot wait for *any one* of several locks. A tab that wants a place therefore first
 * takes the gate lock, and only while holding it requests every place at once: the first place
 * granted is kept, the other requests are withdrawn, and the gate is let go. Waiting tabs queue at
 * the gate, so they are admitted in the order they arrived, and only one of them at a time
 * competes for the places.
 */
export class TabSlot {
  readonly #gate: HeldLock;
  /** Resolved by {@link stop}: lets a held place go. */
  readonly #release = createSignal();
  #isStopped = false;
  #isHeld = false;
  #placeAbort: AbortController | undefined;
  #leaveGate: (() => void) | undefined;

  /**
   * @param maxTabs - How many places there are. A finite number: without a limit there is no
   *   place to take, and no `TabSlot`.
   * @param onAcquired - Called once a place is held, from inside the lock callback.
   */
  constructor(
    private readonly locks: LockManagerLike,
    private readonly configName: string,
    private readonly maxTabs: number,
    private readonly onAcquired: () => void,
    private readonly logger: ScopedLogger,
    clock: Clock,
  ) {
    this.#gate = new HeldLock({
      locks,
      clock,
      name: tabSlotGateLockName(configName, maxTabs),
      mode: 'exclusive',
      hold: () => this.#takePlace(),
      onFailed: (error) => {
        logger.warn('requesting a place among the tabs failed; the tab queues again', {
          configName,
          event: 'slot.failed',
          error: describeUnknown(error),
        });
      },
    });
  }

  /** `true` while this tab holds a place. */
  get isHeld(): boolean {
    return this.#isHeld;
  }

  /** Queues for a place. Returns at once; `onAcquired` says when one is held. */
  start(): void {
    if (!this.#isHeld) {
      this.#gate.start();
    }
  }

  /**
   * Leaves the queue, or gives the place up.
   *
   * Safe in every state: waiting at the gate, waiting for a place while holding the gate, holding
   * a place, or stopped already. The next tab at the gate is admitted as soon as the place is free.
   */
  stop(): void {
    if (this.#isStopped) {
      return;
    }
    this.#isStopped = true;
    if (this.#isHeld) {
      this.logger.info('gave up its place among the tabs using the configuration', {
        configName: this.configName,
        event: 'slot.released',
      });
    }
    this.#isHeld = false;
    // Resolving the release lets a held place go; aborting withdraws requests still queued; leaving
    // the gate lets the tab behind this one compete. Doing all of it covers every state.
    this.#release.resolve();
    this.#placeAbort?.abort();
    this.#leaveGate?.();
    void this.#gate.stop();
  }

  /**
   * Holding the gate: requests every place, keeps the first granted, and lets the gate go.
   *
   * Rejects when the browser refused every request, so that the gate is requested again later.
   */
  async #takePlace(): Promise<void> {
    const placeAbort = new AbortController();
    this.#placeAbort = placeAbort;

    await new Promise<void>((leaveGate, refused) => {
      this.#leaveGate = leaveGate;
      let unsettled = this.maxTabs;
      // Whatever the browser threw: its own reason is what the gate logs.
      let failure: Error | undefined;

      for (let place = 0; place < this.maxTabs; place += 1) {
        void this.locks
          .request(
            tabSlotLockName(this.configName, this.maxTabs, place),
            { mode: 'exclusive', signal: placeAbort.signal },
            async () => {
              // Another place was granted first, or the tab let go meanwhile. Returning frees this
              // one at once for the next tab.
              if (this.#isHeld || this.#isStopped) {
                return;
              }
              this.#isHeld = true;
              placeAbort.abort();
              leaveGate();

              this.logger.info('took a place among the tabs using the configuration', {
                configName: this.configName,
                event: 'slot.acquired',
                place,
                maxTabs: this.maxTabs,
              });
              this.onAcquired();

              // Holding the place means keeping this promise pending, as holding ownership does.
              await this.#release.promise;
            },
          )
          .catch((error: unknown) => {
            if (!isAbortError(error)) {
              failure = error as Error;
            }
          })
          .finally(() => {
            unsettled -= 1;
            if (unsettled === 0 && !this.#isHeld) {
              // Every request ended without a place: withdrawn by `stop()`, or refused by the
              // browser. The gate is let go either way, and a refusal is tried again later.
              if (failure === undefined || this.#isStopped) {
                leaveGate();
              } else {
                refused(failure);
              }
            }
          });
      }
    });

    this.#leaveGate = undefined;
    this.#placeAbort = undefined;
  }
}
