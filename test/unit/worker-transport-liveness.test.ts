import { describe, expect, it } from 'vitest';

import {
  SharedWorkerTransport,
  type WorkerLoadFailure,
  type WorkerStartup,
} from '../../src/client/transport/shared-worker-transport.js';
import type { Clock } from '../../src/core/clock.js';
import type { Logger } from '../../src/core/types.js';
import { HEARTBEAT_INTERVAL_MS, MAX_UNANSWERED_HEARTBEATS } from '../../src/protocol/heartbeat.js';
import { BROKER_ID, type ClientId, type ProtocolMessage } from '../../src/protocol/messages.js';
import { PROTOCOL_VERSION } from '../../src/protocol/version.js';
import type { FakeClock } from '../harness/fake-clock.js';
import { fieldsOfEvent, recordingLogger } from '../harness/recording-logger.js';
import {
  envelope,
  FakeMessagePort,
  recordTransportRequest,
  type TransportRequestRecorder,
} from '../harness/transport-doubles.js';

const SELF = 'self' as ClientId;
const PEER = 'peer' as ClientId;

/** How long a hidden tab's timers can be held back: about one run a minute. */
const THROTTLED_TIMER_MS = 60_000;

/**
 * A port to a worker whose broker answers `hello` and every heartbeat at once, for as long as the
 * worker lives.
 *
 * A worker of another protocol version answers only `hello`, in its own version, and drops
 * everything else (ADR-0024).
 */
class WorkerPort extends FakeMessagePort {
  isAlive: boolean;
  readonly isOtherVersion: boolean;

  constructor(isAlive: boolean, isOtherVersion = false) {
    super();
    this.isAlive = isAlive;
    this.isOtherVersion = isOtherVersion;
  }

