import { describe, expect, it } from 'vitest';

import {
  BroadcastChannelTransport,
  type BroadcastChannelLike,
} from '../../src/client/transport/broadcast-channel-transport.js';
import {
  SharedWorkerTransport,
  type SharedWorkerLike,
} from '../../src/client/transport/shared-worker-transport.js';
import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import { SerialBrokerError } from '../../src/core/errors.js';
import { OnceLog, ScopedLogger } from '../../src/core/logger.js';
import { decodeAnnouncement } from '../../src/protocol/announcement.js';
import { decodeMessage, describeDecodeFailure } from '../../src/protocol/decode.js';
import { helloSenderOf } from '../../src/protocol/handshake.js';
import {
  exceedsStructureBudget,
  MAX_CONFIG_NAME_LENGTH,
  MAX_CONFIGURATIONS,
  MAX_HELLO_CONFIGURATIONS,
  MAX_IDENTIFIER_LENGTH,
  MAX_LOG_RECORD_CHARACTERS,
  MAX_LOG_RECORD_VALUES,
  MAX_PAYLOAD_BYTES,
  MAX_REPORT_VALUES,
  MAX_TEXT_LENGTH,
  warnLimitExceeded,
} from '../../src/protocol/limits.js';
import type { ClientId, ProtocolMessage } from '../../src/protocol/messages.js';
import { PROTOCOL_VERSION } from '../../src/protocol/version.js';
import { Broker } from '../../src/worker/broker.js';
import { fieldsOfEvent, recordingLogger } from '../harness/recording-logger.js';
import { envelope, FakeMessagePort, recordTransportRequest } from '../harness/transport-doubles.js';

import { sampleReport } from './fixtures/diagnostics-report.js';
import { ERROR_PAYLOAD, validMessages } from './fixtures/valid-messages.js';

/**
 * How much a sender on the bus can make a context hold (`limits.ts`, SECURITY.md).
 *
 * Every limit is tested at its value, which is accepted, and one past it, which is dropped and names
 * the limit - so a limit that silently moved, or stopped being checked, fails here.
 */

function failureOf(raw: unknown): unknown {
  const result = decodeMessage(raw);
  return result.ok ? 'accepted' : result.failure;
}

const exceeding = (type: string, field: string, limit: string): unknown => ({
  reason: 'limit-exceeded',
  type,
  field,
  limit,
});

