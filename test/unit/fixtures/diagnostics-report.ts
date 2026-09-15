import type { ParticipantDiagnostics } from '../../../src/core/diagnostics.js';
import { PROTOCOL_VERSION } from '../../../src/protocol/version.js';

/** A complete, valid report from an owning context, for tests to start from and break. */
export function sampleReport(): ParticipantDiagnostics {
  return {
    clientId: 'c-1',
    transport: 'sharedworker',
    protocolVersion: PROTOCOL_VERSION,
    reportedAt: 1_000,
    configurations: [
      {
        name: 'Reader',
        role: 'owner',
        status: 'open',
        statusSince: 900,
        lastErrorCode: undefined,
        settings: {
          device: { vendorId: 0x1a86, productId: 0x7523 },
          serial: {
            baudRate: 9600,
            dataBits: 8,
            stopBits: 1,
            parity: 'none',
            bufferSize: 255,
            flowControl: 'none',
          },
          connection: {
            initialDelayMs: 250,
            factor: 2,
            maxDelayMs: 30_000,
            jitter: 0.5,
            maxAttempts: Number.POSITIVE_INFINITY,
            stableAfterMs: 5_000,
            openTimeoutMs: 10_000,
            writeTimeoutMs: 5_000,
            maxWriteChunkBytes: 4_096,
            autoReconnect: true,
          },
          encoding: { encoding: 'utf-8', decodeText: false },
          receive: { idleMs: 50, maxWaitMs: 500 },
          remember: true,
          maxTabs: Number.POSITIVE_INFINITY,
        },
        listeners: { onReceive: 1, onSend: 0, onError: 0, onStatusChange: 2 },
        pendingWrites: { total: 0, dispatched: 0, started: 0 },
        connection: {
          state: 'open',
          attempt: 1,
          nextAttemptAt: undefined,
          openedAt: 900,
          stalledWriteSince: undefined,
          queuedWrites: 0,
          bytesReceived: 12,
          bytesSent: 4,
        },
      },
    ],
  };
}
