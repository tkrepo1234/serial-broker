import { describe, expect, it } from 'vitest';

import {
  SharedWorkerTransport,
  type WorkerLoadFailure,
  type WorkerStartup,
} from '../../src/client/transport/shared-worker-transport.js';
import type { Clock } from '../../src/core/clock.js';
import type { Logger } from '../../src/core/types.js';
import { HANDSHAKE_DEADLINE_MS } from '../../src/protocol/handshake.js';
import { BROKER_ID, type ClientId, type ProtocolMessage } from '../../src/protocol/messages.js';
import { PROTOCOL_VERSION, workerLockName } from '../../src/protocol/version.js';
import { flushMicrotasks, type FakeClock } from '../harness/fake-clock.js';
import type { FakeLockManager } from '../harness/fake-locks.js';
import { fieldsOfEvent, recordingLogger } from '../harness/recording-logger.js';
import {
  envelope,
  FakeMessagePort,
  holdLock,
  recordTransportRequest,
  type TransportRequestRecorder,
} from '../harness/transport-doubles.js';

const SELF = 'self' as ClientId;
const PEER = 'peer' as ClientId;

/** How long a hidden tab's timers can be held back: about one run a minute. */
const THROTTLED_TIMER_MS = 60_000;

/**
 * A port to a worker, which holds its lifetime lock while it runs and answers `hello` with a welcome
 * naming that lock (ADR-0041).
 *
 * A worker that does not answer never welcomes anyone. A worker of another protocol version answers
 * only `hello`, in its own version, and drops everything else (ADR-0008).
 */
class WorkerPort extends FakeMessagePort {
  constructor(
    private readonly locks: FakeLockManager,
    readonly workerId: string,
    readonly answers: boolean,
    readonly isOtherVersion: boolean,
  ) {
    super();
    if (answers && !isOtherVersion) {
      holdLock(locks, workerId, workerLockName(workerId));
    }
  }

  override postMessage(message: unknown): void {
    super.postMessage(message);
    if ((message as { readonly type?: unknown }).type !== 'hello' || !this.answers) {
      return;
    }
    this.deliver({
      v: this.isOtherVersion ? PROTOCOL_VERSION + 1 : PROTOCOL_VERSION,
      from: BROKER_ID,
      to: SELF,
      type: 'welcome',
      worker: this.workerId,
    });
  }

  /** The worker ends: crashed, ended by the browser, terminated. Only its lock tells. */
  end(): void {
    this.locks.killContext(this.workerId);
  }
}

/** The request's clock as a hidden tab sees it: no timer runs sooner than `minimumDelayMs`. */
function throttled(clock: FakeClock, minimumDelayMs: number): Clock {
  return {
    now: () => clock.now(),
    monotonicNow: () => clock.monotonicNow(),
    setTimer: (callback, delayMs) => clock.setTimer(callback, Math.max(delayMs, minimumDelayMs)),
    clearTimer: (handle) => {
      clock.clearTimer(handle);
    },
  };
}

/**
 * A transport whose factory starts a new worker every time it is called, as `new SharedWorker`
 * does once the previous worker has ended. Settled: the transport holds its own lock and has said
 * hello.
 */
async function start(
  options: {
    throttle?: boolean;
    /** The number of the first worker that does not answer. */
    silentFrom?: number;
    /** The number of the first worker whose script runs another protocol version. */
    otherVersionFrom?: number;
    startup?: WorkerStartup;
    logger?: Logger;
  } = {},
): Promise<
  TransportRequestRecorder & {
    transport: SharedWorkerTransport;
    workers: WorkerPort[];
    workerErrors: ((event: unknown) => void)[];
  }
> {
  const rec = recordTransportRequest(SELF, options.logger);
  const workers: WorkerPort[] = [];
  const workerErrors: ((event: unknown) => void)[] = [];
  const request =
    options.throttle === true
      ? { ...rec.request, clock: throttled(rec.clock, THROTTLED_TIMER_MS) }
      : rec.request;
  const from = (first: number | undefined): boolean =>
    first !== undefined && workers.length >= first;

  const transport = new SharedWorkerTransport(
    request,
    () => {
      const port = new WorkerPort(
        rec.locks,
        `worker-${String(workers.length)}`,
        !from(options.silentFrom),
        from(options.otherVersionFrom),
      );
      workers.push(port);
      return {
        port,
        addEventListener: (_type, listener) => {
          workerErrors.push(listener);
        },
      };
    },
    'fake://worker',
    options.startup,
  );
  await flushMicrotasks();
  return { ...rec, transport, workers, workerErrors };
}