  override postMessage(message: unknown): void {
    super.postMessage(message);
    const type = (message as { readonly type?: unknown }).type;
    if (this.isOtherVersion) {
      if (type === 'hello') {
        this.deliver({ v: PROTOCOL_VERSION - 1, from: BROKER_ID, to: SELF, type: 'welcome' });
      }
      return;
    }
    if (this.isAlive && (type === 'hello' || type === 'heartbeat')) {
      this.deliver({
        v: PROTOCOL_VERSION,
        from: 'serial-broker/broker',
        to: SELF,
        type: 'welcome',
      });
    }
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
 * does once the previous worker has died.
 */
function start(
  options: {
    throttle?: boolean;
    workersAnswer?: boolean;
    /** The number of the first worker whose script runs another protocol version. */
    otherVersionFrom?: number;
    startup?: WorkerStartup;
    logger?: Logger;
  } = {},
): TransportRequestRecorder & {
  transport: SharedWorkerTransport;
  workers: WorkerPort[];
  workerErrors: ((event: unknown) => void)[];
} {
  const rec = recordTransportRequest(SELF, options.logger);
  const workers: WorkerPort[] = [];
  const workerErrors: ((event: unknown) => void)[] = [];
  const request =
    options.throttle === true
      ? { ...rec.request, clock: throttled(rec.clock, THROTTLED_TIMER_MS) }
      : rec.request;

  const transport = new SharedWorkerTransport(
    request,
    () => {
      const port = new WorkerPort(
        options.workersAnswer ?? true,
        options.otherVersionFrom !== undefined && workers.length >= options.otherVersionFrom,
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
  return { ...rec, transport, workers, workerErrors };
}

/** Long enough for the heartbeats that mark a broker as gone to go unanswered, whatever the phase. */
const DETECTION_MS = (MAX_UNANSWERED_HEARTBEATS + 1) * HEARTBEAT_INTERVAL_MS;

function worker(workers: readonly WorkerPort[], index: number): WorkerPort {
  const port = workers[index];
  if (port === undefined) {
    throw new Error(`no worker ${String(index)} was started`);
  }
  return port;
}

/**
 * How a tab notices that the worker died (ADR-0021, amended).
 *
 * A port to a dead worker reports nothing, and a transport that only sent heartbeats could not tell a
 * dead broker from one with nothing to route. The broker answers every heartbeat, so a tab counts
 * the heartbeats that go unanswered.
 */
describe('SharedWorkerTransport, while its broker answers', () => {
  it('keeps its worker, however long it runs', async () => {
    const { clock, workers, transportErrors } = start();

    await clock.advance(100 * HEARTBEAT_INTERVAL_MS);

    expect(workers).toHaveLength(1);
    expect(transportErrors).toEqual([]);
  });

  it('keeps its worker when the browser holds its timers back to one a minute', async () => {
    const { clock, workers, transportErrors } = start({ throttle: true });

    await clock.advance(60 * THROTTLED_TIMER_MS);

    // A throttled tab sends fewer heartbeats, and the broker still answers each of them.
    expect(workers).toHaveLength(1);
    expect(transportErrors).toEqual([]);
  });

  it('takes any message from the broker as a sign of life, not only its answers', async () => {
    const { clock, workers } = start();
    worker(workers, 0).isAlive = false;

    for (let elapsed = 0; elapsed < 10 * HEARTBEAT_INTERVAL_MS; elapsed += HEARTBEAT_INTERVAL_MS) {
      worker(workers, 0).deliver(
        envelope(PEER, 'all', { type: 'status-request', configName: 'Reader' }),
      );
      await clock.advance(HEARTBEAT_INTERVAL_MS);
    }

    expect(workers).toHaveLength(1);
  });
});

describe('SharedWorkerTransport, when its broker stops answering', () => {
  it(`starts a new worker once ${String(MAX_UNANSWERED_HEARTBEATS)} heartbeats in a row went unanswered, and not before`, async () => {
    const { transport, clock, workers } = start();
    transport.attach('Reader');
    transport.setOwnership('Reader', true);
    worker(workers, 0).isAlive = false;

    // The first heartbeat still follows the answer to hello; the next three go unanswered.
    await clock.advance(MAX_UNANSWERED_HEARTBEATS * HEARTBEAT_INTERVAL_MS);
    expect(workers).toHaveLength(1);
    await clock.advance(HEARTBEAT_INTERVAL_MS);
    expect(workers).toHaveLength(2);

    // The new broker learns this context from its hello and a heartbeat, which restores what it
    // takes part in and owns. No owner-claimed: the port did not change hands.
    expect(worker(workers, 1).posted).toEqual([
      expect.objectContaining({ type: 'hello' }),
      expect.objectContaining({
        type: 'heartbeat',
        configNames: ['Reader'],
        ownedConfigNames: ['Reader'],
      }),
    ]);
    expect(worker(workers, 0).closed).toBe(true);
  });

  it('shows the new worker the secret it showed the old one, so the identity is still its own', async () => {
    const { clock, workers } = start();
    worker(workers, 0).isAlive = false;

    await clock.advance((MAX_UNANSWERED_HEARTBEATS + 1) * HEARTBEAT_INTERVAL_MS);

    // A worker that hung may still be running, holding this tab's identity to the secret it saw. A
    // new secret would be refused there, and the tab would be cut off from its own identity
    // (ADR-0028).
    const secretOf = (port: WorkerPort): unknown =>
      (port.posted[0] as { readonly secret?: unknown }).secret;
    expect(secretOf(worker(workers, 1))).toBe(secretOf(worker(workers, 0)));
  });

  it('notices a dead worker with its timers held back too, only later', async () => {
    const { clock, workers } = start({ throttle: true });
    worker(workers, 0).isAlive = false;

    await clock.advance(MAX_UNANSWERED_HEARTBEATS * THROTTLED_TIMER_MS);
    expect(workers).toHaveLength(1);
    await clock.advance(THROTTLED_TIMER_MS);
    expect(workers).toHaveLength(2);
  });

  it('delivers through the new worker, and nothing from the one it gave up on', async () => {
    const { transport, clock, workers, messages, transportErrors } = start();
    worker(workers, 0).isAlive = false;
    await clock.advance(DETECTION_MS);

    transport.send({
      type: 'status-request',
      v: PROTOCOL_VERSION,
      from: SELF,
      to: 'owner',
      configName: 'Reader',
    } as ProtocolMessage);
    worker(workers, 0).deliver(envelope(PEER, SELF, { type: 'status-request', configName: 'A' }));
    worker(workers, 0).failToClone();
    worker(workers, 1).deliver(envelope(PEER, SELF, { type: 'status-request', configName: 'B' }));

    expect(worker(workers, 1).posted.at(-1)).toMatchObject({ type: 'status-request' });
    expect(messages).toEqual([expect.objectContaining({ configName: 'B' })]);
    expect(transportErrors).toHaveLength(1);
  });

  it('reports the lost broker once, however many new workers stay silent', async () => {
    const { clock, workers, workerErrors, transportErrors } = start({ workersAnswer: false });
    // The first worker answered hello; it dies, and so is every one started after it.
    worker(workers, 0).isAlive = true;
    worker(workers, 0).deliver({ v: PROTOCOL_VERSION, from: 'b', to: SELF, type: 'welcome' });
    worker(workers, 0).isAlive = false;

    await clock.advance(10 * DETECTION_MS);
    for (const fail of workerErrors) {
      fail({ type: 'error' });
    }

    expect(workers.length).toBeGreaterThan(2);
    expect(transportErrors).toHaveLength(1);
  });

  it('reports a second loss once a broker has answered in between', async () => {
    const { clock, workers, transportErrors } = start();

    worker(workers, 0).isAlive = false;
    await clock.advance(DETECTION_MS);
    expect(workers).toHaveLength(2);
    worker(workers, 1).isAlive = false;
    await clock.advance(DETECTION_MS);

    expect(workers).toHaveLength(3);
    expect(transportErrors).toHaveLength(2);
  });

  it('stops watching once closed', async () => {
    const { transport, clock, workers } = start();
    worker(workers, 0).isAlive = false;

    transport.close();
    await clock.advance(10 * DETECTION_MS);

    expect(workers).toHaveLength(1);
    expect(clock.pendingTimerCount).toBe(0);
  });
});

describe('SharedWorkerTransport, when its worker never answers at all', () => {
  it('reports the worker as unusable, so what was sent can be sent elsewhere', async () => {
    const reasons: WorkerLoadFailure[] = [];
    const { clock, workers, transportErrors } = start({
      workersAnswer: false,
      startup: {
        onReady: () => undefined,
        onLoadFailed: (_event, reason) => reasons.push(reason),
      },
    });

    // A fetch that hangs, or a script from before the frozen handshake (ADR-0024).
    await clock.advance(MAX_UNANSWERED_HEARTBEATS * HEARTBEAT_INTERVAL_MS - 1);
    expect(reasons).toEqual([]);
    await clock.advance(1);

    expect(reasons).toEqual(['worker-not-answering']);
    expect(workers).toHaveLength(1);
    expect(transportErrors).toEqual([]);
  });
});

/**
 * A worker whose script runs another protocol version, where nothing falls back to
 * `BroadcastChannel` (ADR-0024, amended).
 *
 * Such a worker answers `hello` and nothing else, so its silence is no sign of a crash. A new worker
 * from the same URL runs the same script, and starting one every three heartbeats would only fill
 * the log.
 */
describe('SharedWorkerTransport, when its worker runs another protocol version', () => {
  it('gives up on the worker for good when nothing falls back', async () => {
    const { logger, records } = recordingLogger();
    const { clock, workers, decodeFailures, transportErrors } = start({
      otherVersionFrom: 0,
      logger,
    });

    await clock.advance(10 * DETECTION_MS);

    // `transport: 'sharedworker'`: the mismatch is reported once, and is the only report.
    expect(decodeFailures).toEqual([expect.objectContaining({ reason: 'version-mismatch' })]);
    expect(transportErrors).toEqual([]);
    expect(workers).toHaveLength(1);
    expect(worker(workers, 0).posted).not.toContainEqual(
      expect.objectContaining({ type: 'heartbeat' }),
    );
    expect(worker(workers, 0).closed).toBe(true);
    expect(clock.pendingTimerCount).toBe(0);
    expect(fieldsOfEvent(records, 'transport.worker-other-protocol-version')).toEqual([
      expect.objectContaining({ theirVersion: PROTOCOL_VERSION - 1 }),
    ]);
    expect(fieldsOfEvent(records, 'transport.worker-restarted')).toEqual([]);
  });

  it('gives up on a worker of another version started in place of one that died', async () => {
    const { clock, workers, decodeFailures, transportErrors } = start({ otherVersionFrom: 1 });
    worker(workers, 0).isAlive = false;

    // The application was deployed again under the same worker URL while the tab stayed open.
    await clock.advance(DETECTION_MS);
    expect(workers).toHaveLength(2);
    await clock.advance(10 * DETECTION_MS);

    expect(workers).toHaveLength(2);
    expect(transportErrors).toHaveLength(1);
    expect(decodeFailures).toHaveLength(1);
    expect(clock.pendingTimerCount).toBe(0);
  });

  it('reports the worker as unusable once when whoever created it keeps it anyway', async () => {
    const reasons: WorkerLoadFailure[] = [];
    // What `FallbackTransport` does when it cannot build a `BroadcastChannel` either.
    const { clock, workers, transportErrors } = start({
      otherVersionFrom: 0,
      startup: {
        onReady: () => undefined,
        onLoadFailed: (_event, reason) => reasons.push(reason),
      },
    });

    await clock.advance(10 * DETECTION_MS);

    expect(reasons).toEqual(['worker-other-protocol-version']);
    expect(workers).toHaveLength(1);
    expect(transportErrors).toEqual([]);
  });

  it('still starts a new worker when a worker of this version dies later', async () => {
    const { clock, workers, transportErrors } = start({ otherVersionFrom: 2 });

    worker(workers, 0).isAlive = false;
    await clock.advance(DETECTION_MS);
    worker(workers, 1).isAlive = false;
    await clock.advance(DETECTION_MS);

    // Only a worker that said it runs another version is given up on for good.
    expect(workers).toHaveLength(3);
    expect(transportErrors).toHaveLength(2);
  });
});
