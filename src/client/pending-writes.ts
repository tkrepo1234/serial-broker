import type { Clock, TimerHandle } from '../core/clock.js';
import { createSignal, type Signal } from '../core/deadline.js';
import type { PendingWritesDiagnostics } from '../core/diagnostics.js';
import { SerialBrokerErrorCode } from '../core/error-codes.js';
import { SerialBrokerError } from '../core/errors.js';
import type { RequestId, TermId } from '../protocol/messages.js';

/**
 * How much later than it was due a deadline may run before it is taken for one the tab could not
 * run in time.
 *
 * A browser runs timers late in three situations: a hidden tab's timers are aligned to whole seconds,
 * or to whole minutes after five minutes hidden; a frozen tab runs none until it resumes; and a
 * suspended machine runs none until it wakes. Only the first is routine, and it stays within a
 * second of the due time unless the tab has been hidden for long.
 */
export const LATE_DEADLINE_MS = 1_000;

/** A scheduled deadline. */
export interface Deadline {
  /** Stops the deadline. Safe to call after it expired, and more than once. */
  cancel(): void;
}

/**
 * Schedules `onExpired` after `delayMs`, and lets a deadline that runs late yield once first.
 *
 * A deadline decides from what a tab has heard: a write that no word of has arrived has not
 * started; a former owner that has said nothing more has gone. A tab that was frozen or asleep
 * resumes with its overdue timers and the messages that arrived meanwhile both queued, and the
 * browser promises no order between the two. Deciding at once may decide against a message that is
 * already waiting - failing a write that succeeded, or handing a written one to the next owner to be
 * written again (ADR-0011, ADR-0018).
 *
 * So a deadline that runs {@link LATE_DEADLINE_MS} or more late schedules itself once more with no
 * delay. That timer is queued behind the tasks already waiting, and those run first. A deadline that
 * runs on time decides at once. Lateness is measured on the monotonic clock, the one the timer itself
 * runs on (ADR-0012).
 */
export function scheduleDeadline(clock: Clock, onExpired: () => void, delayMs: number): Deadline {
  const dueAt = clock.monotonicNow() + delayMs;
  let handle: TimerHandle | undefined;

  const expire = (mayYield: boolean): void => {
    handle = undefined;
    if (mayYield && clock.monotonicNow() - dueAt >= LATE_DEADLINE_MS) {
      handle = clock.setTimer(() => {
        expire(false);
      }, 0);
      return;
    }
    onExpired();
  };

  handle = clock.setTimer(() => {
    expire(true);
  }, delayMs);

  return {
    cancel: () => {
      if (handle !== undefined) {
        clock.clearTimer(handle);
        handle = undefined;
      }
    },
  };
}

/** A write this context has issued and is still waiting on. */
interface PendingWrite {
  readonly requestId: RequestId;
  readonly payload: Uint8Array;
  readonly settled: Signal;
  /**
   * The term this context let begin the write, once it has (see {@link PendingWrites.approve}).
   *
   * The line between replayable and not. Before it, the bytes demonstrably never reached the
   * device and the request can be re-sent to a new owner: no term begins a write without this
   * context's approval. After it, whether they arrived is unknowable and the request must never be
   * repeated - unless that term answers that it did not begin it after all. See ADR-0011.
   */
  startedTerm: TermId | undefined;
  /**
   * The term the request was last handed to (ADR-0018).
   *
   * Only a tab holding the port in that term writes it, so this is the one term whose word decides
   * whether it was written. It is handed to another term only once this one has ended.
   */
  addressedTerm: TermId | undefined;
  /**
   * Set while the request sits with its addressed term, which has not answered yet.
   *
   * Stops the same command being queued twice at the owner when a status change retriggers
   * dispatch. Cleared when that term hands the write back because it could not write it; once the
   * term has ended without beginning it, the write is handed on whatever this says.
   */
  isDispatched: boolean;
  /**
   * The `writeTimeoutMs` deadline. One that runs late - the tab was frozen or asleep - first hears
   * the messages that arrived meanwhile, so a write that began or ended is not reported as one that
   * never started (see `scheduleDeadline`).
   */
  deadline: Deadline | undefined;
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
   * at-most-once guarantee in one place. The tab holding the port begins the write only once
   * {@link PendingWrites.approve} has said yes.
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
 * This is where the delivery guarantee of ADR-0011 lives, and it lives here rather than in the
 * broker for a reason: only the context that issued a write knows what it asked for, and
 * keeping the decision local means it behaves identically with or without a broker, and
 * survives the broker itself dying.
 *
 * The rules it enforces, all of them about one question - *may this command be sent again?*
 * A write is addressed to one term of holding the port, and only that term can write it
 * (ADR-0018).
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