describe('decodeMessage within its limits', () => {
  it.each(['from', 'to'])(
    'accepts a %s of MAX_IDENTIFIER_LENGTH characters, and not one more',
    (field) => {
      const status = validMessages().status;

      expect(failureOf({ ...status, [field]: 'i'.repeat(MAX_IDENTIFIER_LENGTH) })).toBe('accepted');
      expect(failureOf({ ...status, [field]: 'i'.repeat(MAX_IDENTIFIER_LENGTH + 1) })).toEqual(
        exceeding('status', field, 'MAX_IDENTIFIER_LENGTH'),
      );
    },
  );

  it.each([
    ['write-request', 'requestId'],
    ['write-request', 'term'],
    ['data-sent', 'originClientId'],
    ['diagnostics-request', 'requestId'],
  ] as const)('holds the %s %s to MAX_IDENTIFIER_LENGTH', (type, field) => {
    const message = validMessages()[type];

    expect(failureOf({ ...message, [field]: 'i'.repeat(MAX_IDENTIFIER_LENGTH + 1) })).toEqual(
      exceeding(type, field, 'MAX_IDENTIFIER_LENGTH'),
    );
  });

  it('accepts a configuration name as long as setup() accepts, and not one more', () => {
    const request = validMessages()['status-request'];

    expect(failureOf({ ...request, configName: 'n'.repeat(MAX_CONFIG_NAME_LENGTH) })).toBe(
      'accepted',
    );
    expect(failureOf({ ...request, configName: 'n'.repeat(MAX_CONFIG_NAME_LENGTH + 1) })).toEqual(
      exceeding('status-request', 'configName', 'MAX_CONFIG_NAME_LENGTH'),
    );
  });

  it('accepts a hello naming MAX_HELLO_CONFIGURATIONS configurations, and not one more', () => {
    const hello = validMessages().hello;
    const names = (count: number): string[] =>
      Array.from({ length: count }, (_, index) => `c-${String(index)}`);

    expect(failureOf({ ...hello, configNames: names(MAX_HELLO_CONFIGURATIONS) })).toBe('accepted');
    expect(failureOf({ ...hello, configNames: names(MAX_HELLO_CONFIGURATIONS + 1) })).toEqual(
      exceeding('hello', 'configNames', 'MAX_HELLO_CONFIGURATIONS'),
    );
    expect(failureOf({ ...hello, configNames: ['n'.repeat(MAX_CONFIG_NAME_LENGTH + 1)] })).toEqual(
      exceeding('hello', 'configNames', 'MAX_CONFIG_NAME_LENGTH'),
    );
  });

  it('accepts a payload of MAX_PAYLOAD_BYTES, and not one byte more', () => {
    const data = validMessages()['data-received'];

    expect(failureOf({ ...data, payload: new Uint8Array(MAX_PAYLOAD_BYTES) })).toBe('accepted');
    expect(failureOf({ ...data, payload: new Uint8Array(MAX_PAYLOAD_BYTES + 1) })).toEqual(
      exceeding('data-received', 'payload', 'MAX_PAYLOAD_BYTES'),
    );
  });

  it('refuses decoded text beyond MAX_TEXT_LENGTH', () => {
    const data = validMessages()['data-received'];

    expect(failureOf({ ...data, text: 't'.repeat(MAX_TEXT_LENGTH + 1) })).toEqual(
      exceeding('data-received', 'text', 'MAX_TEXT_LENGTH'),
    );
  });

  it('keeps no more of a payload than it spans, however large the buffer it arrived in', () => {
    // Cloning a view clones its whole buffer: four bytes can arrive holding a megabyte alive.
    const buffer = new ArrayBuffer(1024 * 1024);
    new Uint8Array(buffer).set([1, 2, 3, 4], 512);
    const view = new Uint8Array(buffer, 512, 4);

    const result = decodeMessage({ ...validMessages()['write-request'], payload: view });

    expect(result.ok).toBe(true);
    const payload =
      result.ok && result.message.type === 'write-request' ? result.message.payload : undefined;
    expect(payload?.buffer.byteLength).toBe(4);
    expect([...(payload ?? [])]).toEqual([1, 2, 3, 4]);
  });

  it('passes on only the fields a message declares', () => {
    const result = decodeMessage({
      ...validMessages().status,
      junk: 'x'.repeat(10_000),
      nested: { deeper: [1, 2, 3] },
    });

    // Otherwise the broker copies whatever was added to every tab it routes the message to.
    expect(result.ok && Object.keys(result.message).sort()).toEqual([
      'configName',
      'device',
      'from',
      'maxTabs',
      'status',
      'term',
      'timestamp',
      'to',
      'type',
      'v',
    ]);
  });

  it('drops an error from a successful write result, which nothing reads', () => {
    const result = decodeMessage({
      ...validMessages()['write-result'],
      ok: true,
      error: ERROR_PAYLOAD,
    });

    expect(
      result.ok && result.message.type === 'write-result' && result.message.error,
    ).toBeUndefined();
  });

  it.each([
    [
      'a context of many values',
      {
        a: Object.fromEntries(
          Array.from({ length: 300 }, (_, index) => [`k${String(index)}`, index]),
        ),
      },
      'MAX_ERROR_VALUES',
    ],
    [
      'a context that refers to itself',
      (() => {
        const loop: Record<string, unknown> = {};
        loop['self'] = loop;
        return loop;
      })(),
      'MAX_ERROR_VALUES',
    ],
    ['a context holding a long text', { text: 'c'.repeat(64 * 1024 + 1) }, 'MAX_ERROR_CHARACTERS'],
  ])('refuses an error with %s', (_label, context, limit) => {
    const error = { ...ERROR_PAYLOAD, context };

    expect(failureOf({ ...validMessages().error, error })).toEqual(
      exceeding('error', 'error', limit),
    );
  });

  it('accepts an error with an ordinary context', () => {
    const error = new SerialBrokerError(SerialBrokerErrorCode.WRITE_FAILED, 'The device refused', {
      context: { bytesWritten: 3, byteLength: 8 },
      cause: new Error('NetworkError'),
    }).toJSON();

    expect(failureOf({ ...validMessages().error, error })).toBe('accepted');
  });

  it('refuses a diagnostics report made of more values than MAX_REPORT_VALUES', () => {
    const report = {
      ...sampleReport(),
      notes: Array.from({ length: MAX_REPORT_VALUES }, (_, index) => index),
    };

    expect(failureOf({ ...validMessages()['diagnostics-report'], report })).toEqual(
      exceeding('diagnostics-report', 'report', 'MAX_REPORT_VALUES'),
    );
  });

  it('refuses a diagnostics report carrying a megabyte of extra text', () => {
    const report = { ...sampleReport(), notes: 'r'.repeat(1024 * 1024 + 1) };

    expect(failureOf({ ...validMessages()['diagnostics-report'], report })).toEqual(
      exceeding('diagnostics-report', 'report', 'MAX_REPORT_CHARACTERS'),
    );
  });

  it('accepts a worker record of MAX_LOG_RECORD_VALUES fields, and not one more', () => {
    const fieldsOf = (count: number): Record<string, boolean> =>
      Object.fromEntries(Array.from({ length: count }, (_, index) => [`f${String(index)}`, true]));
    const record = validMessages()['worker-log'];

    expect(failureOf({ ...record, fields: fieldsOf(MAX_LOG_RECORD_VALUES) })).toBe('accepted');
    expect(failureOf({ ...record, fields: fieldsOf(MAX_LOG_RECORD_VALUES + 1) })).toEqual(
      exceeding('worker-log', 'fields', 'MAX_LOG_RECORD_VALUES'),
    );
  });

  it('counts the message of a worker record and its fields against one budget', () => {
    const record = validMessages()['worker-log'];
    const fields = { event: 'x' };
    const spent = 'event'.length + 'x'.length;

    expect(
      failureOf({ ...record, fields, message: 'm'.repeat(MAX_LOG_RECORD_CHARACTERS - spent) }),
    ).toBe('accepted');
    expect(
      failureOf({ ...record, fields, message: 'm'.repeat(MAX_LOG_RECORD_CHARACTERS - spent + 1) }),
    ).toEqual(exceeding('worker-log', 'fields', 'MAX_LOG_RECORD_CHARACTERS'));
  });

  it('refuses the fields of a worker record without reading past the limit', () => {
    // A proxy is the measuring instrument, not the threat: no structured clone carries one. It
    // counts what the decoder touches while a script of the origin posts a record whose `fields`
    // hold far more keys than one may - which every tab decodes before dropping it (ADR-0018).
    const inspected: string[] = [];
    const fields = new Proxy({} as Record<string, unknown>, {
      ownKeys: () => Array.from({ length: 10_000 }, (_, index) => `f${String(index)}`),
      getOwnPropertyDescriptor: (_target, key) => {
        inspected.push(String(key));
        return { value: true, enumerable: true, configurable: true, writable: true };
      },
      get: () => true,
    });

    expect(failureOf({ ...validMessages()['worker-log'], fields })).toEqual(
      exceeding('worker-log', 'fields', 'MAX_LOG_RECORD_VALUES'),
    );
    // Two looks per key - the enumeration's and the own-property check's - and then it stops.
    expect(inspected.length).toBeLessThanOrEqual(2 * (MAX_LOG_RECORD_VALUES + 1));
  });

  it('names the limit when describing why a message was dropped', () => {
    const result = decodeMessage({
      ...validMessages()['status-request'],
      configName: 'n'.repeat(500),
    });

    expect(!result.ok && describeDecodeFailure(result.failure)).toBe(
      'message "status-request" exceeds MAX_CONFIG_NAME_LENGTH in its "configName" field',
    );
  });
});

