import { describeUnknown, isAbortError } from '../core/errors.js';
import { OnceLog, type ScopedLogger } from '../core/logger.js';
import type { LockManagerLike } from '../environment/environment.js';
import type { ClientId, TermId } from '../protocol/messages.js';
import { termLockName } from '../protocol/version.js';

/** How many terms are remembered, so that late or repeated messages are recognised. */
export const MAX_REMEMBERED_TERMS = 64;

/**
 * How many terms may be checked at once.
 *
 * Every term heard of costs one lock request until the browser has answered whether it is held. A
 * handover produces one term; anything beyond a handful at once is a sender inventing them. Beyond
 * it the oldest check gives way to the newest claim, so that a flood of invented terms cannot keep
 * the tab from checking the term that really holds the port.
 */
export const MAX_TERMS_BEING_CHECKED = 8;

/** How many messages of one term wait for the answer about its lock before they are dropped. */
export const MAX_MESSAGES_AWAITING_A_TERM = 16;

/** What a message says about the term of holding the port it speaks for. */
export interface TermClaim {
  /** The term. */
  readonly term: TermId;
  /** The context speaking for it. */
  readonly from: ClientId;
  /** The tab limit that context runs the configuration with (ADR-0025). */
  readonly maxTabs: number;
}

/** What the tracker needs. */
export interface OwnerTermsHost {
  readonly locks: LockManagerLike;
  readonly configName: string;
  readonly logger: ScopedLogger;
  /**
   * A term ended: nothing more can come from it.
   *
   * @param wasCurrent - Whether it was the term holding the port as far as this tab knew.
   */
  readonly onEnded: (term: TermId, wasCurrent: boolean) => void;
}

/** What this tab knows about one term. */
interface KnownTerm {
  readonly claim: TermClaim;
  phase: 'checking' | 'live' | 'ended' | 'refused';
  /** This tab holds the port in this term: it holds the lock itself, and decides when it ends. */
  readonly isOwn: boolean;
  /** A later term has been heard of, so this one's claims and statuses are stale. */
  isSucceeded: boolean;
  /** Its holder is letting go cleanly: it has a request of its own queued on the term's lock. */
  isEnding: boolean;
  /** Its holder's `owner-released` has arrived: the term is over once its lock is free. */
  hasHeardGoodbye: boolean;
  /** What arrived while the lock was being checked, in the order it arrived. */
  readonly waiting: (() => void)[];
  /** Withdraws the request that watches for the end of this term. */
  readonly watch: AbortController;
}

/**
 * What one tab knows about the terms of holding a configuration's port (ADR-0026, ADR-0030).
 *
 * Every term is a Web Lock, held by the tab that holds the port from before its first word in that
 * term until after its last (`protocol/version.ts`). The lock, and not what any message says,
 * decides two questions:
 *
 * - **Is this term live?** A claim or a status is believed only while the lock named after its
 *   term, its sender and its tab limit is held. A message naming a term nobody holds is not a term
 *   of this configuration, and changes nothing.
 * - **Has this term ended?** A tab queues for the lock of every term it hears of, and the browser
 *   grants it the moment the holder lets go - because it released the port, or because it died.
 *   Nothing ends a term that is still being held, so no message can end a live one.
 *
 * A tab letting go cleanly sends `owner-released` as the term's last word and queues a request of
 * its own on the term's lock beforehand. That request is what tells the difference between a tab
 * that let go - whose last words are on their way, and are waited for - and one that died, whose
 * term is over the moment the browser frees its lock.
 *
 * A goodbye is therefore never what ends a term: it is remembered until the browser frees the lock,
 * and only the two together end it. Anyone of the origin can queue a request on a term's lock, so a
 * queued request proves a clean end only once the lock is free - before that it proves nothing.
 */
export class OwnerTerms {
  /** Every term heard of, oldest first: a `Map` iterates in insertion order. */
  readonly #terms = new Map<TermId, KnownTerm>();
  #current: TermId | undefined;
  readonly #once: OnceLog;
  #isDisposed = false;