  /** How far the outstanding writes have got, for a diagnostics report (ADR-0014). */
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
      deadline: undefined,
    };

    // The deadline covers the whole journey - waiting for an owner, crossing the bus, and the
    // device accepting the bytes - because from the caller's point of view that is one wait.
    pending.deadline = scheduleDeadline(
      this.host.clock,
      () => {
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
      },
      this.host.writeTimeoutMs,
    );

    this.#writes.set(requestId, pending);
    this.#dispatch(pending);

    await pending.settled.promise;
  }

  /**
   * Decides whether `term` may begin writing a request now, and if it may, counts it as begun.
   *
   * The tab holding the port asks before it begins any write (ADR-0011). The answer is yes only while
   * this context still waits on the write: one whose deadline has run was reported to its caller as
   * not started, and one that was released or refused is gone. Deciding and marking happen in one
   * turn of this context's event loop, so no deadline can run between them - from here on the
   * deadline reports `started: true`, and the write is never handed to another term.
   *
   * Only the term the request was addressed to may begin it: no other tab was asked to write it
   * (ADR-0018). A question from anywhere else concerns a copy that reached the wrong tab, or is forged,
   * and approving it would strand a write nobody is writing.
   *
   * @returns `true` if the term may begin the write.
   */
  approve(requestId: RequestId, term: TermId): boolean {
    const pending = this.#writes.get(requestId);
    if (pending?.addressedTerm !== term) {
      return false;
    }
    pending.startedTerm ??= term;
    return true;
  }

  /**
   * Takes the answer to a request from the term it was addressed to.
   *
   * Only that term writes the request, so only that term knows how it went, and an
   * answer from anywhere else is a copy that reached the wrong tab or a message from a script of
   * the origin that read the request id off the bus (ADR-0018). Such an answer is ignored: taken,
   * it would settle - resolve, even - a write that is still on its way to the device.
   *
   * `NOT_CONNECTED` is the one outcome that does not settle the write: that term did not write it
   * and will not, so the request goes back to be handed to whoever holds the port next. That holds
   * for a write this context had let begin, too - the port closed before the term could - and the
   * next term has to ask again.
   */
  handleResult(
    requestId: RequestId,
    term: TermId | undefined,
    error: SerialBrokerError | undefined,
  ): void {
    const pending = this.#writes.get(requestId);
    if (pending === undefined || term === undefined || term !== pending.addressedTerm) {
      return;
    }

    if (error?.code !== SerialBrokerErrorCode.NOT_CONNECTED) {
      this.settle(requestId, error);
      return;
    }

    // Only the addressed term is ever let begin a write, so this undoes that term's approval alone.
    pending.startedTerm = undefined;
    pending.isDispatched = false;
    this.#dispatch(pending);
  }

  /**
   * Reacts to a term of holding the port ending (ADR-0018).
   *
   * Everything that term said has arrived, or has been waited for as long as it will be. A write it
   * had begun and not answered is now undecidable and is failed; a write handed to it that it never
   * began - so the bytes demonstrably never reached the device - is handed on, which is not a
   * duplicate.
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
      }
    }
    this.dispatchWaiting();
  }

  /**
   * Hands on every write that has not started, including those already handed to an owner.
   *
   * For when a request may have been lost on its way: the broker it went through died
   * (ADR-0024), or the owner restated `open`. The owner recognises a request it has
   * already accepted, so handing one on again to the same term cannot write it twice (ADR-0011). A
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
    pending.deadline?.cancel();

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
      // new holder proves only that the old one let go of the lock (ADR-0018).
      return;
    }

    pending.isDispatched = true;
    pending.addressedTerm = term;
    this.host.dispatch(pending.requestId, pending.payload, term);
  }
}
