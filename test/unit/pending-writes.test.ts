import { describe, expect, it } from 'vitest';

import {
  LATE_DEADLINE_MS,
  PendingWrites,
  scheduleDeadline,
  type PendingWriteHost,
} from '../../src/client/pending-writes.js';
import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import { SerialBrokerError } from '../../src/core/errors.js';
import type { RequestId, TermId } from '../../src/protocol/messages.js';
import { FakeClock, flushMicrotasks } from '../harness/fake-clock.js';
import { outcomeOf } from '../harness/outcomes.js';

const PAYLOAD = new Uint8Array([1, 2, 3]);

const id = (value: string): RequestId => value as RequestId;
const term = (value: string): TermId => value as TermId;

const FIRST = term('t1');
const SECOND = term('t2');

interface Harness {
  readonly writes: PendingWrites;
  readonly clock: FakeClock;
  /** Every request handed out for sending, in order, with its term. A repeat here is a repeated command. */
  readonly dispatched: string[];
  /** The term of the tab holding the port, as far as the tracker is told. */
  setCurrentTerm(value: TermId | undefined): void;
  /** Ends a term, as its lock being freed does. */
  endTerm(value: TermId): void;
}

/**
 * A tracker whose port is open. Holding a write while it is not, and failing it at the deadline, is
 * pinned through `send()` in the integration suite (failover.test.ts, diagnostics.test.ts).
 */
function createHarness(options: { writeTimeoutMs?: number } = {}): Harness {
  const clock = new FakeClock();
  const dispatched: string[] = [];
  let current: TermId | undefined = FIRST;
  const ended = new Set<TermId>();

  const host: PendingWriteHost = {
    clock,
    configName: 'Reader',
    writeTimeoutMs: options.writeTimeoutMs ?? 5_000,
    dispatch: (requestId, _payload, to) => {
      dispatched.push(`${requestId}@${to}`);
    },
    canDispatch: () => true,
    currentTerm: () => current,
    isTermEnded: (value) => ended.has(value),
  };
  const writes = new PendingWrites(host);

  return {
    writes,
    clock,
    dispatched,
    setCurrentTerm: (value) => {
      current = value;
    },
    endTerm: (value) => {
      ended.add(value);
      if (current === value) {
        current = undefined;
      }
      writes.handleTermEnded(value);
    },
  };
}

const notConnected = (): SerialBrokerError =>
  new SerialBrokerError(SerialBrokerErrorCode.NOT_CONNECTED, 'not here');

/**
 * The delivery guarantee of ADR-0013, in isolation.
 *
 * Every test here answers one question: *may this command be sent again?* Getting it wrong in
 * one direction loses a command; getting it wrong in the other executes it twice, and for a
 * device that cuts, dispenses or moves something, twice is materially worse than zero times.
 * A write belongs to the term it was handed to, and only that term ending decides it (ADR-0030).
 * No term begins it without this tracker's approval, which is what makes `started: false` true.
 */
