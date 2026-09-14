import type { Clock, TimerHandle } from '../core/clock.js';
import { createSignal, type Signal } from '../core/deadline.js';
import type { PendingWritesDiagnostics } from '../core/diagnostics.js';
import { SerialBrokerErrorCode } from '../core/error-codes.js';
import { SerialBrokerError } from '../core/errors.js';
import type { RequestId, TermId } from '../protocol/messages.js';

/** A write this context has issued and is still waiting on. */
interface PendingWrite {
  readonly requestId: RequestId;
  readonly payload: Uint8Array;
  readonly settled: Signal;
  /**
   * The term that reported beginning to write it, once one has.
   *
   * The line between replayable and not. Before it, the bytes demonstrably never reached the
   * device and the request can be re-sent to a new owner. After it, whether they arrived is
   * unknowable and the request must never be repeated. See ADR-0013.
   */
  startedTerm: TermId | undefined;
  /**
   * The term the request was last handed to (ADR-0026).
   *
   * Only a tab holding the port in that term writes it, so this is the one term whose word decides
   * whether it was written. It is handed to another term only once this one has ended.
   */
  addressedTerm: TermId | undefined;
  /**
   * Set while the request sits with its addressed term, which has not answered yet.
   *
   * Stops the same command being queued twice at the owner when a status change or an
   * ownership announcement retriggers dispatch. Cleared when that term hands the write back
   * because it could not write it, or has ended without beginning it.
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
   * Hands a request to whoever holds the port in `term`.
   *
   * Called only when the tracker has decided it is safe to do so, which is what keeps the
   * at-most-once guarantee in one place.
   */
  readonly dispatch: (requestId: RequestId, payload: Uint8Array, term: TermId) => void;
  /** `true` when a connection exists to write to. Checked at every dispatch decision. */
  readonly canDispatch: () => boolean;
  /** The term of the tab holding the port, as far as this context has heard. */
  readonly currentTerm: () => TermId | undefined;
  /** `true` once nothing more can come from `term`. */
  readonly isTermEnded: (term: TermId) => boolean;
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
 * A write is addressed to one term of holding the port, and only that term can write it
 * (ADR-0026).
 *
 * | Situation | Answer |
 * | --- | --- |
 * | No connection yet | Hold it. The deadline bounds the wait. |
 * | Already handed to a term that has not answered | No. Sending again would queue it twice. |
 * | That term ended, and it had not started | Yes. The bytes demonstrably never left. |
 * | That term ended, and it **had** started, with no result | **Never.** Whether the device acted on it is unknowable. |
 * | A new owner claimed the port, but the old term has not ended | Wait: its last words may still be on their way. |
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
      if (pending.startedTerm !== undefined) {
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
      startedTerm: undefined,
      addressedTerm: undefined,
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
              started: pending.startedTerm !== undefined,
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

  /** Records that `term` has begun writing a request, making it non-replayable. */
  markStarted(requestId: RequestId, term: TermId): void {
    const pending = this.#writes.get(requestId);
    if (pending !== undefined) {
      pending.startedTerm ??= term;
    }
  }

  /**
   * Takes the answer to a request from the tab holding, or last holding, the port in `term`.
   *
   * An outcome settles the write, whichever term reports it: a term that wrote it knows how that
   * went. `NOT_CONNECTED` means that term did not write it and will not - but only from the term the
   * request was addressed to. The same answer from another term concerns a copy that reached the
   * wrong tab, and says nothing about the term that may still be writing it.
   */
  handleResult(
    requestId: RequestId,
    term: TermId | undefined,
    error: SerialBrokerError | undefined,
  ): void {
    if (error?.code !== SerialBrokerErrorCode.NOT_CONNECTED) {
      this.settle(requestId, error);
      return;
    }

    const pending = this.#writes.get(requestId);
    if (
      pending === undefined ||
      pending.startedTerm !== undefined ||
      term === undefined ||
      term !== pending.addressedTerm
    ) {
      return;
    }
    pending.isDispatched = false;
    this.#dispatch(pending);
  }

  /**
   * Reacts to a term of holding the port ending (ADR-0026).
   *
   * Everything that term said has arrived, or has been waited for as long as it will be. A write it
   * had begun and not answered is now undecidable and is failed; a write handed to it that it never
   * began is handed on.
   */
  handleTermEnded(term: TermId): void {
    for (const pending of [...this.#writes.values()]) {
      if (pending.startedTerm === term) {
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
      } else if (pending.startedTerm === undefined && pending.addressedTerm === term) {
        // Never started by the only term that could write it, so the bytes demonstrably never
        // reached the device - and handing it on is not a duplicate.
        pending.isDispatched = false;
        this.#dispatch(pending);
      }
    }
  }

  /**
   * Hands on every write that has not started, including those already handed to an owner.
   *
   * For when a request may have been lost on its way: the broker it went through died
   * (ADR-0021, amended), or the owner restated `open`. The owner recognises a request it has
   * already accepted, so handing one on again to the same term cannot write it twice (ADR-0013). A
   * write addressed to a term that has not ended stays with it.
   */
  resendUnstarted(): void {
    const current = this.host.currentTerm();
    for (const pending of [...this.#writes.values()]) {
      if (pending.startedTerm !== undefined) {
        continue;
      }
      const addressed = pending.addressedTerm;
      if (addressed === undefined || addressed === current || this.host.isTermEnded(addressed)) {
        pending.isDispatched = false;
        this.#dispatch(pending);
      }
    }
  }

  /** Dispatches everything that has been waiting for a connection or for a term to end. */
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
    if (pending.startedTerm !== undefined) {
      // Begun: never sent again, whatever happens next.
      return;
    }

    if (!this.host.canDispatch()) {
      // Nothing to write to. It stays here and goes out when a connection appears.
      return;
    }

    const term = this.host.currentTerm();
    if (term === undefined) {
      return;
    }

    const addressed = pending.addressedTerm;
    if (pending.isDispatched && addressed === term) {
      // Already with the term holding the port, which has not answered. Sending it again would put
      // the same command in that owner's queue twice.
      return;
    }
    if (addressed !== undefined && addressed !== term && !this.host.isTermEnded(addressed)) {
      // Another term may still be writing it, and its word may not have arrived: a claim from the
      // new holder proves only that the old one let go of the lock (ADR-0026).
      return;
    }

    pending.isDispatched = true;
    pending.addressedTerm = term;
    this.host.dispatch(pending.requestId, pending.payload, term);
  }
}
