import { describe, expect, it } from 'vitest';

import { MAX_TERM_FLOOD, OwnerTerms, type TermClaim } from '../../src/client/owner-terms.js';
import { ScopedLogger } from '../../src/core/logger.js';
import type { ClientId, ProtocolMessage, RequestId, TermId } from '../../src/protocol/messages.js';
import { PROTOCOL_VERSION, termLockName } from '../../src/protocol/version.js';
import { flushMicrotasks } from '../harness/fake-clock.js';
import { FakeLockManager } from '../harness/fake-locks.js';
import { fieldsOfEvent, recordingLogger } from '../harness/recording-logger.js';

const CONFIG = 'Reader';
const HOLDER = 'c-holder' as ClientId;

const claimOf = (
  term: string,
  from: ClientId = HOLDER,
  maxTabs = Number.POSITIVE_INFINITY,
): TermClaim => ({
  term: term as TermId,
  from,
  maxTabs,
});

const FIRST = claimOf('t1');
const SECOND = claimOf('t2');

/** One tab that hears about terms, with the lock manager every simulated tab shares. */
function createTerms(): {
  terms: OwnerTerms;
  locks: FakeLockManager;
  ended: { term: TermId; wasCurrent: boolean }[];
  records: ReturnType<typeof recordingLogger>['records'];
} {
  const locks = new FakeLockManager();
  const ended: { term: TermId; wasCurrent: boolean }[] = [];
  const { logger, records } = recordingLogger();
  const terms = new OwnerTerms({
    locks: locks.forContext('watcher'),
    configName: CONFIG,
    logger: new ScopedLogger(logger, {}),
    onEnded: (term, wasCurrent) => ended.push({ term, wasCurrent }),
  });
  return { terms, locks, ended, records };
}

/** A tab holding the port in `claim`: it holds the term's lock until it lets go or is killed. */
async function holdTerm(
  locks: FakeLockManager,
  contextId: string,
  claim: TermClaim,
): Promise<{ letGo: () => void; sayGoodbye: () => void }> {
  const name = termLockName(CONFIG, claim.term, claim.from, claim.maxTabs);
  let letGo!: () => void;
  const held = new Promise<void>((resolve) => {
    letGo = resolve;
  });
  void locks.forContext(contextId).request(name, { mode: 'exclusive' }, async () => {
    await held;
  });
  await flushMicrotasks();
  return {
    letGo,
    // What a tab letting go cleanly queues before its goodbye, and what tells a watching tab that
    // the term's last words are on their way.
    sayGoodbye: () => {
      void locks.forContext(contextId).request(name, { mode: 'exclusive' }, async () => undefined);
    },
  };
}

const ENVELOPE = { v: PROTOCOL_VERSION, to: 'all', configName: CONFIG } as const;

/** A claim of the term, as the tab holding it sends it. */
function observe(terms: OwnerTerms, claim: TermClaim, apply: () => void): void {
  terms.authorize({ ...ENVELOPE, type: 'owner-claimed', ...claim }, apply);
}

/** The goodbye of a term, from `from`. */
function heardReleased(terms: OwnerTerms, term: TermId, from: ClientId): void {
  terms.authorize({ ...ENVELOPE, type: 'owner-released', term, from }, () => undefined);
}

/** Whether what `from` says about the device is believed. */
function speaksForATerm(terms: OwnerTerms, from: ClientId): boolean {
  let isBelieved = false;
  const message = { ...ENVELOPE, type: 'data-sent', from, originClientId: from, timestamp: 0 };
  terms.authorize(
    { ...message, payload: new Uint8Array() } as ProtocolMessage,
    () => (isBelieved = true),
  );
  return isBelieved;
}

/** Whether what `from` says about a write of `term` is believed. */
function speaksFor(terms: OwnerTerms, term: TermId, from: ClientId): boolean {
  let isBelieved = false;
  const message = { ...ENVELOPE, type: 'write-started', from, term, requestId: 'w-1' as RequestId };
  terms.authorize(message as ProtocolMessage, () => (isBelieved = true));
  return isBelieved;
}

/** Records what a claim or status was allowed to do. */
function applied(): { run: () => void; count: () => number } {
  let count = 0;
  return { run: () => (count += 1), count: () => count };
}

/**
 * What one tab knows about the terms of holding a port (ADR-0026, ADR-0030).
 *
 * Every question here is answered by a Web Lock, never by what a message says: a term is live
 * while its lock is held, and over when the browser frees it. So a message can neither invent a
 * term nor end one that a tab is still writing in.
 */