function worker(workers: readonly WorkerPort[], index: number): WorkerPort {
  const port = workers[index];
  if (port === undefined) {
    throw new Error(`no worker ${String(index)} was started`);
  }
  return port;
}

/**
 * How a tab notices that the worker ended (ADR-0041).
 *
 * A port to a dead worker reports nothing. The worker holds a Web Lock for its lifetime, and the tab
 * waits on it: the browser grants it the moment the worker has ended.
 */
describe('SharedWorkerTransport, while its worker runs', () => {
  it('keeps its worker, however long it runs, and sends nothing to show it is there', async () => {
    const { clock, workers, transportErrors } = await start();
    const posted = worker(workers, 0).posted.length;

    await clock.advance(100 * HANDSHAKE_DEADLINE_MS);

    expect(workers).toHaveLength(1);
    expect(worker(workers, 0).posted).toHaveLength(posted);
    expect(clock.pendingTimerCount).toBe(0);
    expect(transportErrors).toEqual([]);
  });

  it('keeps its worker when the browser holds its timers back', async () => {
    const { clock, workers, transportErrors } = await start({ throttle: true });

    await clock.advance(60 * THROTTLED_TIMER_MS);

    // The welcome arrived long before the deadline ran, however late it ran.
    expect(workers).toHaveLength(1);
    expect(transportErrors).toEqual([]);
  });
});

describe('SharedWorkerTransport, when its worker ends', () => {
  it('starts a new worker at once, and says hello there with what it takes part in', async () => {
    const { transport, workers } = await start();
    transport.attach('Reader');

    worker(workers, 0).end();
    await flushMicrotasks();

    // The new broker learns this context from its hello, which restores what it takes part in. No
    // owner-claimed: the port did not change hands.
    expect(workers).toHaveLength(2);
    expect(worker(workers, 1).posted).toEqual([
      expect.objectContaining({ type: 'hello', configNames: ['Reader'] }),
    ]);
    expect(worker(workers, 0).closed).toBe(true);
  });

  it('asks the client to restate itself once the new worker has welcomed it', async () => {
    const rec = await start();
    let reconnects = 0;
    Object.assign(rec.request, { onReconnected: () => (reconnects += 1) });

    worker(rec.workers, 0).end();
    await flushMicrotasks();

    expect(reconnects).toBe(1);
  });

  it('delivers through the new worker, and nothing from the one that ended', async () => {
    const { transport, workers, messages, transportErrors } = await start();
    worker(workers, 0).end();
    await flushMicrotasks();

    transport.send({
      type: 'status-request',
      v: PROTOCOL_VERSION,
      from: SELF,
      to: 'all',
      configName: 'Reader',
      retry: false,
    } as ProtocolMessage);
    worker(workers, 0).deliver(envelope(PEER, SELF, { type: 'status-request', configName: 'A' }));
    worker(workers, 0).failToClone();
    worker(workers, 1).deliver(envelope(PEER, SELF, { type: 'status-request', configName: 'B' }));

    expect(worker(workers, 1).posted.at(-1)).toMatchObject({ type: 'status-request' });
    expect(messages).toEqual([expect.objectContaining({ configName: 'B' })]);
    // The loss itself, reported once.
    expect(transportErrors).toHaveLength(1);
  });

  it('reports the lost worker once, however many new workers do not answer', async () => {
    const { clock, workers, workerErrors, transportErrors } = await start({ silentFrom: 1 });

    worker(workers, 0).end();
    await flushMicrotasks();
    await clock.advance(10 * HANDSHAKE_DEADLINE_MS);
    for (const fail of workerErrors) {
      fail({ type: 'error' });
    }

    // A new worker that does not answer in time is given up on, and another one started.
    expect(workers.length).toBeGreaterThan(2);
    expect(transportErrors).toHaveLength(1);
  });

  it('reports a second loss once a worker has answered in between', async () => {
    const { workers, transportErrors } = await start();

    worker(workers, 0).end();
    await flushMicrotasks();
    worker(workers, 1).end();
    await flushMicrotasks();

    expect(workers).toHaveLength(3);
    expect(transportErrors).toHaveLength(2);
  });

  it('stops waiting once closed', async () => {
    const { transport, clock, locks, workers } = await start();

    transport.close();
    await flushMicrotasks();
    worker(workers, 0).end();
    await flushMicrotasks();

    expect(workers).toHaveLength(1);
    expect(locks.queueLength(workerLockName('worker-0'))).toBe(0);
    expect(clock.pendingTimerCount).toBe(0);
  });
});

