import { describe, expect, it } from 'vitest';

import {
  FallbackTransport,
  MAX_REPLAYED_MESSAGES,
} from '../../src/client/transport/fallback-transport.js';
import type {
  WorkerLoadFailure,
  WorkerStartup,
} from '../../src/client/transport/shared-worker-transport.js';
import type { Transport } from '../../src/client/transport/transport.js';
import type { LogFields } from '../../src/core/types.js';
import type { ClientId, ProtocolMessage } from '../../src/protocol/messages.js';
import { PROTOCOL_VERSION } from '../../src/protocol/version.js';
import { type LogRecord, recordingLogger } from '../harness/recording-logger.js';
import { recordTransportRequest } from '../harness/transport-doubles.js';

const SELF = 'self' as ClientId;

/** A transport that only records what it was asked to do. */
class RecordingTransport implements Transport {
  readonly clientId = SELF;
  readonly operations: string[] = [];
  isClosed = false;

  constructor(readonly kind: Transport['kind']) {}

  send(message: ProtocolMessage): void {
    this.operations.push(`send ${message.type}`);
  }

  attach(configName: string): void {
    this.operations.push(`attach ${configName}`);
  }

  detach(configName: string): void {
    this.operations.push(`detach ${configName}`);
  }

  setOwnership(configName: string, isOwner: boolean): void {
    this.operations.push(`owner ${configName} ${String(isOwner)}`);
  }

  close(): void {
    this.isClosed = true;
  }
}

function statusRequest(): ProtocolMessage {
  return {
    type: 'status-request',
    v: PROTOCOL_VERSION,
    from: SELF,
    to: 'owner',
    configName: 'Reader',
  };
}

function dataReceived(): ProtocolMessage {
  return {
    type: 'data-received',
    v: PROTOCOL_VERSION,
    from: SELF,
    to: 'all',
    configName: 'Reader',
    payload: new Uint8Array([1]),
    text: undefined,
    timestamp: 0,
  };
}

const LOAD_ERROR = { type: 'error' };

function setUp(options: { fallbackThrows?: boolean } = {}): {
  transport: FallbackTransport;
  worker: RecordingTransport;
  fallback: RecordingTransport;
  records: LogRecord[];
  transportErrors: unknown[];
  ready: () => void;
  failToLoad: (reason?: WorkerLoadFailure) => void;
} {
  const { logger, records } = recordingLogger();
  const { request, transportErrors } = recordTransportRequest(SELF, logger);

  const worker = new RecordingTransport('sharedworker');
  const fallback = new RecordingTransport('broadcastchannel');
  let startup: WorkerStartup | undefined;

  const transport = new FallbackTransport(
    request,
    (_request, workerStartup) => {
      startup = workerStartup;
      return worker;
    },
    () => {
      if (options.fallbackThrows === true) {
        throw new Error('BroadcastChannel is blocked too');
      }
      return fallback;
    },
  );

  return {
    transport,
    worker,
    fallback,
    records,
    transportErrors,
    ready: () => startup?.onReady(),
    failToLoad: (reason = 'worker-script-failed') => startup?.onLoadFailed(LOAD_ERROR, reason),
  };
}

describe('FallbackTransport', () => {
  it('names in its log why the worker could not be used', () => {
    const { records, failToLoad } = setUp();

    failToLoad('worker-other-protocol-version');

    expect(records).toContainEqual([
      'warn',
      expect.any(String),
      expect.objectContaining({
        event: 'environment.transport-fallback',
        reason: 'worker-other-protocol-version',
      }) as LogFields,
    ]);
  });

  it('uses the SharedWorker transport while its script is starting', () => {
    const { transport, worker, fallback } = setUp();

    transport.attach('Reader');
    transport.send(statusRequest());

    expect(transport.kind).toBe('sharedworker');
    expect(transport.clientId).toBe(SELF);
    expect(worker.operations).toEqual(['attach Reader', 'send status-request']);
    expect(fallback.operations).toEqual([]);
  });

  it('replays everything, in order, over BroadcastChannel when the script fails to load', () => {
    const { transport, worker, fallback, transportErrors, failToLoad } = setUp();
    transport.attach('Reader');
    transport.send(statusRequest());
    transport.setOwnership('Reader', true);
    transport.attach('Printer');
    transport.detach('Printer');

    failToLoad();

    // Nothing sent before the failure reached anyone, so each of it is sent once, in order.
    expect(fallback.operations).toEqual([
      'attach Reader',
      'send status-request',
      'owner Reader true',
      'attach Printer',
      'detach Printer',
    ]);
    expect(transport.kind).toBe('broadcastchannel');
    expect(worker.isClosed).toBe(true);
    // Recovered, so not an error for the application.
    expect(transportErrors).toEqual([]);
  });

  it('keeps using BroadcastChannel afterwards', () => {
    const { transport, worker, fallback, failToLoad } = setUp();
    failToLoad();
    const workerOperations = worker.operations.length;

    transport.send(statusRequest());
    transport.close();

    expect(fallback.operations).toEqual(['send status-request']);
    expect(fallback.isClosed).toBe(true);
    expect(worker.operations).toHaveLength(workerOperations);
  });

  it('logs the fallback with how much was replayed', () => {
    const { transport, records, failToLoad } = setUp();
    transport.send(statusRequest());
    transport.send(statusRequest());

    failToLoad();

    expect(records).toContainEqual([
      'warn',
      expect.any(String),
      expect.objectContaining({
        event: 'environment.transport-fallback',
        reason: 'worker-script-failed',
        replayedMessages: 2,
        droppedMessages: 0,
      }) as LogFields,
    ]);
  });

  it('forgets what it kept once the broker has answered, and never falls back after that', () => {
    const { transport, fallback, transportErrors, ready, failToLoad } = setUp();
    transport.attach('Reader');

    ready();
    failToLoad();

    expect(transport.kind).toBe('sharedworker');
    expect(fallback.operations).toEqual([]);
    expect(transportErrors).toEqual([LOAD_ERROR]);
  });

  it('bounds the traffic it keeps, never the messages other tabs wait for', () => {
    const { transport, fallback, records, failToLoad } = setUp();
    for (let index = 0; index < MAX_REPLAYED_MESSAGES + 5; index += 1) {
      transport.send(dataReceived());
    }
    transport.send(statusRequest());
    transport.attach('Reader');

    failToLoad();

    expect(
      fallback.operations.filter((operation) => operation === 'send data-received'),
    ).toHaveLength(MAX_REPLAYED_MESSAGES);
    expect(fallback.operations.slice(-2)).toEqual(['send status-request', 'attach Reader']);
    expect(records.at(-1)?.[2]).toMatchObject({ droppedMessages: 5 });
  });

  it('does not fall back once closed', () => {
    const { transport, worker, fallback, transportErrors, failToLoad } = setUp();

    transport.close();
    failToLoad();

    expect(worker.isClosed).toBe(true);
    expect(fallback.operations).toEqual([]);
    expect(transportErrors).toEqual([LOAD_ERROR]);
  });

  it('reports the worker failure when BroadcastChannel cannot be created either', () => {
    const { transport, transportErrors, failToLoad } = setUp({ fallbackThrows: true });

    failToLoad();

    expect(transport.kind).toBe('sharedworker');
    expect(transportErrors).toEqual([LOAD_ERROR]);
  });
});