describe('decodeMessage quoting a hostile sender', () => {
  it.each([
    ['an object', {}],
    ['a text of a megabyte', 'v'.repeat(1024 * 1024)],
    ['a fraction', PROTOCOL_VERSION + 0.5],
    ['negative zero', -0],
    ['NaN', Number.NaN],
  ])('reports a version that is %s as no version at all', (_label, v) => {
    // A client reports each version it hears once; each of these would be a new one every message.
    expect(failureOf({ ...validMessages().hello, v })).toEqual({
      reason: 'version-mismatch',
      theirVersion: undefined,
    });
  });

  it('still reports a version that is one', () => {
    expect(failureOf({ ...validMessages().hello, v: PROTOCOL_VERSION + 1 })).toEqual({
      reason: 'version-mismatch',
      theirVersion: PROTOCOL_VERSION + 1,
    });
  });

  it('quotes at most 64 characters of a message type into a failure', () => {
    const failure = failureOf({
      v: PROTOCOL_VERSION,
      from: 42,
      to: 'all',
      type: 'y'.repeat(10_000),
    });

    expect(failure).toEqual({ reason: 'malformed', type: `${'y'.repeat(64)}...`, field: 'from' });
  });

  it('names the kind of a message type that is not a string, not its content', () => {
    expect(failureOf({ v: PROTOCOL_VERSION, from: 'c-1', to: 'all', type: { huge: 'x' } })).toEqual(
      {
        reason: 'unknown-type',
        type: '(object)',
      },
    );
  });
});

