import { describe, expect, it } from 'vitest';

import {
  FORMER_OWNER_GRACE_MS,
  MAX_REMEMBERED_TERMS,
  OwnerTerms,
} from '../../src/client/owner-terms.js';
import type { TermId } from '../../src/protocol/messages.js';
import { FakeClock } from '../harness/fake-clock.js';

const term = (value: string): TermId => value as TermId;

function createTerms(): { terms: OwnerTerms; clock: FakeClock; ended: TermId[] } {
  const clock = new FakeClock();
  const ended: TermId[] = [];
  const terms = new OwnerTerms({ clock, onEnded: (value) => ended.push(value) });
  return { terms, clock, ended };
}

/**
 * What one tab knows about the terms of holding a port (ADR-0026): a term ends when its goodbye
 * arrives, or once it has been succeeded and silent for the grace period - never merely because a
 * successor claimed the port.
 */
describe('OwnerTerms', () => {
  it('takes the term of a claim or a status as the one holding the port', () => {
    const { terms } = createTerms();

    expect(terms.observe(term('t1'))).toBe(true);

    expect(terms.current).toBe('t1');
  });

  it('does not end a term because a successor claimed the port', () => {
    const { terms, ended } = createTerms();
    terms.observe(term('t1'));

    terms.observe(term('t2'));

    expect(terms.current).toBe('t2');
    expect(terms.isEnded(term('t1'))).toBe(false);
    expect(ended).toEqual([]);
  });

  it('ends a term at once when its goodbye arrives, and forgets it as the current one', () => {
    const { terms, ended } = createTerms();
    terms.observe(term('t1'));

    terms.end(term('t1'));

    expect(terms.isEnded(term('t1'))).toBe(true);
    expect(terms.current).toBeUndefined();
    expect(ended).toEqual(['t1']);
  });

  it('ends a succeeded term that stays silent for the grace period', async () => {
    const { terms, clock, ended } = createTerms();
    terms.observe(term('t1'));
    terms.observe(term('t2'));

    await clock.advance(FORMER_OWNER_GRACE_MS - 1);
    expect(ended).toEqual([]);
    await clock.advance(1);

    expect(ended).toEqual(['t1']);
  });

  it('waits afresh for a succeeded term that is still heard from', async () => {
    const { terms, clock, ended } = createTerms();
    terms.observe(term('t1'));
    terms.observe(term('t2'));

    await clock.advance(FORMER_OWNER_GRACE_MS - 1);
    terms.heard(term('t1'));
    await clock.advance(FORMER_OWNER_GRACE_MS - 1);
    expect(ended).toEqual([]);
    await clock.advance(1);

    expect(ended).toEqual(['t1']);
  });

  it('ends a term once, whether its goodbye or the grace period comes first', async () => {
    const { terms, clock, ended } = createTerms();
    terms.observe(term('t1'));
    terms.observe(term('t2'));

    terms.end(term('t1'));
    terms.end(term('t1'));
    await clock.advance(FORMER_OWNER_GRACE_MS);

    expect(ended).toEqual(['t1']);
    expect(clock.pendingTimerCount).toBe(0);
  });

  it('refuses a late claim or status of a term that has ended or been succeeded', () => {
    const { terms } = createTerms();
    terms.observe(term('t1'));
    terms.observe(term('t2'));
    terms.end(term('t2'));

    expect(terms.observe(term('t1'))).toBe(false);
    expect(terms.observe(term('t2'))).toBe(false);
    expect(terms.current).toBeUndefined();
  });

  it('stops waiting when the configuration goes away', () => {
    const { terms, clock } = createTerms();
    terms.observe(term('t1'));
    terms.observe(term('t2'));

    terms.dispose();

    expect(clock.pendingTimerCount).toBe(0);
  });

  it('remembers a bounded number of past terms', () => {
    const { terms } = createTerms();
    for (let index = 0; index <= MAX_REMEMBERED_TERMS; index += 1) {
      terms.end(term(`t${String(index)}`));
    }

    expect(terms.isEnded(term('t0'))).toBe(false);
    expect(terms.isEnded(term(`t${String(MAX_REMEMBERED_TERMS)}`))).toBe(true);
  });
});