describe('OwnerTerms', () => {
  it('believes a claim whose term lock is held, and takes it for the term holding the port', async () => {
    const { terms, locks } = createTerms();
    await holdTerm(locks, 'owner', FIRST);
    const apply = applied();

    observe(terms, FIRST, apply.run);
    await flushMicrotasks();

    expect(terms.current).toBe('t1');
    expect(apply.count()).toBe(1);
  });

  it('refuses a claim naming a term nobody holds, and logs it once', async () => {
    const { terms, records } = createTerms();
    const apply = applied();

    observe(terms, FIRST, apply.run);
    observe(terms, claimOf('t-invented'), apply.run);
    await flushMicrotasks();

    expect(terms.current).toBeUndefined();
    expect(apply.count()).toBe(0);
    expect(fieldsOfEvent(records, 'session.term-not-held')).toHaveLength(1);
  });

  it('refuses a message naming another sender or another tab limit than the lock', async () => {
    const { terms, locks } = createTerms();
    await holdTerm(locks, 'owner', FIRST);
    const apply = applied();

    observe(terms, claimOf('t1', 'c-mallory' as ClientId), apply.run);
    observe(terms, claimOf('t1', HOLDER, 4), apply.run);
    await flushMicrotasks();

    expect(apply.count()).toBe(0);
    expect(terms.current).toBeUndefined();
  });

  it('keeps a live term when another claim arrives: nothing but its lock ends it', async () => {
    const { terms, locks, ended } = createTerms();
    await holdTerm(locks, 'owner', FIRST);
    await holdTerm(locks, 'other', SECOND);

    observe(terms, FIRST, () => undefined);
    await flushMicrotasks();
    observe(terms, SECOND, () => undefined);
    await flushMicrotasks();

    expect(terms.current).toBe('t2');
    expect(terms.isEnded(FIRST.term)).toBe(false);
    expect(ended).toEqual([]);
  });

  it('ignores a claim or status of a term another term has succeeded', async () => {
    const { terms, locks } = createTerms();
    await holdTerm(locks, 'owner', FIRST);
    await holdTerm(locks, 'other', SECOND);
    observe(terms, FIRST, () => undefined);
    await flushMicrotasks();
    observe(terms, SECOND, () => undefined);
    await flushMicrotasks();
    const apply = applied();

    observe(terms, FIRST, apply.run);
    await flushMicrotasks();

    expect(apply.count()).toBe(0);
    expect(terms.current).toBe('t2');
  });

  it('ends a term the moment the browser frees the lock of a tab that died', async () => {
    const { terms, locks, ended } = createTerms();
    await holdTerm(locks, 'owner', FIRST);
    observe(terms, FIRST, () => undefined);
    await flushMicrotasks();

    locks.killContext('owner');
    await flushMicrotasks();

    expect(ended).toEqual([{ term: 't1', wasCurrent: true }]);
    expect(terms.isEnded(FIRST.term)).toBe(true);
    expect(terms.current).toBeUndefined();
  });

  it('ends a term at its goodbye, once its holder has let the lock go', async () => {
    const { terms, locks, ended } = createTerms();
    const holder = await holdTerm(locks, 'owner', FIRST);
    observe(terms, FIRST, () => undefined);
    await flushMicrotasks();

    // The goodbye reached this tab before the lock was free, which is the usual order: the holder
    // posts it and then lets the lock go.
    holder.sayGoodbye();
    heardReleased(terms, FIRST.term, HOLDER);
    await flushMicrotasks();
    expect(ended).toEqual([]);

    holder.letGo();
    await flushMicrotasks();

    expect(ended).toEqual([{ term: 't1', wasCurrent: true }]);
  });

  it('does not end a live term at a goodbye with somebody else queued on the lock', async () => {
    const { terms, locks, ended } = createTerms();
    await holdTerm(locks, 'owner', FIRST);
    observe(terms, FIRST, () => undefined);
    await flushMicrotasks();

    // What a script of the origin can produce: a request of its own on the real term's lock, which
    // no tab can tell from the holder's goodbye request, and a goodbye in the holder's name.
    void locks
      .forContext('mallory')
      .request(
        termLockName(CONFIG, FIRST.term, FIRST.from, FIRST.maxTabs),
        { mode: 'exclusive' },
        async () => undefined,
      );
    heardReleased(terms, FIRST.term, HOLDER);
    await flushMicrotasks();

    // The holder still holds the lock, and is still writing to the device.
    expect(ended).toEqual([]);
    expect(terms.current).toBe('t1');
    expect(terms.isEnded(FIRST.term)).toBe(false);
  });

  it('does not end a live term at a goodbye nobody queued for', async () => {
    const { terms, locks, ended } = createTerms();
    await holdTerm(locks, 'owner', FIRST);
    observe(terms, FIRST, () => undefined);
    await flushMicrotasks();

    heardReleased(terms, FIRST.term, HOLDER);
    await flushMicrotasks();

    expect(ended).toEqual([]);
    expect(terms.current).toBe('t1');
  });

  it('does not end a term at a goodbye from anyone but its holder', async () => {
    const { terms, locks, ended } = createTerms();
    const holder = await holdTerm(locks, 'owner', FIRST);
    observe(terms, FIRST, () => undefined);
    await flushMicrotasks();

    holder.sayGoodbye();
    heardReleased(terms, FIRST.term, 'c-mallory' as ClientId);
    await flushMicrotasks();

    expect(ended).toEqual([]);
  });

  it('waits for the goodbye of a holder that let go cleanly, rather than ending at the free lock', async () => {
    const { terms, locks, ended } = createTerms();
    const holder = await holdTerm(locks, 'owner', FIRST);
    observe(terms, FIRST, () => undefined);
    await flushMicrotasks();

    // The order a tab letting go keeps: queue for the lock, say goodbye, let the lock go. The
    // goodbye is still on its way here.
    holder.sayGoodbye();
    holder.letGo();
    await flushMicrotasks();
    expect(ended).toEqual([]);

    heardReleased(terms, FIRST.term, HOLDER);
    await flushMicrotasks();

    expect(ended).toEqual([{ term: 't1', wasCurrent: true }]);
  });

  it('knows the senders of the term holding the port and of one still being waited for', async () => {
    const { terms, locks } = createTerms();
    await holdTerm(locks, 'owner', FIRST);
    const second = claimOf('t2', 'c-second' as ClientId);
    await holdTerm(locks, 'other', second);
    observe(terms, FIRST, () => undefined);
    await flushMicrotasks();
    observe(terms, second, () => undefined);
    await flushMicrotasks();

    expect(speaksForATerm(terms, HOLDER)).toBe(true);
    expect(speaksForATerm(terms, 'c-second' as ClientId)).toBe(true);
    expect(speaksForATerm(terms, 'c-mallory' as ClientId)).toBe(false);
    expect(speaksFor(terms, FIRST.term, HOLDER)).toBe(true);
    expect(speaksFor(terms, FIRST.term, 'c-mallory' as ClientId)).toBe(false);
  });

  it('forgets the sender of a term that has ended', async () => {
    const { terms, locks } = createTerms();
    await holdTerm(locks, 'owner', FIRST);
    observe(terms, FIRST, () => undefined);
    await flushMicrotasks();
    locks.killContext('owner');
    await flushMicrotasks();

    expect(speaksForATerm(terms, HOLDER)).toBe(false);
  });

  it('takes its own term without asking the browser, and ends it when this tab says so', async () => {
    const { terms, ended } = createTerms();

    terms.takeOwn(FIRST);
    expect(terms.current).toBe('t1');

    terms.endOwn(FIRST.term);

    expect(ended).toEqual([{ term: 't1', wasCurrent: true }]);
  });

  it('ignores a goodbye for its own term: only this tab ends it', async () => {
    const { terms, ended } = createTerms();
    terms.takeOwn(FIRST);

    heardReleased(terms, FIRST.term, HOLDER);
    await flushMicrotasks();

    expect(ended).toEqual([]);
  });

  it('applies what arrived while a term was being checked, in the order it arrived', async () => {
    const { terms, locks } = createTerms();
    await holdTerm(locks, 'owner', FIRST);
    const applied: string[] = [];

    observe(terms, FIRST, () => applied.push('claim'));
    observe(terms, FIRST, () => applied.push('status'));
    observe(terms, FIRST, () => applied.push('another status'));
    await flushMicrotasks();

    expect(applied).toEqual(['claim', 'status', 'another status']);
  });

  it('drops what arrives beyond the messages one term being checked may hold', async () => {
    const { terms, locks, records } = createTerms();
    await holdTerm(locks, 'owner', FIRST);
    const apply = applied();

    for (let index = 0; index < MAX_TERM_FLOOD + 4; index += 1) {
      observe(terms, FIRST, apply.run);
    }
    await flushMicrotasks();

    expect(apply.count()).toBe(MAX_TERM_FLOOD);
    expect(fieldsOfEvent(records, 'session.term-flood')).toHaveLength(1);
  });

  it('ends a term whose goodbye arrived while its lock was being checked', async () => {
    const { terms, locks, ended } = createTerms();
    const holder = await holdTerm(locks, 'owner', FIRST);

    observe(terms, FIRST, () => undefined);
    holder.sayGoodbye();
    heardReleased(terms, FIRST.term, HOLDER);
    await flushMicrotasks();
    expect(ended).toEqual([]);

    holder.letGo();
    await flushMicrotasks();

    expect(ended).toEqual([{ term: 't1', wasCurrent: true }]);
  });

  it('ends a term at the free lock where the browser cannot list its locks', async () => {
    const locks = new FakeLockManager();
    const ended: TermId[] = [];
    const { logger } = recordingLogger();
    const withoutQuery = locks.forContext('watcher');
    const terms = new OwnerTerms({
      // A browser without `locks.query()` cannot tell a clean end from a crash.
      locks: { request: withoutQuery.request.bind(withoutQuery) },
      configName: CONFIG,
      logger: new ScopedLogger(logger, {}),
      onEnded: (term) => ended.push(term),
    });
    const holder = await holdTerm(locks, 'owner', FIRST);
    observe(terms, FIRST, () => undefined);
    await flushMicrotasks();

    holder.sayGoodbye();
    holder.letGo();
    await flushMicrotasks();

    expect(ended).toEqual(['t1']);
  });

  it('checks a claim of the term that holds the port after a flood of invented ones', async () => {
    const { terms, locks, records } = createTerms();
    await holdTerm(locks, 'owner', FIRST);
    const apply = applied();

    // More invented terms than are checked at once, posted before the browser can answer about any
    // of them, and then the claim of the term that really holds the port.
    for (let index = 0; index < 4 * MAX_TERM_FLOOD; index += 1) {
      observe(terms, claimOf(`t-invented-${String(index)}`), () => undefined);
    }
    observe(terms, FIRST, apply.run);
    await flushMicrotasks();

    expect(apply.count()).toBe(1);
    expect(terms.current).toBe('t1');
    expect(fieldsOfEvent(records, 'session.term-flood')).toHaveLength(1);
  });

  it('checks a term again after a lock request the browser would not answer', async () => {
    const locks = new FakeLockManager();
    const ended: TermId[] = [];
    const { logger, records } = recordingLogger();
    const answering = locks.forContext('watcher');
    let refusals = 1;
    const terms = new OwnerTerms({
      locks: {
        request: async (name, options, callback) => {
          if (refusals > 0) {
            refusals -= 1;
            throw new Error('locks are refused in this context');
          }
          return await answering.request(name, options, callback);
        },
      },
      configName: CONFIG,
      logger: new ScopedLogger(logger, {}),
      onEnded: (term) => ended.push(term),
    });
    await holdTerm(locks, 'owner', FIRST);
    const apply = applied();

    observe(terms, FIRST, apply.run);
    await flushMicrotasks();

    expect(apply.count()).toBe(0);
    expect(fieldsOfEvent(records, 'session.term-check-failed')).toHaveLength(1);

    // A refused request says nothing about the term, so nothing is remembered about it: the next
    // message naming it is checked afresh, rather than the tab ignoring the term that holds the
    // port until it next changes hands.
    observe(terms, FIRST, apply.run);
    await flushMicrotasks();

    expect(apply.count()).toBe(1);
    expect(terms.current).toBe('t1');
    expect(speaksForATerm(terms, HOLDER)).toBe(true);
  });

  it('remembers a bounded number of terms, forgetting the ones that are over first', async () => {
    const { terms, locks } = createTerms();
    for (let index = 0; index <= MAX_TERM_FLOOD; index += 1) {
      const claim = claimOf(`t-${String(index)}`);
      await holdTerm(locks, `owner-${String(index)}`, claim);
      observe(terms, claim, () => undefined);
      await flushMicrotasks();
      locks.killContext(`owner-${String(index)}`);
      await flushMicrotasks();
    }

    // The oldest term is forgotten, so a message naming it is checked afresh rather than answered
    // from a record that grows for the life of the tab.
    expect(terms.isEnded(claimOf('t-0').term)).toBe(false);
    expect(terms.isEnded(claimOf(`t-${String(MAX_TERM_FLOOD)}`).term)).toBe(true);
  });

  it('checks a bounded number of invented terms at once, and logs the flood once', async () => {
    const { terms, records } = createTerms();
    const apply = applied();

    for (let index = 0; index < MAX_TERM_FLOOD + 4; index += 1) {
      observe(terms, claimOf(`t-invented-${String(index)}`), apply.run);
    }
    await flushMicrotasks();

    expect(apply.count()).toBe(0);
    expect(fieldsOfEvent(records, 'session.term-flood')).toHaveLength(1);
  });

  it('withdraws every outstanding request when the configuration goes away', async () => {
    const { terms, locks, ended } = createTerms();
    await holdTerm(locks, 'owner', FIRST);
    observe(terms, FIRST, () => undefined);
    await flushMicrotasks();
    expect(locks.queueLength(termLockName(CONFIG, 't1', HOLDER, Number.POSITIVE_INFINITY))).toBe(1);

    terms.dispose();
    await flushMicrotasks();

    expect(locks.queueLength(termLockName(CONFIG, 't1', HOLDER, Number.POSITIVE_INFINITY))).toBe(0);
    locks.killContext('owner');
    await flushMicrotasks();
    expect(ended).toEqual([]);
  });
});
