import type { Clock, TimerHandle } from '../core/clock.js';
import { createSignal, type Signal } from '../core/deadline.js';
import { describeUnknown, isAbortError } from '../core/errors.js';
import type { ScopedLogger } from '../core/logger.js';
import type { LockManagerLike } from '../environment/environment.js';
import { tabSlotGateLockName, tabSlotLockName } from '../protocol/version.js';

/** How long to wait before queueing again after the browser refused a lock request. */
export const TAB_SLOT_RETRY_DELAY_MS = 1_000;

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
  #isStopped = false;
  #isHeld = false;
  #release: Signal | undefined;
  #gateAbort: AbortController | undefined;
  #placeAbort: AbortController | undefined;
  #leaveGate: (() => void) | undefined;
  #retryTimer: TimerHandle | undefined;

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
    private readonly clock: Clock,
  ) {}

  /** `true` while this tab holds a place. */
  get isHeld(): boolean {
    return this.#isHeld;
  }

  /** Queues for a place. Returns at once; `onAcquired` says when one is held. */
  start(): void {
    if (this.#isStopped || this.#gateAbort !== undefined || this.#isHeld) {
      return;
    }

    const gateAbort = new AbortController();
    this.#gateAbort = gateAbort;

    void this.locks
      .request(
        tabSlotGateLockName(this.configName, this.maxTabs),
        { mode: 'exclusive', signal: gateAbort.signal },
        async () => {
          if (this.#isStopped) {
            return;
          }
          await this.#takePlace();
        },
      )
      .then(
        () => {
          this.#gateAbort = undefined;
        },
        (error: unknown) => {
          this.#gateAbort = undefined;
          // A tab that let go meanwhile does not queue again, however the request ended.
          if (!isAbortError(error) && !this.#isStopped) {
            this.#retryLater(error);
          }
        },
      );
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
    if (this.#retryTimer !== undefined) {
      this.clock.clearTimer(this.#retryTimer);
      this.#retryTimer = undefined;
    }

    if (this.#isHeld) {
      this.logger.info('gave up its place among the tabs using the configuration', {
        configName: this.configName,
        event: 'slot.released',
      });
    }
    this.#isHeld = false;
    // Resolving the release lets a held place go; aborting withdraws requests still queued; leaving
    // the gate lets the tab behind this one compete. Doing all three covers every state.
    this.#release?.resolve();
    this.#placeAbort?.abort();
    this.#gateAbort?.abort();
    this.#leaveGate?.();
  }

  /** Holding the gate: requests every place, keeps the first granted, and lets the gate go. */
  async #takePlace(): Promise<void> {
    const placeAbort = new AbortController();
    this.#placeAbort = placeAbort;

    await new Promise<void>((leaveGate) => {
      this.#leaveGate = leaveGate;
      let unsettled = this.maxTabs;
      let failure: unknown;

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
              const release = createSignal();
              this.#release = release;
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
              await release.promise;
            },
          )
          .catch((error: unknown) => {
            if (!isAbortError(error)) {
              failure = error;
            }
          })
          .finally(() => {
            unsettled -= 1;
            if (unsettled === 0 && !this.#isHeld) {
              // Every request ended without a place: withdrawn by `stop()`, or refused by the
              // browser. The gate is let go either way, and a refusal is tried again later.
              leaveGate();
              if (failure !== undefined && !this.#isStopped) {
                this.#retryLater(failure);
              }
            }
          });
      }
    });

    this.#leaveGate = undefined;
    this.#placeAbort = undefined;
  }

  #retryLater(error: unknown): void {
    this.logger.warn('requesting a place among the tabs failed; the tab queues again', {
      configName: this.configName,
      event: 'slot.failed',
      error: describeUnknown(error),
    });
    // After a pause, for the reason the election pauses: a request the browser refuses outright
    // would otherwise be repeated in an endless chain of microtasks.
    this.#retryTimer = this.clock.setTimer(() => {
      this.#retryTimer = undefined;
      this.start();
    }, TAB_SLOT_RETRY_DELAY_MS);
  }
}