describe('the frozen decoders within their limits', () => {
  it.each([-1, 0, -0, 1.5, 2 ** 60, Number.NaN, Number.POSITIVE_INFINITY])(
    'ignores an announcement of version %s, which no build has',
    (protocolVersion) => {
      expect(
        decodeAnnouncement({
          type: 'serial-broker/protocol-version',
          protocolVersion,
          isReply: false,
        }),
      ).toBeUndefined();
    },
  );

  it('reads an announcement of another version', () => {
    expect(
      decodeAnnouncement({
        type: 'serial-broker/protocol-version',
        protocolVersion: 3,
        isReply: true,
      }),
    ).toEqual({ type: 'serial-broker/protocol-version', protocolVersion: 3, isReply: true });
  });

  it('reads the sender of a hello up to MAX_IDENTIFIER_LENGTH characters, and not one more', () => {
    const hello = { v: 1, to: 'all', type: 'hello' };

    expect(helloSenderOf({ ...hello, from: 'h'.repeat(MAX_IDENTIFIER_LENGTH) })).toHaveLength(
      MAX_IDENTIFIER_LENGTH,
    );
    expect(
      helloSenderOf({ ...hello, from: 'h'.repeat(MAX_IDENTIFIER_LENGTH + 1) }),
    ).toBeUndefined();
  });
});

describe('exceedsStructureBudget', () => {
  const budget = { values: 10, characters: 20 };

  it('counts every value, however deeply nested', () => {
    // An object, an array and eight numbers: ten values.
    const structure = { list: [1, 2, 3, 4, 5, 6, 7, 8] };

    expect(exceedsStructureBudget(structure, budget)).toBeUndefined();
    expect(exceedsStructureBudget({ list: [...structure.list, 9] }, budget)).toBe('values');
  });

  it('counts the characters of every string together', () => {
    expect(exceedsStructureBudget(['a'.repeat(10), 'b'.repeat(10)], budget)).toBeUndefined();
    expect(exceedsStructureBudget(['a'.repeat(10), 'b'.repeat(11)], budget)).toBe('characters');
  });

  it.each([
    ['binary data', new Uint8Array(1)],
    ['a buffer', new ArrayBuffer(1)],
    ['a map', new Map([[1, 2]])],
    ['a set', new Set([1])],
    ['a regular expression', /x/],
    ['a date', new Date(0)],
  ])('refuses %s, which is no tree of plain values', (_label, value) => {
    // What a sender adds to such an object does not survive the next clone, so a message holding one
    // would not be the same message in the next tab. Nothing the library sends holds one.
    expect(exceedsStructureBudget({ nested: [value] }, budget)).toBe('values');
  });

  it('refuses a cycle, and a value shared between two places, without looping', () => {
    const shared = { a: 1 };
    const loop: Record<string, unknown> = {};
    loop['self'] = loop;

    expect(exceedsStructureBudget({ one: shared, two: shared }, budget)).toBe('values');
    expect(exceedsStructureBudget(loop, budget)).toBe('values');
  });

  it('refuses a function or a symbol, which no structured clone contains', () => {
    expect(exceedsStructureBudget({ call: () => 1 }, budget)).toBe('values');
    expect(exceedsStructureBudget([Symbol('s')], budget)).toBe('values');
  });

  it('refuses an array of a billion holes without walking it', () => {
    const holes: unknown[] = [];
    holes.length = 1_000_000_000;

    expect(exceedsStructureBudget(holes, budget)).toBe('values');
  });

  it('walks a structure a hundred thousand levels deep without overflowing the stack', () => {
    let chain: unknown = 'end';
    for (let depth = 0; depth < 100_000; depth += 1) {
      chain = { next: chain };
    }

    expect(exceedsStructureBudget(chain, { values: 200_001, characters: 3 })).toBeUndefined();
    expect(exceedsStructureBudget(chain, budget)).toBe('values');
  });
});

