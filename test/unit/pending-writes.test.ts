import { describe, expect, it } from 'vitest';

import { PendingWrites, type PendingWriteHost } from '../../src/client/pending-writes.js';
import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import { SerialBrokerError } from '../../src/core/errors.js';
import type { RequestId, TermId } from '../../src/protocol/messages.js';
import { FakeClock } from '../harness/fake-clock.js';

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
  setConnected(connected: boolean): void;
  /** The term of the tab holding the port, as far as the tracker is told. */
  setCurrentTerm(value: TermId | undefined): void;
  /** Ends a term, as its `owner-released` or the grace period does. */
  endTerm(value: TermId): void;
}

function createHarness(options: { connected?: boolean; writeTimeoutMs?: number } = {}): Harness {
  const clock = new FakeClock();
  const dispatched: string[] = [];
  let connected = options.connected ?? true;
  let current: TermId | undefined = FIRST;
  const ended = new Set<TermId>();

  const host: PendingWriteHost = {
    clock,
    configName: 'Reader',
    writeTimeoutMs: options.writeTimeoutMs ?? 5_000,
    dispatch: (requestId, _payload, to) => dispatched.push(`${requestId}@${to}`),
    canDispatch: () => connected,
    currentTerm: () => current,
    isTermEnded: (value) => ended.has(value),
  };
  const writes = new PendingWrites(host);

  return {
    writes,
    clock,
    dispatched,
    setConnected: (value) => {
      connected = value;
    },
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

/** Attaches a handler immediately, so a later rejection is never unhandled. */
function outcomeOf(promise: Promise<void>): Promise<unknown> {
  return promise.then(
    () => 'resolved',
    (error: unknown) => error,
  );
}

const notConnected = (): SerialBrokerError =>
  new SerialBrokerError(SerialBrokerErrorCode.NOT_CONNECTED, 'not here');

/**
 * The delivery guarantee of ADR-0013, in isolation.
 *
 * Every test here answers one question: *may this command be sent again?* Getting it wrong in
 * one direction loses a command; getting it wrong in the other executes it twice, and for a
 * device that cuts, dispenses or moves something, twice is materially worse than zero times.
 * A write belongs to the term it was handed to, and only that term ending decides it (ADR-0026).
 */
describe('PendingWrites', () => {
  it('dispatches immediately to the current term when there is a connection', async () => {
    const { writes, dispatched } = createHarness();

    const outcome = outcomeOf(writes.add(id('w1'), PAYLOAD));
    writes.settle(id('w1'), undefined);

    expect(dispatched).toEqual(['w1@t1']);
    expect(await outcome).toBe('resolved');
  });

  it('holds a write while there is nothing to write to', () => {
    const { writes, dispatched } = createHarness({ connected: false });

    void outcomeOf(writes.add(id('w1'), PAYLOAD));

    // Failing here would make `send()` unusable in the seconds after a page loads, while the
    // port is still opening.
    expect(dispatched).toEqual([]);
    expect(writes.size).toBe(1);
  });

  it('holds a write while no tab is known to hold the port', () => {
    const harness = createHarness();
    harness.setCurrentTerm(undefined);

    void outcomeOf(harness.writes.add(id('w1'), PAYLOAD));

    expect(harness.dispatched).toEqual([]);
  });

  it('dispatches what was waiting once a connection appears', () => {
    const harness = createHarness({ connected: false });
    void outcomeOf(harness.writes.add(id('w1'), PAYLOAD));
    void outcomeOf(harness.writes.add(id('w2'), PAYLOAD));

    harness.setConnected(true);
    harness.writes.dispatchWaiting();

    expect(harness.dispatched).toEqual(['w1@t1', 'w2@t1']);
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

  it('never hands on a write that had already started', async () => {
    const harness = createHarness();
    const outcome = outcomeOf(harness.writes.add(id('w1'), PAYLOAD));

    harness.writes.markStarted(id('w1'), FIRST);
    harness.setCurrentTerm(SECOND);
    harness.endTerm(FIRST);

    expect(harness.dispatched).toEqual(['w1@t1']);
    expect(await outcome).toMatchObject({
      code: SerialBrokerErrorCode.OWNER_LOST_DURING_WRITE,
    });
  });

  it('settles a started write with the result its term reports after a new owner claimed', async () => {
    const harness = createHarness();
    const outcome = outcomeOf(harness.writes.add(id('w1'), PAYLOAD));
    harness.writes.markStarted(id('w1'), FIRST);

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
    harness.writes.markStarted(id('w1'), FIRST);

    harness.endTerm(term('t0'));
    await Promise.resolve();

    expect(outcome).toBe('pending');
  });

  it('tells the caller that repeating a lost write is their decision', async () => {
    const harness = createHarness();
    const outcome = outcomeOf(harness.writes.add(id('w1'), PAYLOAD));

    harness.writes.markStarted(id('w1'), FIRST);
    harness.endTerm(FIRST);

    expect((await outcome) as SerialBrokerError).toBeInstanceOf(SerialBrokerError);
    expect(((await outcome) as SerialBrokerError).remediation).toContain('idempotent');
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

  it('never dispatches again a write that had started, whoever declines it', () => {
    const harness = createHarness();
    void outcomeOf(harness.writes.add(id('w1'), PAYLOAD));
    harness.writes.markStarted(id('w1'), FIRST);

    harness.writes.handleResult(id('w1'), FIRST, notConnected());
    harness.writes.resendUnstarted();

    expect(harness.dispatched).toEqual(['w1@t1']);
  });

  it('takes a decline for a request it does not know as nothing', () => {
    const harness = createHarness();

    expect(() => {
      harness.writes.handleResult(id('never-seen'), FIRST, notConnected());
    }).not.toThrow();
    expect(harness.dispatched).toEqual([]);
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

  it('fails a write that never finds a connection, within the deadline', async () => {
    const harness = createHarness({ connected: false, writeTimeoutMs: 1_000 });
    const outcome = outcomeOf(harness.writes.add(id('w1'), PAYLOAD));

    await harness.clock.advance(1_000);

    expect(await outcome).toMatchObject({ code: SerialBrokerErrorCode.WRITE_TIMEOUT });
    expect(harness.writes.size).toBe(0);
    expect(harness.clock.pendingTimerCount).toBe(0);
  });

  it('says in the timeout whether the write had started', async () => {
    const harness = createHarness({ writeTimeoutMs: 1_000 });
    const outcome = outcomeOf(harness.writes.add(id('w1'), PAYLOAD));
    harness.writes.markStarted(id('w1'), FIRST);

    await harness.clock.advance(1_000);

    // The difference between "it never left" and "it may have been executed" is the whole
    // question for the caller, so the timeout has to carry it too.
    expect((await outcome) as SerialBrokerError).toMatchObject({
      context: { started: true, byteLength: 3 },
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

  it('ignores settling a request it does not know', () => {
    const harness = createHarness();

    expect(() => {
      harness.writes.settle(id('never-seen'), undefined);
    }).not.toThrow();
  });

  it('marking an unknown request as started is harmless', () => {
    const harness = createHarness();

    expect(() => {
      harness.writes.markStarted(id('never-seen'), FIRST);
    }).not.toThrow();
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
    harness.writes.markStarted(id('w1'), FIRST);

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