describe('SharedWorkerTransport, when its worker never answers at all', () => {
  it('reports the worker as unusable at the handshake deadline, so a fallback can take over', async () => {
    const reasons: WorkerLoadFailure[] = [];
    const { clock, workers, transportErrors } = await start({
      silentFrom: 0,
      startup: {
        onReady: () => undefined,
        onLoadFailed: (_event, reason) => reasons.push(reason),
      },
    });

    // A fetch that hangs, or a script from before the frozen handshake (ADR-0008).
    await clock.advance(HANDSHAKE_DEADLINE_MS - 1);
    expect(reasons).toEqual([]);
    await clock.advance(1);

    expect(reasons).toEqual(['worker-not-answering']);
    expect(workers).toHaveLength(1);
    expect(transportErrors).toEqual([]);
  });

  it('starts another worker at the deadline when nothing can take over', async () => {
    const { clock, workers, transportErrors } = await start({ silentFrom: 0 });

    await clock.advance(HANDSHAKE_DEADLINE_MS);

    expect(workers).toHaveLength(2);
    expect(transportErrors).toHaveLength(1);
  });
});

/**
 * A worker whose script runs another protocol version, where nothing falls back to
 * `BroadcastChannel` (ADR-0008).
 *
 * Such a worker answers `hello` and nothing else. A new worker from the same URL runs the same
 * script, and starting one at every deadline would only fill the log.
 */
describe('SharedWorkerTransport, when its worker runs another protocol version', () => {
  it('gives up on the worker for good when nothing falls back', async () => {
    const { logger, records } = recordingLogger();
    const { clock, workers, decodeFailures, transportErrors } = await start({
      otherVersionFrom: 0,
      logger,
    });

    await clock.advance(10 * HANDSHAKE_DEADLINE_MS);

    // `transport: 'sharedworker'`: the mismatch is reported once, and is the only report.
    expect(decodeFailures).toEqual([expect.objectContaining({ reason: 'version-mismatch' })]);
    expect(transportErrors).toEqual([]);
    expect(workers).toHaveLength(1);
    expect(worker(workers, 0).closed).toBe(true);
    expect(clock.pendingTimerCount).toBe(0);
    expect(fieldsOfEvent(records, 'transport.worker-other-protocol-version')).toEqual([
      expect.objectContaining({ theirVersion: PROTOCOL_VERSION + 1 }),
    ]);
    expect(fieldsOfEvent(records, 'transport.worker-restarted')).toEqual([]);
  });

  it('gives up on a worker of another version started in place of one that ended', async () => {
    const { clock, workers, decodeFailures, transportErrors } = await start({
      otherVersionFrom: 1,
    });

    // The application was deployed again under the same worker URL while the tab stayed open.
    worker(workers, 0).end();
    await flushMicrotasks();
    expect(workers).toHaveLength(2);
    await clock.advance(10 * HANDSHAKE_DEADLINE_MS);

    expect(workers).toHaveLength(2);
    expect(transportErrors).toHaveLength(1);
    expect(decodeFailures).toHaveLength(1);
    expect(clock.pendingTimerCount).toBe(0);
  });

  it('reports the worker as unusable once when whoever created it keeps it anyway', async () => {
    const reasons: WorkerLoadFailure[] = [];
    // What `FallbackTransport` does when it cannot build a `BroadcastChannel` either.
    const { clock, workers, transportErrors } = await start({
      otherVersionFrom: 0,
      startup: {
        onReady: () => undefined,
        onLoadFailed: (_event, reason) => reasons.push(reason),
      },
    });

    await clock.advance(10 * HANDSHAKE_DEADLINE_MS);

    expect(reasons).toEqual(['worker-other-protocol-version']);
    expect(workers).toHaveLength(1);
    expect(transportErrors).toEqual([]);
  });

  it('still starts a new worker when a worker of this version ends later', async () => {
    const { workers, transportErrors } = await start({ otherVersionFrom: 2 });

    worker(workers, 0).end();
    await flushMicrotasks();
    worker(workers, 1).end();
    await flushMicrotasks();

    // Only a worker that said it runs another version is given up on for good.
    expect(workers).toHaveLength(3);
    expect(transportErrors).toHaveLength(2);
  });
});
