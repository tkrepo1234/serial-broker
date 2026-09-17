import { SerialBrokerErrorCode } from '../../../src/core/error-codes.js';
import { SerialBrokerError } from '../../../src/core/errors.js';
import type { ProtocolMessageType } from '../../../src/protocol/messages.js';
import { PROTOCOL_VERSION } from '../../../src/protocol/version.js';

import { sampleReport } from './diagnostics-report.js';

const BASE = { v: PROTOCOL_VERSION, from: 'c-1', to: 'all' };

/** A serialised error, as a failed write result or an error message carries it. */
export const ERROR_PAYLOAD = new SerialBrokerError(
  SerialBrokerErrorCode.WRITE_FAILED,
  'x',
).toJSON();

/**
 * A valid instance of every message type, as it crosses `postMessage`.
 *
 * Built afresh on each call, so a test that mutates one cannot change what the next test starts from.
 */
export function validMessages(): Record<ProtocolMessageType, Record<string, unknown>> {
  return {
    hello: { ...BASE, type: 'hello', configNames: ['Reader'] },
    welcome: { ...BASE, to: 'c-2', type: 'welcome', worker: 'w-1' },
    'owner-claimed': {
      ...BASE,
      type: 'owner-claimed',
      configName: 'Reader',
      term: 't-1',
      maxTabs: Number.POSITIVE_INFINITY,
    },
    'owner-released': { ...BASE, type: 'owner-released', configName: 'Reader', term: 't-1' },
    'status-request': { ...BASE, type: 'status-request', configName: 'Reader', retry: false },
    'write-request': {
      ...BASE,
      type: 'write-request',
      configName: 'Reader',
      requestId: 'w-1',
      payload: new Uint8Array([1]),
      term: 't-1',
    },
    'write-ready': {
      ...BASE,
      type: 'write-ready',
      configName: 'Reader',
      requestId: 'w-1',
      term: 't-1',
    },
    'write-approval': {
      ...BASE,
      to: 'c-2',
      type: 'write-approval',
      configName: 'Reader',
      requestId: 'w-1',
      term: 't-1',
      approved: true,
    },
    'write-result': {
      ...BASE,
      type: 'write-result',
      configName: 'Reader',
      requestId: 'w-1',
      ok: true,
      error: undefined,
      term: 't-1',
    },
    'data-received': {
      ...BASE,
      type: 'data-received',
      configName: 'Reader',
      payload: new Uint8Array([1]),
      text: 'a',
      timestamp: 1,
    },
    'data-sent': {
      ...BASE,
      type: 'data-sent',
      configName: 'Reader',
      payload: new Uint8Array([1]),
      originClientId: 'c-2',
      timestamp: 1,
    },
    status: {
      ...BASE,
      type: 'status',
      configName: 'Reader',
      status: 'open',
      maxTabs: Number.POSITIVE_INFINITY,
      device: { kind: 'usb', vendorId: 0x1a86, productId: 0x7523 },
      term: 't-1',
      timestamp: 1,
    },
    error: { ...BASE, type: 'error', configName: 'Reader', error: ERROR_PAYLOAD, timestamp: 1 },
    'diagnostics-request': { ...BASE, type: 'diagnostics-request', requestId: 'd-1' },
    'worker-log': {
      ...BASE,
      to: 'c-2',
      type: 'worker-log',
      level: 'warn',
      message: 'refused a message from a port that has not said hello',
      fields: { event: 'worker.message-refused', reason: 'before-hello', limitValue: 8 },
    },
    'diagnostics-report': {
      ...BASE,
      to: 'c-2',
      type: 'diagnostics-report',
      requestId: 'd-1',
      report: sampleReport(),
    },
  };
}