describe('PendingWrites', () => {
  it('dispatches immediately to the current term when there is a connection', async () => {
    const { writes, dispatched } = createHarness();

    const outcome = outcomeOf(writes.add(id('w1'), PAYLOAD));
    writes.settle(id('w1'), undefined);

    expect(dispatched).toEqual(['w1@t1']);
    expect(await outcome).toBe('resolved');
  });

  it('holds a write while no tab is known to hold the port', () => {
    const harness = createHarness();
    harness.setCurrentTerm(undefined);

    void outcomeOf(harness.writes.add(id('w1'), PAYLOAD));

    expect(harness.dispatched).toEqual([]);
  });

  it('does not dispatch the same request twice while it is outstanding', () => {
    const harness = createHarness();
    void outcomeOf(harness.writes.add(id('w1'), PAYLOAD));

    harness.writes.dispatchWaiting();
    harness.writes.dispatchWaiting();

    // The owner has not answered yet. Sending again would put the same command in its queue
    // a second time.
    expect(harness.dispatched).toEqual(['w1@t1']);
  });

  it('keeps a write with its term when a new owner claims the port, until that term ends', () => {
    const harness = createHarness();
    void outcomeOf(harness.writes.add(id('w1'), PAYLOAD));

    // The claim proves the former owner let go of the lock, not that its word about this write
    // has arrived. It may have written it.
    harness.setCurrentTerm(SECOND);
    harness.writes.dispatchWaiting();
    expect(harness.dispatched).toEqual(['w1@t1']);

    harness.endTerm(FIRST);

    // The bytes demonstrably never reached the device, and the only term that could write them is
    // over. Delivering to the successor is not a repeat.
    expect(harness.dispatched).toEqual(['w1@t1', 'w1@t2']);
  });

  it('settles a started write with the result its term reports after a new owner claimed', async () => {
    const harness = createHarness();
    const outcome = outcomeOf(harness.writes.add(id('w1'), PAYLOAD));
    expect(harness.writes.approve(id('w1'), FIRST)).toBe(true);

    harness.setCurrentTerm(SECOND);
    harness.writes.dispatchWaiting();
    harness.writes.handleResult(id('w1'), FIRST, undefined);
    harness.endTerm(FIRST);

    expect(await outcome).toBe('resolved');
    expect(harness.dispatched).toEqual(['w1@t1']);
  });

  it('fails a started write only when its own term ends, not another', async () => {
    const harness = createHarness();
    let outcome: unknown = 'pending';
    void outcomeOf(harness.writes.add(id('w1'), PAYLOAD)).then((value) => (outcome = value));
    harness.writes.approve(id('w1'), FIRST);

    harness.endTerm(term('t0'));
    await Promise.resolve();

    expect(outcome).toBe('pending');
  });

  it('lets only the term it was addressed to begin a write', async () => {
    const harness = createHarness();
    let outcome: unknown = 'pending';
    void outcomeOf(harness.writes.add(id('w1'), PAYLOAD)).then((value) => (outcome = value));

    // Asked by a tab that was never asked to write it. Approving would tie the write to a term that
    // is not writing it, and lose it when that term ends (ADR-0030).
    expect(harness.writes.approve(id('w1'), SECOND)).toBe(false);
    harness.endTerm(SECOND);
    await flushMicrotasks();

    expect(outcome).toBe('pending');
    expect(harness.dispatched).toEqual(['w1@t1']);
  });

  it('ignores an outcome from a term the write was not addressed to', async () => {
    const harness = createHarness();
    let outcome: unknown = 'pending';
    void outcomeOf(harness.writes.add(id('w1'), PAYLOAD)).then((value) => (outcome = value));

    // Only the term that was asked to write it can say how it went; anyone else read the request
    // id off the bus (ADR-0030).
    harness.writes.handleResult(id('w1'), SECOND, undefined);
    harness.writes.handleResult(id('w1'), undefined, undefined);
    await flushMicrotasks();

    expect(outcome).toBe('pending');
    expect(harness.writes.size).toBe(1);
  });

  it('dispatches again a write its own term declined', () => {
    const harness = createHarness();
    void outcomeOf(harness.writes.add(id('w1'), PAYLOAD));

    harness.writes.handleResult(id('w1'), FIRST, notConnected());

    expect(harness.dispatched).toEqual(['w1@t1', 'w1@t1']);
  });

  it('ignores a decline from a term the write was not addressed to', () => {
    const harness = createHarness();
    void outcomeOf(harness.writes.add(id('w1'), PAYLOAD));

    // A copy reached the wrong tab. The term it was meant for may be writing it.
    harness.setCurrentTerm(SECOND);
    harness.writes.handleResult(id('w1'), SECOND, notConnected());
    harness.writes.handleResult(id('w1'), undefined, notConnected());

    expect(harness.dispatched).toEqual(['w1@t1']);
  });

  it('never dispatches again a write it let begin, unless that term says it did not begin it', () => {
    const harness = createHarness();
    void outcomeOf(harness.writes.add(id('w1'), PAYLOAD));
    harness.writes.approve(id('w1'), FIRST);

    harness.writes.resendUnstarted();
    harness.writes.dispatchWaiting();
    expect(harness.dispatched).toEqual(['w1@t1']);

    // The port closed between the approval and the first byte: that term did not begin it, and the
    // next attempt has to be approved again.
    harness.writes.handleResult(id('w1'), FIRST, notConnected());
    expect(harness.dispatched).toEqual(['w1@t1', 'w1@t1']);
    expect(harness.writes.diagnostics().started).toBe(0);
  });

  it('resends an unstarted write to its own term, but not past a term that has not ended', () => {
    const harness = createHarness();
    void outcomeOf(harness.writes.add(id('w1'), PAYLOAD));

    harness.writes.resendUnstarted();
    expect(harness.dispatched).toEqual(['w1@t1', 'w1@t1']);

    harness.setCurrentTerm(SECOND);
    harness.writes.resendUnstarted();
    expect(harness.dispatched).toEqual(['w1@t1', 'w1@t1']);
  });

  it('says in the timeout whether the write had started', async () => {
    const harness = createHarness({ writeTimeoutMs: 1_000 });
    const outcome = outcomeOf(harness.writes.add(id('w1'), PAYLOAD));
    harness.writes.approve(id('w1'), FIRST);

    await harness.clock.advance(1_000);

    // The difference between "it never left" and "it may have been executed" is the whole
    // question for the caller, so the timeout has to carry it too.
    expect((await outcome) as SerialBrokerError).toMatchObject({
      context: { started: true, byteLength: 3 },
    });
  });

  it('lets no term begin a write once its deadline has said it did not start (ADR-0013)', async () => {
    const harness = createHarness({ writeTimeoutMs: 1_000 });
    const outcome = outcomeOf(harness.writes.add(id('w1'), PAYLOAD));

    await harness.clock.advance(1_000);

    expect(await outcome).toMatchObject({
      code: SerialBrokerErrorCode.WRITE_TIMEOUT,
      context: { started: false },
    });
    expect(harness.writes.approve(id('w1'), FIRST)).toBe(false);
  });

  it('lets a write begin up to its deadline, and then never says it did not start', async () => {
    const harness = createHarness({ writeTimeoutMs: 1_000 });
    const outcome = outcomeOf(harness.writes.add(id('w1'), PAYLOAD));

    await harness.clock.advance(999);
    expect(harness.writes.approve(id('w1'), FIRST)).toBe(true);
    await harness.clock.advance(1);

    expect(await outcome).toMatchObject({
      code: SerialBrokerErrorCode.WRITE_TIMEOUT,
      context: { started: true },
    });
  });

  it('cancels the deadline when a write settles', async () => {
    const harness = createHarness();
    const outcome = outcomeOf(harness.writes.add(id('w1'), PAYLOAD));

    harness.writes.settle(id('w1'), undefined);

    expect(await outcome).toBe('resolved');
    expect(harness.clock.pendingTimerCount).toBe(0);
  });

  it('ignores settling a request twice', async () => {
    const harness = createHarness();
    const outcome = outcomeOf(harness.writes.add(id('w1'), PAYLOAD));

    harness.writes.settle(id('w1'), undefined);
    harness.writes.settle(
      id('w1'),
      new SerialBrokerError(SerialBrokerErrorCode.WRITE_FAILED, 'too late'),
    );

    expect(await outcome).toBe('resolved');
  });

  it('takes a result, a question or a settlement of a request it does not know as nothing', () => {
    const harness = createHarness();

    expect(() => {
      harness.writes.handleResult(id('never-seen'), FIRST, notConnected());
      expect(harness.writes.approve(id('never-seen'), FIRST)).toBe(false);
      harness.writes.settle(id('never-seen'), undefined);
    }).not.toThrow();
    expect(harness.dispatched).toEqual([]);
  });

  it('fails everything outstanding at once, and clears its timers', async () => {
    const harness = createHarness();
    const first = outcomeOf(harness.writes.add(id('w1'), PAYLOAD));
    const second = outcomeOf(harness.writes.add(id('w2'), PAYLOAD));

    harness.writes.failAll(
      new SerialBrokerError(SerialBrokerErrorCode.CONFIGURATION_RELEASED, 'released'),
    );

    expect(await first).toMatchObject({ code: SerialBrokerErrorCode.CONFIGURATION_RELEASED });
    expect(await second).toMatchObject({ code: SerialBrokerErrorCode.CONFIGURATION_RELEASED });
    expect(harness.writes.size).toBe(0);
    expect(harness.clock.pendingTimerCount).toBe(0);
    // Released: no term may begin them any more.
    expect(harness.writes.approve(id('w1'), FIRST)).toBe(false);
  });

  it('keeps writes from several callers apart', async () => {
    const harness = createHarness();
    const first = outcomeOf(harness.writes.add(id('w1'), PAYLOAD));
    const second = outcomeOf(harness.writes.add(id('w2'), PAYLOAD));

    harness.writes.settle(id('w1'), undefined);
    harness.writes.settle(
      id('w2'),
      new SerialBrokerError(SerialBrokerErrorCode.WRITE_FAILED, 'the device refused'),
    );

    expect(await first).toBe('resolved');
    expect(await second).toMatchObject({ code: SerialBrokerErrorCode.WRITE_FAILED });
  });

  it('resolves a mixture of started and unstarted writes correctly when a term ends', async () => {
    const harness = createHarness();
    const started = outcomeOf(harness.writes.add(id('w1'), PAYLOAD));
    const waiting = outcomeOf(harness.writes.add(id('w2'), PAYLOAD));
    harness.writes.approve(id('w1'), FIRST);

    harness.setCurrentTerm(SECOND);
    harness.endTerm(FIRST);

    // One is undecidable and fails; the other demonstrably never left and is handed on. Both
    // rules apply in the same instant, to the same configuration.
    expect(await started).toMatchObject({
      code: SerialBrokerErrorCode.OWNER_LOST_DURING_WRITE,
    });
    expect(harness.dispatched).toEqual(['w1@t1', 'w2@t1', 'w2@t2']);
    harness.writes.settle(id('w2'), undefined);
    expect(await waiting).toBe('resolved');
  });
});