  constructor(private readonly host: OwnerTermsHost) {
    this.#once = new OnceLog(host.logger);
  }

  /** The term of the tab holding the port, as far as this tab has believed; `undefined` if none. */
  get current(): TermId | undefined {
    return this.#current;
  }

  /** `true` once nothing more can come from `term`. */
  isEnded(term: TermId): boolean {
    return this.#terms.get(term)?.phase === 'ended';
  }

  /** `true` if `from` is the context that speaks for `term`, whatever state that term is in. */
  isFrom(term: TermId, from: ClientId): boolean {
    const entry = this.#terms.get(term);
    return entry !== undefined && entry.phase !== 'refused' && entry.claim.from === from;
  }

  /**
   * `true` if `from` speaks for a term that holds the port or is still being waited for.
   *
   * What a tab that neither holds the port nor held it a moment ago says about the device is not
   * the device's (SECURITY.md).
   */
  isKnownSender(from: ClientId): boolean {
    for (const entry of this.#terms.values()) {
      if (entry.claim.from === from && (entry.phase === 'checking' || entry.phase === 'live')) {
        return true;
      }
    }
    return false;
  }

  /**
   * A claim or a status of a term arrived.
   *
   * @param apply - What to do with the message, run once the term is known to be live and not
   *   stale - which may be after a lock has been checked, so not necessarily in this task.
   */
  observe(claim: TermClaim, apply: () => void): void {
    if (this.#isDisposed) {
      return;
    }

    const entry = this.#terms.get(claim.term);
    if (entry === undefined) {
      this.#startChecking(claim, apply);
      return;
    }
    if (entry.phase === 'refused' || entry.phase === 'ended' || !isSameClaim(entry.claim, claim)) {
      // Nobody held this term when it was checked, it is over, or this message names another
      // sender or another tab limit for it than the lock its holder took.
      return;
    }
    if (entry.phase === 'checking') {
      this.#waitFor(entry, () => {
        this.observe(claim, apply);
      });
      return;
    }
    if (entry.isSucceeded) {
      // A later term has been heard of since. This one's word on the port is stale, however live
      // its lock still looks (ADR-0026).
      return;
    }

    this.#makeCurrent(entry);
    apply();
  }

  /**
   * `owner-released` of `term` arrived, from `from`.
   *
   * Noted, never believed on its own: a goodbye ends a term only once the browser has freed that
   * term's lock, and only from the term's own holder. So no message ends a term whose holder is
   * still writing to the device - not even one posted while a request of somebody else's waits on
   * the lock, which no tab can tell from the holder's own goodbye request.
   */
  heardReleased(term: TermId, from: ClientId): void {
    const entry = this.#terms.get(term);
    if (entry?.claim.from !== from) {
      return;
    }
    if (entry.phase === 'checking') {
      this.#waitFor(entry, () => {
        this.heardReleased(term, from);
      });
      return;
    }
    if (entry.phase !== 'live' || entry.isOwn) {
      return;
    }
    entry.hasHeardGoodbye = true;
    if (entry.isEnding) {
      // The lock is free and its holder was letting go cleanly: this was the word being waited for.
      this.#end(entry);
    }
  }

  /** This tab has been granted the port, and holds `claim.term`'s lock itself. */
  takeOwn(claim: TermClaim): void {
    const entry: KnownTerm = {
      claim,
      phase: 'live',
      isOwn: true,
      isSucceeded: false,
      isEnding: false,
      hasHeardGoodbye: false,
      waiting: [],
      watch: new AbortController(),
    };
    this.#remember(entry);
    this.#makeCurrent(entry);
  }

  /** This tab has let go of the port: its own term is over, and it knows so exactly. */
  endOwn(term: TermId): void {
    const entry = this.#terms.get(term);
    if (entry !== undefined) {
      this.#end(entry);
    }
  }

  /** Withdraws every outstanding lock request. Used when the configuration goes away. */
  dispose(): void {
    this.#isDisposed = true;
    for (const entry of this.#terms.values()) {
      entry.watch.abort();
      entry.waiting.length = 0;
    }
    this.#terms.clear();
    this.#current = undefined;
  }

  #startChecking(claim: TermClaim, apply: () => void): void {
    let checking = 0;
    for (const known of this.#terms.values()) {
      if (known.phase === 'checking') {
        checking += 1;
      }
    }
    if (checking >= MAX_TERMS_BEING_CHECKED) {
      // The oldest check gives way, rather than this claim being dropped: the newest claim is the
      // one that can be the term holding the port now, and a sender inventing terms faster than
      // the browser answers must not be able to keep the real one from ever being checked.
      const oldest = this.#firstMatching((known) => known.phase === 'checking');
      if (oldest === undefined) {
        return;
      }
      this.#forget(oldest);
      this.#logFlood(claim);
    }

    const entry: KnownTerm = {
      claim,
      phase: 'checking',
      isOwn: false,
      isSucceeded: false,
      isEnding: false,
      hasHeardGoodbye: false,
      waiting: [
        () => {
          this.observe(claim, apply);
        },
      ],
      watch: new AbortController(),
    };
    this.#remember(entry);

    void this.#checkLock(entry).then((held) => {
      if (this.#terms.get(claim.term) !== entry || entry.phase !== 'checking') {
        return;
      }
      if (held === 'unknown') {
        // The browser would not answer, so nothing is known about this term - including that it is
        // not held. Nothing is remembered about it either: the next message naming it is checked
        // afresh, rather than the tab ignoring a term that may well hold the port.
        this.#forget(entry);
        return;
      }
      if (held === 'free') {
        entry.phase = 'refused';
        entry.waiting.length = 0;
        this.#logRefusal(claim);
        return;
      }
      entry.phase = 'live';
      this.#watch(entry);
      for (const waiting of entry.waiting.splice(0)) {
        waiting();
      }
    });
  }

  /** Drops everything this tab held about a term, as if it had never heard of it. */
  #forget(entry: KnownTerm): void {
    entry.waiting.length = 0;
    entry.watch.abort();
    this.#terms.delete(entry.claim.term);
  }

  #waitFor(entry: KnownTerm, run: () => void): void {
    if (entry.waiting.length >= MAX_MESSAGES_AWAITING_A_TERM) {
      this.#logFlood(entry.claim);
      return;
    }
    entry.waiting.push(run);
  }

  /**
   * Asks the browser whether the term's lock is held: the term is live while it is.
   *
   * `unknown` is not `free`: a browser that refuses the request has said nothing about the term,
   * and a term that is in fact live must not be refused because one request failed.
   */
  async #checkLock(entry: KnownTerm): Promise<'held' | 'free' | 'unknown'> {
    try {
      return await this.host.locks.request(
        this.#lockNameOf(entry),
        { mode: 'shared', ifAvailable: true },
        // Granted means nobody holds it: no tab is in this term. The grant is given up again by
        // returning, so the check leaves nothing behind either way.
        (lock) => Promise.resolve(lock === null ? 'held' : 'free'),
      );
    } catch (error: unknown) {
      this.host.logger.warn('could not check whether a term of holding the port is live', {
        configName: this.host.configName,
        event: 'session.term-check-failed',
        term: entry.claim.term,
        error: describeUnknown(error),
      });
      return 'unknown';
    }
  }

  /** Queues for the term's lock: it is granted when the holder lets go, or when it dies. */
  #watch(entry: KnownTerm): void {
    void this.host.locks
      .request(
        this.#lockNameOf(entry),
        { mode: 'shared', signal: entry.watch.signal },
        async () => {
          // Whether the holder is letting go cleanly is asked while this grant is held: the
          // request it queued before saying goodbye waits behind this one until then.
          const isEnding = await this.#isEndingCleanly(entry);
          if (this.#terms.get(entry.claim.term) !== entry || entry.phase !== 'live') {
            return;
          }
          if (isEnding && !entry.hasHeardGoodbye) {
            // Its last words are on their way; `owner-released` is the last of them, and ends it.
            entry.isEnding = true;
            return;
          }
          // The lock is free, and either its holder died or its goodbye has already arrived.
          this.#end(entry);
        },
      )
      .catch((error: unknown) => {
        if (!isAbortError(error)) {
          this.host.logger.warn('could not watch a term of holding the port for its end', {
            configName: this.host.configName,
            event: 'session.term-watch-failed',
            term: entry.claim.term,
          });
        }
      });
  }

  /**
   * `true` while a request of somebody's is queued on the term's lock.
   *
   * A tab letting go of the port queues one before it says goodbye, and a tab that died leaves
   * nothing queued: asked while the lock is free - and only then - this tells a clean end from a
   * crash. It says nothing about a lock that is still held, because any script of the origin can
   * queue a request too (SECURITY.md); all such a script achieves is the wait for a goodbye.
   */
  async #isEndingCleanly(entry: KnownTerm): Promise<boolean> {
    const locks = this.host.locks;
    if (locks.query === undefined) {
      // Without `query` a clean end cannot be told from a crash. Both end the term as soon as the
      // lock is free, which is what a crash means; a goodbye still on its way is then missed.
      return false;
    }
    try {
      const snapshot = await locks.query();
      const name = this.#lockNameOf(entry);
      return (
        snapshot.pending?.some(
          (lock) => lock.name === name && (lock.mode ?? 'exclusive') === 'exclusive',
        ) === true
      );
    } catch {
      return false;
    }
  }

  #end(entry: KnownTerm): void {
    if (entry.phase === 'ended') {
      return;
    }
    entry.phase = 'ended';
    entry.waiting.length = 0;
    entry.watch.abort();
    const wasCurrent = this.#current === entry.claim.term;
    if (wasCurrent) {
      this.#current = undefined;
    }
    this.host.onEnded(entry.claim.term, wasCurrent);
  }

  #makeCurrent(entry: KnownTerm): void {
    if (this.#current === entry.claim.term) {
      return;
    }
    const previous = this.#current === undefined ? undefined : this.#terms.get(this.#current);
    if (previous !== undefined) {
      // Not ended: its lock says when that is. Only its word on the port is stale from now on.
      previous.isSucceeded = true;
    }
    this.#current = entry.claim.term;
  }

  #lockNameOf(entry: KnownTerm): string {
    return termLockName(
      this.host.configName,
      entry.claim.term,
      entry.claim.from,
      entry.claim.maxTabs,
    );
  }

  /** Keeps the newest {@link MAX_REMEMBERED_TERMS} terms, forgetting what is over first. */
  #remember(entry: KnownTerm): void {
    this.#terms.set(entry.claim.term, entry);
    while (this.#terms.size > MAX_REMEMBERED_TERMS) {
      const oldest =
        this.#firstMatching((known) => known.phase === 'ended' || known.phase === 'refused') ??
        this.#firstMatching((known) => known.claim.term !== this.#current);
      if (oldest === undefined) {
        return;
      }
      oldest.watch.abort();
      this.#terms.delete(oldest.claim.term);
    }
  }

  #firstMatching(predicate: (entry: KnownTerm) => boolean): KnownTerm | undefined {
    for (const entry of this.#terms.values()) {
      if (predicate(entry)) {
        return entry;
      }
    }
    return undefined;
  }

  #logRefusal(claim: TermClaim): void {
    this.#once.warn(
      'refusal',
      'ignored a message naming a term of holding the port that nobody holds; further ones are ignored without a record',
      { configName: this.host.configName, event: 'session.term-not-held', term: claim.term },
    );
  }

  #logFlood(claim: TermClaim): void {
    this.#once.warn(
      'flood',
      'dropped messages naming more terms of holding the port than are checked at once; further ones are dropped without a record',
      {
        configName: this.host.configName,
        event: 'session.term-flood',
        limit: MAX_TERMS_BEING_CHECKED,
        term: claim.term,
      },
    );
  }
}

/** `true` when two messages name the same term, sender and tab limit - the term's whole identity. */
function isSameClaim(known: TermClaim, claim: TermClaim): boolean {
  return known.from === claim.from && known.maxTabs === claim.maxTabs;
}
