import { describe, expect, it } from 'vitest';

import { TabSlot } from '../../src/client/tab-slot.js';
import { NOOP_LOGGER, ScopedLogger } from '../../src/core/logger.js';
import { FakeClock, flushMicrotasks } from '../harness/fake-clock.js';
import { FakeLockManager } from '../harness/fake-locks.js';

/**
 * The places a tab limit consists of (ADR-0025), against the fake Web Locks every other ownership
 * test relies on.
 */

function tabs(maxTabs: number, count: number) {
  const locks = new FakeLockManager();
  const clock = new FakeClock();
  const admitted: string[] = [];
  const slots = Array.from({ length: count }, (_, index) => {
    const id = `tab${String(index + 1)}`;
    return {
      id,
      slot: new TabSlot(
        locks.forContext(id),
        'Reader',
        maxTabs,
        () => admitted.push(id),
        new ScopedLogger(NOOP_LOGGER, {}),
        clock,
      ),
    };
  });
  return { locks, admitted, slots };
}

async function settle(): Promise<void> {
  await flushMicrotasks(20);
}

describe('a tab limit', () => {
  it('admits one tab when the limit is one, and the next when it lets go', async () => {
    const { admitted, slots } = tabs(1, 2);

    for (const { slot } of slots) {
      slot.start();
    }
    await settle();
    expect(admitted).toEqual(['tab1']);

    slots[0]?.slot.stop();
    await settle();
    expect(admitted).toEqual(['tab1', 'tab2']);
    expect(slots[1]?.slot.isHeld).toBe(true);
  });

  it('admits as many tabs as the limit, and the waiting ones in the order they arrived', async () => {
    const { admitted, slots } = tabs(2, 5);

    for (const { slot } of slots) {
      slot.start();
    }
    await settle();
    expect(admitted).toEqual(['tab1', 'tab2']);

    slots[1]?.slot.stop();
    await settle();
    slots[0]?.slot.stop();
    await settle();

    expect(admitted).toEqual(['tab1', 'tab2', 'tab3', 'tab4']);
  });

  it('frees the place of a tab that dies', async () => {
    const { locks, admitted, slots } = tabs(1, 2);

    for (const { slot } of slots) {
      slot.start();
    }
    await settle();
    locks.killContext('tab1');
    await settle();

    expect(admitted).toEqual(['tab1', 'tab2']);
  });

  it('lets a waiting tab leave without holding up the tabs behind it', async () => {
    const { admitted, slots } = tabs(1, 3);

    for (const { slot } of slots) {
      slot.start();
    }
    await settle();
    // The second tab holds the gate, waiting for the place; the third waits at the gate.
    slots[1]?.slot.stop();
    await settle();
    slots[0]?.slot.stop();
    await settle();

    expect(admitted).toEqual(['tab1', 'tab3']);
  });

  it('does nothing more once stopped, and gives no place to a tab stopped before it is admitted', async () => {
    const { admitted, slots } = tabs(1, 2);

    slots[0]?.slot.start();
    slots[0]?.slot.stop();
    slots[0]?.slot.start();
    slots[1]?.slot.start();
    await settle();

    expect(admitted).toEqual(['tab2']);
  });

  it('does not queue again for a refused request once it has let go', async () => {
    const clock = new FakeClock();
    let refuse: (error: Error) => void = () => undefined;
    const slot = new TabSlot(
      {
        request: () =>
          new Promise((_, reject) => {
            refuse = reject;
          }),
      },
      'Reader',
      1,
      () => undefined,
      new ScopedLogger(NOOP_LOGGER, {}),
      clock,
    );

    slot.start();
    slot.stop();
    // The browser refuses the request, for a reason of its own, after the tab let go.
    refuse(new Error('The request was refused'));
    await settle();

    expect(clock.pendingTimerCount).toBe(0);
  });
});
