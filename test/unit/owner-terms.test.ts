import { describe, expect, it } from 'vitest';

import {
  MAX_TERMS_BEING_CHECKED,
  OwnerTerms,
  type TermClaim,
} from '../../src/client/owner-terms.js';
import { ScopedLogger } from '../../src/core/logger.js';
import type { ClientId, TermId } from '../../src/protocol/messages.js';
import { termLockName } from '../../src/protocol/version.js';
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

    terms.observe(FIRST, apply.run);
    await flushMicrotasks();

    expect(terms.current).toBe('t1');
    expect(apply.count()).toBe(1);
  });

  it('refuses a claim naming a term nobody holds, and logs it once', async () => {
    const { terms, records } = createTerms();
    const apply = applied();

    terms.observe(FIRST, apply.run);
    terms.observe(claimOf('t-invented'), apply.run);
    await flushMicrotasks();

    expect(terms.current).toBeUndefined();
    expect(apply.count()).toBe(0);
    expect(fieldsOfEvent(records, 'session.term-not-held')).toHaveLength(1);
  });

  it('refuses a message naming another sender or another tab limit than the lock', async () => {
    const { terms, locks } = createTerms();
    await holdTerm(locks, 'owner', FIRST);
    const apply = applied();

    terms.observe(claimOf('t1', 'c-mallory' as ClientId), apply.run);
    terms.observe(claimOf('t1', HOLDER, 4), apply.run);
    await flushMicrotasks();

    expect(apply.count()).toBe(0);
    expect(terms.current).toBeUndefined();
  });

  it('keeps a live term when another claim arrives: nothing but its lock ends it', async () => {
    const { terms, locks, ended } = createTerms();
    await holdTerm(locks, 'owner', FIRST);
    await holdTerm(locks, 'other', SECOND);

    terms.observe(FIRST, () => undefined);
    await flushMicrotasks();
    terms.observe(SECOND, () => undefined);
    await flushMicrotasks();

    expect(terms.current).toBe('t2');
    expect(terms.isEnded(FIRST.term)).toBe(false);
    expect(ended).toEqual([]);
  });

  it('ignores a claim or status of a term another term has succeeded', async () => {
    const { terms, locks } = createTerms();
    await holdTerm(locks, 'owner', FIRST);
    await holdTerm(locks, 'other', SECOND);
    terms.observe(FIRST, () => undefined);
    await flushMicrotasks();
    terms.observe(SECOND, () => undefined);
    await flushMicrotasks();
    const apply = applied();

    terms.observe(FIRST, apply.run);
    await flushMicrotasks();

    expect(apply.count()).toBe(0);
    expect(terms.current).toBe('t2');
  });

  it('ends a term the moment the browser frees the lock of a tab that died', async () => {
    const { terms, locks, ended } = createTerms();
    await holdTerm(locks, 'owner', FIRST);
    terms.observe(FIRST, () => undefined);
    await flushMicrotasks();

    locks.killContext('owner');
    await flushMicrotasks();

    expect(ended).toEqual([{ term: 't1', wasCurrent: true }]);
    expect(terms.isEnded(FIRST.term)).toBe(true);
    expect(terms.current).toBeUndefined();
  });

  it('ends a term at its goodbye, once its holder has queued for the lock before saying it', async () => {
    const { terms, locks, ended } = createTerms();
    const holder = await holdTerm(locks, 'owner', FIRST);
    terms.observe(FIRST, () => undefined);
    await flushMicrotasks();

    holder.sayGoodbye();
    terms.heardReleased(FIRST.term, HOLDER);
    await flushMicrotasks();

    expect(ended).toEqual([{ term: 't1', wasCurrent: true }]);
  });

  it('does not end a live term at a goodbye nobody queued for', async () => {
    const { terms, locks, ended } = createTerms();
    await holdTerm(locks, 'owner', FIRST);
    terms.observe(FIRST, () => undefined);
    await flushMicrotasks();

    terms.heardReleased(FIRST.term, HOLDER);
    await flushMicrotasks();

    expect(ended).toEqual([]);
    expect(terms.current).toBe('t1');
  });

  it('does not end a term at a goodbye from anyone but its holder', async () => {
    const { terms, locks, ended } = createTerms();
    const holder = await holdTerm(locks, 'owner', FIRST);
    terms.observe(FIRST, () => undefined);
    await flushMicrotasks();

    holder.sayGoodbye();
    terms.heardReleased(FIRST.term, 'c-mallory' as ClientId);
    await flushMicrotasks();

    expect(ended).toEqual([]);
  });

  it('waits for the goodbye of a holder that let go cleanly, rather than ending at the free lock', async () => {
    const { terms, locks, ended } = createTerms();
    const holder = await holdTerm(locks, 'owner', FIRST);
    terms.observe(FIRST, () => undefined);
    await flushMicrotasks();

    // The order a tab letting go keeps: queue for the lock, say goodbye, let the lock go. The
    // goodbye is still on its way here.
    holder.sayGoodbye();
    holder.letGo();
    await flushMicrotasks();
    expect(ended).toEqual([]);

    terms.heardReleased(FIRST.term, HOLDER);
    await flushMicrotasks();

    expect(ended).toEqual([{ term: 't1', wasCurrent: true }]);
  });

  it('knows the senders of the term holding the port and of one still being waited for', async () => {
    const { terms, locks } = createTerms();
    await holdTerm(locks, 'owner', FIRST);
    const second = claimOf('t2', 'c-second' as ClientId);
    await holdTerm(locks, 'other', second);
    terms.observe(FIRST, () => undefined);
    await flushMicrotasks();
    terms.observe(second, () => undefined);
    await flushMicrotasks();

    expect(terms.isKnownSender(HOLDER)).toBe(true);
    expect(terms.isKnownSender('c-second' as ClientId)).toBe(true);
    expect(terms.isKnownSender('c-mallory' as ClientId)).toBe(false);
    expect(terms.isFrom(FIRST.term, HOLDER)).toBe(true);
    expect(terms.isFrom(FIRST.term, 'c-mallory' as ClientId)).toBe(false);
  });

  it('forgets the sender of a term that has ended', async () => {
    const { terms, locks } = createTerms();
    await holdTerm(locks, 'owner', FIRST);
    terms.observe(FIRST, () => undefined);
    await flushMicrotasks();
    locks.killContext('owner');
    await flushMicrotasks();

    expect(terms.isKnownSender(HOLDER)).toBe(false);
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

    terms.heardReleased(FIRST.term, HOLDER);
    await flushMicrotasks();

    expect(ended).toEqual([]);
  });

  it('checks a bounded number of invented terms at once, and logs the flood once', async () => {
    const { terms, records } = createTerms();
    const apply = applied();

    for (let index = 0; index < MAX_TERMS_BEING_CHECKED + 4; index += 1) {
      terms.observe(claimOf(`t-invented-${String(index)}`), apply.run);
    }
    await flushMicrotasks();

    expect(apply.count()).toBe(0);
    expect(fieldsOfEvent(records, 'session.term-flood')).toHaveLength(1);
  });

  it('withdraws every outstanding request when the configuration goes away', async () => {
    const { terms, locks, ended } = createTerms();
    await holdTerm(locks, 'owner', FIRST);
    terms.observe(FIRST, () => undefined);
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