/**
 * A deadline that runs late lets the tasks already queued run before it decides. Another timer due
 * at the same moment, scheduled after the deadline, stands in for such a task: the browser runs it
 * before a timer scheduled later still.
 */
describe('scheduleDeadline', () => {
  /**
   * Runs a deadline due in 100 ms `lateMs` late: the clock stalls past the due time, as a frozen or
   * throttled tab does, and the timers run when it comes back.
   */
  async function race(clock: FakeClock, lateMs: number): Promise<string[]> {
    const order: string[] = [];
    scheduleDeadline(clock, () => order.push('deadline'), 100);
    clock.setTimer(() => order.push('queued task'), 100);
    await clock.stall(100 + lateMs);
    await clock.advance(0);
    return order;
  }

  it('decides at once when it runs on time', async () => {
    expect(await race(new FakeClock(), 0)).toEqual(['deadline', 'queued task']);
  });

  it('decides at once when it runs a little late, as a hidden tab`s aligned timers do', async () => {
    expect(await race(new FakeClock(), LATE_DEADLINE_MS - 1)).toEqual(['deadline', 'queued task']);
  });

  it('lets the tasks already queued run first when it runs late', async () => {
    expect(await race(new FakeClock(), LATE_DEADLINE_MS)).toEqual(['queued task', 'deadline']);
  });

  it('is unmoved by the system clock being set forward, which makes no timer late', async () => {
    const clock = new FakeClock();
    const order: string[] = [];
    scheduleDeadline(clock, () => order.push('deadline'), 100);
    clock.setTimer(() => order.push('queued task'), 100);
    clock.jumpWallClock(10 * LATE_DEADLINE_MS);

    await clock.advance(100);

    // Lateness is measured on the monotonic clock (ADR-0014): a punctual deadline stays punctual.
    expect(order).toEqual(['deadline', 'queued task']);
    expect(clock.pendingTimerCount).toBe(0);
  });

  it('yields only once, however late it is', async () => {
    const clock = new FakeClock();
    let expired = 0;
    scheduleDeadline(clock, () => (expired += 1), 100);

    await clock.stall(100 + 10 * LATE_DEADLINE_MS);
    await clock.advance(0);

    expect(expired).toBe(1);
    expect(clock.pendingTimerCount).toBe(0);
  });

  it('does not expire when cancelled while it yields', async () => {
    const clock = new FakeClock();
    let expired = false;
    const deadline = scheduleDeadline(clock, () => (expired = true), 100);
    clock.setTimer(() => {
      deadline.cancel();
    }, 100);

    await clock.stall(100 + LATE_DEADLINE_MS);
    await clock.advance(0);

    expect(expired).toBe(false);
    expect(clock.pendingTimerCount).toBe(0);
  });
});
