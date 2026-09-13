import type { Clock, TimerHandle } from '../core/clock.js';
import { createSignal, type Signal } from '../core/deadline.js';
import type { PendingWritesDiagnostics } from '../core/diagnostics.js';
import { SerialBrokerErrorCode } from '../core/error-codes.js';
import { SerialBrokerError } from '../core/errors.js';
import type { RequestId } from '../protocol/messages.js';

/** A write this context has issued and is still waiting on. */
interface PendingWrite {
  readonly requestId: RequestId;
  readonly payload: Uint8Array;
  readonly settled: Signal;
  /**
   * Set when the owner reports it has begun writing.
   *
   * The line between replayable and not. Before it, the bytes demonstrably never reached the
   * device and the request can be re-sent to a new owner. After it, whether they arrived is
   * unknowable and the request must never be repeated. See ADR-0013.
   */
  started: boolean;
  /**
   * Set while the request sits with an owner that has not answered yet.
   *
   * Stops the same command being queued twice at the owner when a status change or an
   * ownership announcement retriggers dispatch. Cleared when the owner it was handed to is
   * known to be gone, or hands the write back because it no longer holds the port.
   */
  isDispatched: boolean;
  timer: TimerHandle | undefined;
}

/** What the tracker needs in order to do its work. */
export interface PendingWriteHost {
  readonly clock: Clock;
  readonly configName: string;
  /** Milliseconds a write may spend waiting, in total, before it is failed. */
  readonly writeTimeoutMs: number;
  /**
   * Hands a request to whoever can perform it.
   *
   * Called only when the tracker has decided it is safe to do so, which is what keeps the
   * at-most-once guarantee in one place.
   */
  readonly dispatch: (requestId: RequestId, payload: Uint8Array) => void;
  /** `true` when a connection exists to write to. Checked at every dispatch decision. */
  readonly canDispatch: () => boolean;
}

/**
 * The lifecycle of every write this context has issued.
 *
 * This is where the delivery guarantee of ADR-0013 lives, and it lives here rather than in the
 * broker for a reason: only the context that issued a write knows what it asked for, and
 * keeping the decision local means it behaves identically with or without a broker, and
 * survives the broker itself dying.
 *
 * The rules it enforces, all of them about one question - *may this command be sent again?*
 *
 * | Situation | Answer |
 * | --- | --- |
 * | No connection yet | Hold it. The deadline bounds the wait. |
 * | Already handed to an owner, no answer yet | No. Sending again would queue it twice. |
 * | The owner went away, and it had not started | Yes. The bytes demonstrably never left. |
 * | The owner went away, and it **had** started | **Never.** Whether the device acted on it is unknowable. |
 */
export class PendingWrites {
  readonly #writes = new Map<RequestId, PendingWrite>();

  constructor(private readonly host: PendingWriteHost) {}

  /** Number of writes issued here and not yet settled. */
  get size(): number {
    return this.#writes.size;
  }