describe('warnLimitExceeded', () => {
  it('logs each limit the first time it is exceeded, at warn, and never again', () => {
    const { logger, records } = recordingLogger();
    const once = new OnceLog(new ScopedLogger(logger, {}));

    for (let round = 0; round < 3; round += 1) {
      warnLimitExceeded(once, 'test.limit-exceeded', 'MAX_PAYLOAD_BYTES', {
        messageType: 'data-received',
      });
      warnLimitExceeded(once, 'test.limit-exceeded', 'MAX_TEXT_LENGTH');
    }

    expect(records.map(([level, , fields]) => [level, fields['limit']])).toEqual([
      ['warn', 'MAX_PAYLOAD_BYTES'],
      ['warn', 'MAX_TEXT_LENGTH'],
    ]);
    expect(records[0]?.[2]).toMatchObject({
      event: 'test.limit-exceeded',
      messageType: 'data-received',
    });
  });
});

describe.each(['sharedworker', 'broadcastchannel'] as const)(
  'the %s transport under a flood',
  (kind) => {
    function create(): {
      deliver: (raw: unknown) => void;
      messages: ProtocolMessage[];
      decodeFailures: unknown[];
      records: ReturnType<typeof recordingLogger>['records'];
    } {
      const { logger, records } = recordingLogger();
      const rec = recordTransportRequest('self' as ClientId, logger);
      if (kind === 'sharedworker') {
        const port = new FakeMessagePort();
        const worker: SharedWorkerLike = { port, addEventListener: () => undefined };
        new SharedWorkerTransport(rec.request, () => worker, 'fake://worker');
        return { ...rec, records, deliver: (raw) => port.deliver(raw) };
      }
      let listener: (event: { readonly data: unknown }) => void = () => undefined;
      const channel = {
        postMessage: () => undefined,
        close: () => undefined,
        addEventListener: (type: string, added: typeof listener) => {
          if (type === 'message') {
            listener = added;
          }
        },
      } as unknown as BroadcastChannelLike;
      const transport = new BroadcastChannelTransport(rec.request, () => channel);
      transport.attach('Reader');
      return { ...rec, records, deliver: (raw) => listener({ data: raw }) };
    }

    it('drops every message beyond a limit, logs the limit once, and goes on delivering', () => {
      const { deliver, messages, decodeFailures, records } = create();
      const oversized = envelope('peer', 'all', {
        type: 'status-request',
        configName: 'n'.repeat(1000),
      });

      for (let round = 0; round < 1_000; round += 1) {
        deliver(oversized);
      }
      deliver(envelope('peer', 'all', { type: 'status-request', configName: 'Reader' }));

      // Reported as malformed, each would be a warning of its own in the client.
      expect(decodeFailures).toEqual([]);
      expect(fieldsOfEvent(records, 'transport.limit-exceeded')).toEqual([
        expect.objectContaining({
          limit: 'MAX_CONFIG_NAME_LENGTH',
          messageType: 'status-request',
          field: 'configName',
        }),
      ]);
      expect(messages.map((message) => message.type)).toEqual(['status-request']);
    });
  },
);

describe('Broker within MAX_CONFIGURATIONS', () => {
  it('keeps bookkeeping for no more configurations than the limit, logs that once, and makes room again', () => {
    const { logger, records } = recordingLogger();
    const delivered: ClientId[] = [];
    const broker = new Broker({
      deliver: (to) => delivered.push(to),
      logger: new ScopedLogger(logger, {}),
      clients: () => [],
    });
    const alice = 'alice' as ClientId;
    const bob = 'bob' as ClientId;
    const message = (from: ClientId, body: Record<string, unknown>): ProtocolMessage =>
      envelope(from, 'all', body) as ProtocolMessage;
    const names = Array.from({ length: MAX_CONFIGURATIONS }, (_, index) => `c-${String(index)}`);
    broker.handleMessage(alice, message(alice, { type: 'hello', configNames: names }));

    broker.handleMessage(bob, message(bob, { type: 'hello', configNames: ['Overflow'] }));
    broker.handleMessage(
      alice,
      message(alice, { type: 'hello', configNames: [...names, 'Overflow'] }),
    );
    broker.handleMessage(alice, message(alice, { type: 'status-request', configName: 'Overflow' }));
    expect(delivered).toEqual([]);
    expect(fieldsOfEvent(records, 'broker.limit-exceeded')).toEqual([
      expect.objectContaining({ limit: 'MAX_CONFIGURATIONS' }),
    ]);

    broker.handleMessage(
      alice,
      message(alice, { type: 'hello', configNames: [...names.slice(1), 'Overflow'] }),
    );
    broker.handleMessage(bob, message(bob, { type: 'hello', configNames: ['Overflow'] }));
    broker.handleMessage(alice, message(alice, { type: 'status-request', configName: 'Overflow' }));
    expect(delivered).toEqual([bob]);
  });
});
