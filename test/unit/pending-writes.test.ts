import { describe, expect, it } from 'vitest';

import { PendingWrites, type PendingWriteHost } from '../../src/client/pending-writes.js';
import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import { SerialBrokerError } from '../../src/core/errors.js';
import type { RequestId } from '../../src/protocol/messages.js';
import { FakeClock } from '../harness/fake-clock.js';

const PAYLOAD = new Uint8Array([1, 2, 3]);

interface Harness {
  readonly writes: PendingWrites;
  readonly clock: FakeClock;
  /** Every request handed out for sending, in order. A repeat here is a repeated command. */
  readonly dispatched: RequestId[];
  setConnected(connected: boolean): void;
}

function createHarness(options: { connected?: boolean; writeTimeoutMs?: number } = {}): Harness {
  const clock = new FakeClock();
  const dispatched: RequestId[] = [];
  let connected = options.connected ?? true;

  const host: PendingWriteHost = {
    clock,
    configName: 'Reader',
    writeTimeoutMs: options.writeTimeoutMs ?? 5_000,
    dispatch: (requestId) => dispatched.push(requestId),
    canDispatch: () => connected,
  };

  return {
    writes: new PendingWrites(host),
    clock,
    dispatched,
    setConnected: (value) => {
      connected = value;
    },
  };
}

const id = (value: string): RequestId => value as RequestId;

/** Attaches a handler immediately, so a later rejection is never unhandled. */
function outcomeOf(promise: Promise<void>): Promise<unknown> {
  return promise.then(
    () => 'resolved',
    (error: unknown) => error,
  );
}

/**
 * The delivery guarantee of ADR-0013, in isolation.
 *
 * Every test here answers one question: *may this command be sent again?* Getting it wrong in
 * one direction loses a command; getting it wrong in the other executes it twice, and for a
 * device that cuts, dispenses or moves something, twice is materially worse than zero times.
 */
describe('PendingWrites', () => {
  it('dispatches immediately when there is a connection', async () => {
    const { writes, dispatched } = createHarness();

    const outcome = outcomeOf(writes.add(id('w1'), PAYLOAD));
    writes.settle(id('w1'), undefined);

    expect(dispatched).toEqual(['w1']);
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

  it('dispatches what was waiting once a connection appears', () => {
    const harness = createHarness({ connected: false });
    void outcomeOf(harness.writes.add(id('w1'), PAYLOAD));
    void outcomeOf(harness.writes.add(id('w2'), PAYLOAD));

    harness.setConnected(true);
    harness.writes.dispatchWaiting();

    expect(harness.dispatched).toEqual(['w1', 'w2']);
  });

  it('does not dispatch the same request twice while it is outstanding', () => {
    const harness = createHarness();
    void outcomeOf(harness.writes.add(id('w1'), PAYLOAD));

    harness.writes.dispatchWaiting();
    harness.writes.dispatchWaiting();

    // The owner has not answered yet. Sending again would put the same command in its queue
    // a second time.
    expect(harness.dispatched).toEqual(['w1']);
  });

  it('hands an unstarted write to the next owner, exactly once', () => {
    const harness = createHarness();
    void outcomeOf(harness.writes.add(id('w1'), PAYLOAD));

    harness.writes.handleOwnerChanged();

    // The bytes demonstrably never reached the device, and the context they were handed to is
    // gone. Delivering to the successor is not a repeat.
    expect(harness.dispatched).toEqual(['w1', 'w1']);
  });

  it('never hands on a write that had already started', async () => {
    const harness = createHarness();
    const outcome = outcomeOf(harness.writes.add(id('w1'), PAYLOAD));

    harness.writes.markStarted(id('w1'));
    harness.writes.handleOwnerChanged();

    expect(harness.dispatched).toEqual(['w1']);
    expect(await outcome).toMatchObject({
      code: SerialBrokerErrorCode.OWNER_LOST_DURING_WRITE,
    });
  });

  it('tells the caller that repeating a lost write is their decision', async () => {
    const harness = createHarness();
    const outcome = outcomeOf(harness.writes.add(id('w1'), PAYLOAD));

    harness.writes.markStarted(id('w1'));
    harness.writes.handleOwnerChanged();

    expect((await outcome) as SerialBrokerError).toBeInstanceOf(SerialBrokerError);
    expect(((await outcome) as SerialBrokerError).remediation).toContain('idempotent');
  });

  it('re-dispatches a write the owner declined, and reports that it did', () => {
    const harness = createHarness();
    void outcomeOf(harness.writes.add(id('w1'), PAYLOAD));

    expect(harness.writes.redispatch(id('w1'))).toBe(true);
    expect(harness.dispatched).toEqual(['w1', 'w1']);
  });

  it('refuses to re-dispatch a write that had started', () => {
    const harness = createHarness();
    void outcomeOf(harness.writes.add(id('w1'), PAYLOAD));
    harness.writes.markStarted(id('w1'));

    expect(harness.writes.redispatch(id('w1'))).toBe(false);
    expect(harness.dispatched).toEqual(['w1']);
  });

  it('refuses to re-dispatch a request it does not know', () => {
    const harness = createHarness();

    expect(harness.writes.redispatch(id('never-seen'))).toBe(false);
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
    harness.writes.markStarted(id('w1'));

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
      harness.writes.markStarted(id('never-seen'));
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

  it('resolves a mixture of started and unstarted writes correctly on an owner change', async () => {
    const harness = createHarness();
    const started = outcomeOf(harness.writes.add(id('w1'), PAYLOAD));
    const waiting = outcomeOf(harness.writes.add(id('w2'), PAYLOAD));
    harness.writes.markStarted(id('w1'));

    harness.writes.handleOwnerChanged();

    // One is undecidable and fails; the other demonstrably never left and is handed on. Both
    // rules apply in the same instant, to the same configuration.
    expect(await started).toMatchObject({
      code: SerialBrokerErrorCode.OWNER_LOST_DURING_WRITE,
    });
    expect(harness.dispatched).toEqual(['w1', 'w2', 'w2']);
    harness.writes.settle(id('w2'), undefined);
    expect(await waiting).toBe('resolved');
  });
});