  /** How far the outstanding writes have got, for a diagnostics report (ADR-0018). */
  diagnostics(): PendingWritesDiagnostics {
    let dispatched = 0;
    let started = 0;
    for (const pending of this.#writes.values()) {
      if (pending.isDispatched) {
        dispatched += 1;
      }
      if (pending.started) {
        started += 1;
      }
    }
    return { total: this.#writes.size, dispatched, started };
  }

  /**
   * Registers a write and dispatches it when it can be dispatched.
   *
   * @returns A promise that settles when the owner reports the outcome, the deadline expires,
   *   or the configuration is released.
   */
  async add(requestId: RequestId, payload: Uint8Array): Promise<void> {
    const pending: PendingWrite = {
      requestId,
      payload,
      settled: createSignal(),
      started: false,
      isDispatched: false,
      timer: undefined,
    };

    // The deadline covers the whole journey - waiting for an owner, crossing the bus, and the
    // device accepting the bytes - because from the caller's point of view that is one wait.
    pending.timer = this.host.clock.setTimer(() => {
      this.settle(
        requestId,
        new SerialBrokerError(
          SerialBrokerErrorCode.WRITE_TIMEOUT,
          'The write did not complete within the configured deadline',
          {
            configName: this.host.configName,
            context: {
              requestId,
              byteLength: payload.byteLength,
              started: pending.started,
            },
            timestamp: this.host.clock.now(),
          },
        ),
      );
    }, this.host.writeTimeoutMs);

    this.#writes.set(requestId, pending);
    this.#dispatch(pending);

    await pending.settled.promise;
  }

  /** Records that the owner has begun writing a request, making it non-replayable. */
  markStarted(requestId: RequestId): void {
    const pending = this.#writes.get(requestId);
    if (pending !== undefined) {
      pending.started = true;
    }
  }

  /** `true` once an owner has reported beginning to write the request. */
  isStarted(requestId: RequestId): boolean {
    return this.#writes.get(requestId)?.started === true;
  }

  /**
   * Returns a request to the queue so it can be handed to somebody else.
   *
   * Used when an owner declines a write because it stopped being the owner between receiving
   * it and performing it. The write never started, so this is not a repeat.
   *
   * @returns `true` if it was re-dispatched, `false` if it had already started and must not be.
   */
  redispatch(requestId: RequestId): boolean {
    const pending = this.#writes.get(requestId);
    if (pending === undefined || pending.started) {
      return false;
    }

    pending.isDispatched = false;
    this.#dispatch(pending);
    return true;
  }

  /**
   * Reacts to ownership changing hands.
   *
   * A new owner announcing itself is proof that the previous one is gone - the Web Lock cannot
   * be granted while it is held (ADR-0005). So every write that had started with the old owner
   * is now undecidable and is failed, and every write that had not is handed on.
   */
  handleOwnerChanged(): void {
    for (const pending of [...this.#writes.values()]) {
      if (pending.started) {
        this.settle(
          pending.requestId,
          new SerialBrokerError(
            SerialBrokerErrorCode.OWNER_LOST_DURING_WRITE,
            'The tab that owned the port went away while this write was in progress',
            {
              configName: this.host.configName,
              context: { requestId: pending.requestId, byteLength: pending.payload.byteLength },
              timestamp: this.host.clock.now(),
            },
          ),
        );
      } else {
        // Never started, so the bytes demonstrably never reached the device - and the context
        // it was handed to is gone, so handing it on is not a duplicate.
        pending.isDispatched = false;
        this.#dispatch(pending);
      }
    }
  }

  /** Dispatches everything that has been waiting for a connection. */
  dispatchWaiting(): void {
    for (const pending of [...this.#writes.values()]) {
      this.#dispatch(pending);
    }
  }

  /** Settles one write. Resolving it means the bytes reached the device. */
  settle(requestId: RequestId, error: SerialBrokerError | undefined): void {
    const pending = this.#writes.get(requestId);
    if (pending === undefined) {
      return;
    }

    this.#writes.delete(requestId);
    if (pending.timer !== undefined) {
      this.host.clock.clearTimer(pending.timer);
    }

    if (error === undefined) {
      pending.settled.resolve();
    } else {
      pending.settled.reject(error);
    }
  }

  /** Fails everything still outstanding. Used when the configuration goes away. */
  failAll(error: SerialBrokerError): void {
    for (const requestId of [...this.#writes.keys()]) {
      this.settle(requestId, error);
    }
  }

  /**
   * Hands a write on, if it is safe to do so.
   *
   * Holding rather than failing is what makes `send()` usable during the seconds after a page
   * loads, while the port is still opening, and during a handover. The caller's deadline
   * bounds the wait, so nothing waits forever.
   */
  #dispatch(pending: PendingWrite): void {
    if (pending.isDispatched) {
      // Already with an owner that has not answered. Sending it again would put the same
      // command in that owner's queue twice.
      return;
    }

    if (!this.host.canDispatch()) {
      // Nothing to write to. It stays here and goes out when a connection appears.
      return;
    }

    pending.isDispatched = true;
    this.host.dispatch(pending.requestId, pending.payload);
  }
}
