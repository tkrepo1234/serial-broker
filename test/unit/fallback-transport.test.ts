import { describe, expect, it } from 'vitest';

import {
  FallbackTransport,
  MAX_REPLAYED_MESSAGES,
} from '../../src/client/transport/fallback-transport.js';
import type { WorkerStartup } from '../../src/client/transport/shared-worker-transport.js';
import type { Transport, TransportRequest } from '../../src/client/transport/transport.js';
import { ScopedLogger } from '../../src/core/logger.js';
import type { LogFields, LogLevel } from '../../src/core/types.js';
import type { ClientId, ProtocolMessage } from '../../src/protocol/messages.js';
import { PROTOCOL_VERSION } from '../../src/protocol/version.js';

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

const LOAD_ERROR = { type: 'error' };

function setUp(options: { fallbackThrows?: boolean } = {}): {
  transport: FallbackTransport;
  worker: RecordingTransport;
  fallback: RecordingTransport;
  logs: { level: LogLevel; fields: LogFields }[];
  transportErrors: unknown[];
  ready: () => void;
  failToLoad: () => void;
} {
  const logs: { level: LogLevel; fields: LogFields }[] = [];
  const transportErrors: unknown[] = [];
  const request: TransportRequest = {
    clientId: SELF,
    onMessage: () => undefined,
    onDecodeFailure: () => undefined,
    onTransportError: (error) => transportErrors.push(error),
    logger: new ScopedLogger(
      { log: (level, _message, fields) => logs.push({ level, fields }) },
      {},
    ),
  };

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
    logs,
    transportErrors,
    ready: () => startup?.onReady(),
    failToLoad: () => startup?.onLoadFailed(LOAD_ERROR),
  };
}

describe('FallbackTransport', () => {
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
    const { transport, logs, failToLoad } = setUp();
    transport.send(statusRequest());
    transport.send(statusRequest());

    failToLoad();

    expect(logs).toContainEqual({
      level: 'warn',
      fields: expect.objectContaining({
        event: 'environment.transport-fallback',
        reason: 'worker-script-failed',
        replayedMessages: 2,
        droppedMessages: 0,
      }) as LogFields,
    });
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

  it('keeps a bounded number of messages, and every attach, and says how many it dropped', () => {
    const { transport, fallback, logs, failToLoad } = setUp();
    for (let index = 0; index < MAX_REPLAYED_MESSAGES + 5; index += 1) {
      transport.send(statusRequest());
    }
    transport.attach('Reader');

    failToLoad();

    expect(fallback.operations.filter((operation) => operation.startsWith('send'))).toHaveLength(
      MAX_REPLAYED_MESSAGES,
    );
    expect(fallback.operations.at(-1)).toBe('attach Reader');
    expect(logs.at(-1)?.fields).toMatchObject({ droppedMessages: 5 });
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
