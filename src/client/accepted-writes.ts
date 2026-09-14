import { SerialBrokerErrorCode } from '../core/error-codes.js';
import type { SerialBrokerError } from '../core/errors.js';
import type { ClientId, RequestId } from '../protocol/messages.js';

/**
 * How many finished writes the tab holding the port remembers the outcome of.
 *
 * A repeat of a finished write can only come from the moments around an owner change or a new
 * broker, when a tab hands on the writes it has not yet seen start or end; a few hundred covers
 * any realistic burst there. Writes still in progress are not counted: see {@link AcceptedWrites}.
 */
export const MAX_REMEMBERED_FINISHED_WRITES = 1_024;

/** What to do with a write request the tab holding the port receives. */
export type Admission =
  /** Not seen before: write it. */
  | { readonly kind: 'new' }
  /** Being written already. Its own outcome is on the way; writing it again is never the answer. */
  | { readonly kind: 'in-progress' }
  /** Written already. The known outcome answers the repeat. */
  | { readonly kind: 'finished'; readonly error: SerialBrokerError | undefined };

/**
 * The writes one tab has accepted during one term of holding the port, from other tabs and its
 * own alike, keyed by the tab that issued each and its request.
 *
 * A tab can hand the same write over twice. It sends to whoever holds the port, and may learn
 * only afterwards - from `owner-claimed`, a late `NOT_CONNECTED`, or `open` restated - that it
 * has to hand on every write it has not seen start. Recognising the request is what keeps the
 * write at most once (ADR-0013); answering the repeat with the known outcome lets the issuing
 * tab settle it.
 *
 * A write in progress is never forgotten, however many there are: forgetting one lets its repeat
 * be written a second time, and every write accepted again pushes out the next one. There are
 * never more of them than writes queued at the port, which each end by their deadline. Only the
 * finished ones are bounded.
 */
export class AcceptedWrites {
  readonly #inProgress = new Set<string>();
  /** Outcomes by key. Maps iterate in insertion order, so the first key is the oldest. */
  readonly #finished = new Map<string, SerialBrokerError | undefined>();

  constructor(private readonly maxFinished = MAX_REMEMBERED_FINISHED_WRITES) {}

  /**
   * `true` for a request this record has already seen: one being written, or one that has ended.
   *
   * Asked before a write is refused for want of room at the port (ADR-0031): a repeat of a write
   * already accepted must be answered from here, never refused, because its bytes may already be
   * on their way to the device.
   */
  isKnown(origin: ClientId, requestId: RequestId): boolean {
    const key = keyOf(origin, requestId);
    return this.#inProgress.has(key) || this.#finished.has(key);
  }

  /** Decides what to do with a request, and records a new one as in progress. */
  admit(origin: ClientId, requestId: RequestId): Admission {
    const key = keyOf(origin, requestId);
    if (this.#inProgress.has(key)) {
      return { kind: 'in-progress' };
    }
    if (this.#finished.has(key)) {
      return { kind: 'finished', error: this.#finished.get(key) };
    }
    this.#inProgress.add(key);
    return { kind: 'new' };
  }

  /** Records how an admitted write ended. */
  finish(origin: ClientId, requestId: RequestId, error: SerialBrokerError | undefined): void {
    const key = keyOf(origin, requestId);
    this.#inProgress.delete(key);

    if (error?.code === SerialBrokerErrorCode.NOT_CONNECTED) {
      // Never started, so it is not remembered: the issuing tab hands it on again once the port is
      // open, and then it has to be written, not answered with this again.
      return;
    }

    this.#finished.set(key, error);
    if (this.#finished.size > this.maxFinished) {
      const oldest = this.#finished.keys().next().value;
      if (oldest !== undefined) {
        this.#finished.delete(oldest);
      }
    }
  }
}

function keyOf(origin: ClientId, requestId: RequestId): string {
  return `${origin} ${requestId}`;
}
