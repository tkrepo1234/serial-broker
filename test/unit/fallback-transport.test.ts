import { describe, expect, it } from 'vitest';

import { FallbackTransport } from '../../src/client/transport/fallback-transport.js';
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

  close(): void {
    this.isClosed = true;
  }
}

function statusRequest(): ProtocolMessage {
  return {
    type: 'status-request',
    v: PROTOCOL_VERSION,
    from: SELF,
    to: 'all',
    configName: 'Reader',
    retry: false,
  };
}

const LOAD_ERROR = { type: 'error' };

function setUp(options: { fallbackThrows?: boolean } = {}): {
  transport: FallbackTransport;
  worker: RecordingTransport;
  fallback: RecordingTransport;
  records: LogRecord[];
  transportErrors: unknown[];
  reconnects: () => number;
  ready: () => void;
  failToLoad: (reason?: WorkerLoadFailure) => void;
} {
  const { logger, records } = recordingLogger();
  const { request, transportErrors } = recordTransportRequest(SELF, logger);
  let reconnects = 0;

  const worker = new RecordingTransport('sharedworker');
  const fallback = new RecordingTransport('broadcastchannel');
  let startup: WorkerStartup | undefined;

  const transport = new FallbackTransport(
    {
      ...request,
      onReconnected: () => {
        reconnects += 1;
      },
    },
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
    reconnects: () => reconnects,
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

  it('tells BroadcastChannel what it takes part in, and has the client restate the rest', () => {
    const { transport, worker, fallback, transportErrors, reconnects, failToLoad } = setUp();
    transport.attach('Reader');
    transport.send(statusRequest());
    transport.attach('Printer');
    transport.attach('Scale');
    transport.detach('Printer');

    failToLoad();

    // Nothing sent before the failure reached anyone, and nothing of it is sent again: what the
    // others need to know, the client states anew (ADR-0024).
    expect(fallback.operations).toEqual(['attach Reader', 'attach Scale']);
    expect(reconnects()).toBe(1);
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

  it('never falls back once the broker has answered', () => {
    const { transport, fallback, transportErrors, reconnects, ready, failToLoad } = setUp();
    transport.attach('Reader');

    ready();
    failToLoad();

    expect(transport.kind).toBe('sharedworker');
    expect(fallback.operations).toEqual([]);
    expect(transportErrors).toEqual([LOAD_ERROR]);
    expect(reconnects()).toBe(0);
  });

  it('neither falls back nor reports anything once closed', () => {
    const { transport, worker, fallback, transportErrors, failToLoad } = setUp();

    transport.close();
    failToLoad();

    // Whoever closed the bus has stopped listening: a failure reported now would reach a client
    // that is already disposed.
    expect(worker.isClosed).toBe(true);
    expect(fallback.operations).toEqual([]);
    expect(transportErrors).toEqual([]);
  });

  it('reports the worker failure when BroadcastChannel cannot be created either', () => {
    const { transport, transportErrors, failToLoad } = setUp({ fallbackThrows: true });

    failToLoad();

    expect(transport.kind).toBe('sharedworker');
    expect(transportErrors).toEqual([LOAD_ERROR]);
  });
});
