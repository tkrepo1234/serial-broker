import { describe, expect, it } from 'vitest';

import { SerialBrokerStatus } from '../../src/core/types.js';
import { decodeAnnouncement, versionAnnouncement } from '../../src/protocol/announcement.js';
import { isParticipantDiagnostics } from '../../src/protocol/decode-diagnostics.js';
import { decodeMessage, type DecodeFailure } from '../../src/protocol/decode.js';
import { helloSenderOf } from '../../src/protocol/handshake.js';
import {
  MAX_CONFIG_NAME_LENGTH,
  MAX_HELLO_CONFIGURATIONS,
  MAX_IDENTIFIER_LENGTH,
  MAX_LOG_RECORD_CHARACTERS,
  MAX_LOG_RECORD_VALUES,
  MAX_PAYLOAD_BYTES,
  MAX_TEXT_LENGTH,
} from '../../src/protocol/limits.js';
import type { ProtocolMessage, ProtocolMessageType } from '../../src/protocol/messages.js';
import { PROTOCOL_VERSION } from '../../src/protocol/version.js';

import { sampleReport } from './fixtures/diagnostics-report.js';
import { validMessages } from './fixtures/valid-messages.js';

/**
 * The decoders against what a hostile or broken sender can put on the bus.
 *
 * Each run starts from a valid message and breaks it at random - wrong types, missing and extra
 * fields, prototype keys, huge and non-finite numbers, long strings, arrays for objects, cycles -
 * or hands over something that is no message at all, structurally cloned as a browser would carry
 * it, or not. Whatever it is, a decoder must not throw, and whatever it accepts must satisfy an
 * oracle written independently of it: the invariants the code reading the message relies on.
 *
 * The generator is seeded, so a failure names a seed and a run, and repeats exactly.
 */

const SEEDS = [1, 7, 42, 2026, 0x5eed];
const RUNS_PER_SEED = 1_000;

/** Mulberry32: small, fast, and good enough to explore shapes. */
function createRandom(seed: number): Random {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    int: (below) => Math.floor(next() * below),
    chance: (probability) => next() < probability,
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T,
  };
}

interface Random {
  int(below: number): number;
  chance(probability: number): boolean;
  pick<T>(items: readonly T[]): T;
}

const FIELD_NAMES = [
  'v',
  'from',
  'to',
  'type',
  'configName',
  'configNames',
  'requestId',
  'payload',
  'term',
  'ok',
  'error',
  'timestamp',
  'text',
  'originClientId',
  'status',
  'maxTabs',
  'device',
  'report',
  '__proto__',
  'constructor',
  'prototype',
  'toString',
];

const TYPES = Object.keys(validMessages()) as ProtocolMessageType[];

/** Values with no structure of their own, chosen for the edges they sit on. */
const ATOMS: readonly (() => unknown)[] = [
  () => undefined,
  () => null,
  () => true,
  () => false,
  () => 0,
  () => -0,
  () => 1,
  () => -1,
  () => 1.5,
  () => Number.NaN,
  () => Number.POSITIVE_INFINITY,
  () => Number.NEGATIVE_INFINITY,
  () => Number.MAX_SAFE_INTEGER + 2,
  () => 1e308,
  () => PROTOCOL_VERSION,
  () => PROTOCOL_VERSION + 1,
  () => 10n,
  () => '',
  () => 'Reader',
  () => 'open',
  () => 'all',
  () => 'owner',
  () => '__proto__',
  () => 'constructor',
  () => '\u0000\ud800',
  () => 'x'.repeat(MAX_IDENTIFIER_LENGTH),
  () => 'x'.repeat(MAX_IDENTIFIER_LENGTH + 1),
  () => 'x'.repeat(MAX_CONFIG_NAME_LENGTH + 1),
  () => new Uint8Array([1, 2, 3]),
  () => new Uint8Array(new ArrayBuffer(64), 8, 4),
  () => new ArrayBuffer(3),
  () => new Uint16Array(2),
  () => new Date(0),
  () => /x/,
  () => Symbol('not cloneable'),
  () => (): number => 1,
];

function randomValue(random: Random, depth = 0): unknown {
  if (depth > 3 || random.chance(0.6)) {
    return random.pick(ATOMS)();
  }
  switch (random.int(6)) {
    case 0:
      return Array.from({ length: random.int(4) }, () => randomValue(random, depth + 1));
    case 1: {
      const record: Record<string, unknown> = {};
      for (let index = random.int(4); index > 0; index -= 1) {
        setOwn(record, random.pick(FIELD_NAMES), randomValue(random, depth + 1));
      }
      return record;
    }
    case 2:
      return new Map([[randomValue(random, depth + 1), randomValue(random, depth + 1)]]);
    case 3:
      return new Set([randomValue(random, depth + 1)]);
    case 4: {
      // A cycle: structured cloning carries it.
      const cyclic: Record<string, unknown> = { name: 'loop' };
      cyclic['self'] = cyclic;
      return cyclic;
    }
    default:
      // A message nested inside a message. Cloned, as in `copyOf`: the fixtures share their error
      // payload, which a later mutation must neither change for other runs nor find frozen.
      return copyOf(random.pick(Object.values(validMessages())));
  }
}

/** Sets an own property, even one named `__proto__`, as structured cloning can produce. */
function setOwn(record: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** Replaces, deletes or adds something at a random place inside `root`, which it changes. */
function mutateDeep(random: Random, root: Record<string, unknown>): void {
  const containers: Record<string, unknown>[] = [];
  const seen = new WeakSet();
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    // Each container once: an earlier mutation may have put a cycle in.
    if (
      typeof value === 'object' &&
      value !== null &&
      !ArrayBuffer.isView(value) &&
      !seen.has(value)
    ) {
      seen.add(value);
      containers.push(value as Record<string, unknown>);
      for (const child of Object.values(value) as unknown[]) {
        pending.push(child);
      }
    }
  }
  const target = random.pick(containers);
  const keys = Object.keys(target);
  const key = keys.length > 0 && random.chance(0.8) ? random.pick(keys) : random.pick(FIELD_NAMES);
  switch (random.int(3)) {
    case 0:
      delete target[key];
      break;
    case 1:
      setOwn(target, key, randomValue(random));
      break;
    default:
      setOwn(target, random.pick(FIELD_NAMES), randomValue(random));
  }
}

/** A copy deep enough that mutating it leaves the next run's starting point alone. */
function copyOf(value: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(value);
}

function asTheBusCarriesIt(random: Random, value: unknown): unknown {
  if (random.chance(0.5)) {
    return value;
  }
  try {
    return structuredClone(value);
  } catch {
    // Something no browser could post, handed over as it is: a decoder must survive it all the same.
    return value;
  }
}

/** A message from a sender that may be hostile: mostly broken valid ones, sometimes anything at all. */
function hostileMessage(random: Random): unknown {
  if (random.chance(0.1)) {
    return randomValue(random);
  }
  const message = copyOf(validMessages()[random.pick(TYPES)]);
  for (let count = 1 + random.int(3); count > 0; count -= 1) {
    if (random.chance(0.3)) {
      // Sometimes left valid: the oracle has to hold for accepted messages too.
      continue;
    }
    mutateDeep(random, message);
  }
  if (random.chance(0.05)) {
    return [message];
  }
  return message;
}

// --- The oracle ---------------------------------------------------------------------------

const isIdentifier = (value: unknown): boolean =>
  typeof value === 'string' && value.length >= 1 && value.length <= MAX_IDENTIFIER_LENGTH;

const isName = (value: unknown): boolean =>
  typeof value === 'string' && value.length >= 1 && value.length <= MAX_CONFIG_NAME_LENGTH;

const isNameList = (value: unknown): boolean =>
  Array.isArray(value) && value.length <= MAX_HELLO_CONFIGURATIONS && value.every(isName);

const isSerializedError = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const error = value as Record<string, unknown>;
  const cause = error['cause'] as Record<string, unknown> | undefined;
  return (
    error['$type'] === 'SerialBrokerError' &&
    ['code', 'message', 'remediation'].every((field) => typeof error[field] === 'string') &&
    typeof error['isRetryable'] === 'boolean' &&
    typeof error['timestamp'] === 'number' &&
    (cause === undefined ||
      (typeof cause === 'object' &&
        typeof cause['name'] === 'string' &&
        typeof cause['message'] === 'string'))
  );
};

/** What each field of an accepted message must be, whichever message it is in. */
const FIELD_ORACLE: Record<string, (value: unknown, message: Record<string, unknown>) => boolean> =
  {
    configName: isName,
    configNames: isNameList,
    requestId: isIdentifier,
    originClientId: isIdentifier,
    term: (value, message) =>
      (message['type'] === 'write-result' && value === undefined) || isIdentifier(value),
    payload: (value) =>
      value instanceof Uint8Array &&
      value.byteLength <= MAX_PAYLOAD_BYTES &&
      value.byteOffset === 0 &&
      value.buffer instanceof ArrayBuffer &&
      value.buffer.byteLength === value.byteLength,
    timestamp: (value) => typeof value === 'number' && Number.isFinite(value),
    text: (value) =>
      value === undefined || (typeof value === 'string' && value.length <= MAX_TEXT_LENGTH),
    ok: (value) => typeof value === 'boolean',
    retry: (value) => typeof value === 'boolean',
    error: (value, message) =>
      message['type'] === 'write-result' && message['ok'] === true
        ? value === undefined
        : isSerializedError(value),
    status: (value) => (Object.values(SerialBrokerStatus) as unknown[]).includes(value),
    maxTabs: (value) =>
      value === Number.POSITIVE_INFINITY ||
      (typeof value === 'number' && Number.isInteger(value) && value >= 1),
    device: (value) => isStatusDevice(value),
    report: (value) => reportProblems(value).length === 0,
    level: (value) => value === 'warn' || value === 'error',
    message: (value) =>
      typeof value === 'string' && value.length >= 1 && value.length <= MAX_LOG_RECORD_CHARACTERS,
    fields: (value, message) =>
      logFieldProblems(
        value,
        typeof message['message'] === 'string' ? message['message'].length : 0,
      ).length === 0,
  };

/**
 * Every way the fields of a forwarded worker record break what a logger relies on; empty for sound
 * ones: a plain object of bounded size, holding strings, finite numbers and booleans only, with the
 * three fields every logger reads by name as strings. The characters of the record's message
 * count against the same budget, so a long message leaves its fields less room.
 */
function logFieldProblems(value: unknown, messageCharacters: number): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ['fields'];
  }
  const problems: string[] = [];
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_LOG_RECORD_VALUES) {
    problems.push('too many fields');
  }
  let characters = messageCharacters;
  for (const [key, entry] of entries) {
    if (typeof entry === 'string') {
      characters += key.length + entry.length;
    } else if (typeof entry !== 'boolean' && !isFinite(entry)) {
      problems.push(key);
    }
    if (['event', 'clientId', 'configName'].includes(key) && typeof entry !== 'string') {
      problems.push(key);
    }
  }
  if (characters > MAX_LOG_RECORD_CHARACTERS) {
    problems.push('too many characters');
  }
  return problems;
}

const DECLARED_FIELDS: Record<ProtocolMessageType, readonly string[]> = {
  hello: ['configNames'],
  welcome: ['worker'],
  'worker-log': ['level', 'message', 'fields'],
  'status-request': ['configName', 'retry'],
  'owner-claimed': ['configName', 'term', 'maxTabs'],
  'owner-released': ['configName', 'term'],
  'write-request': ['configName', 'requestId', 'payload', 'term'],
  'write-ready': ['configName', 'requestId', 'term'],
  'write-approval': ['configName', 'requestId', 'term', 'approved'],
  'write-result': ['configName', 'requestId', 'ok', 'error', 'term'],
  'data-received': ['configName', 'payload', 'timestamp', 'text'],
  'data-sent': ['configName', 'payload', 'originClientId', 'timestamp'],
  status: ['configName', 'status', 'maxTabs', 'device', 'term', 'timestamp'],
  error: ['configName', 'error', 'timestamp'],
  'diagnostics-request': ['requestId'],
  'diagnostics-report': ['requestId', 'report'],
};

/** Every way an accepted message breaks what its readers rely on; empty for a sound one. */
function messageProblems(message: ProtocolMessage): string[] {
  const record = message as unknown as Record<string, unknown>;
  const problems: string[] = [];
  const declared = DECLARED_FIELDS[message.type] as readonly string[] | undefined;
  if (declared === undefined) {
    return [`unknown type ${message.type}`];
  }
  const expectedKeys = ['v', 'from', 'to', 'type', ...declared].sort();
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(expectedKeys)) {
    problems.push(`fields ${Object.keys(record).join(',')}`);
  }
  if (Object.getPrototypeOf(record) !== Object.prototype) {
    problems.push('not a plain object');
  }
  if (record['v'] !== PROTOCOL_VERSION) {
    problems.push('v');
  }
  if (!isIdentifier(record['from'])) {
    problems.push('from');
  }
  if (!isIdentifier(record['to'])) {
    problems.push('to');
  }
  for (const field of declared) {
    const check = FIELD_ORACLE[field];
    if (check !== undefined && !check(record[field], record)) {
      problems.push(field);
    }
  }
  return problems;
}

const isFinite = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value);

/** Every way a report breaks what is needed to file it; empty for a sound one (ADR-0018). */
function reportProblems(value: unknown): string[] {
  const report = value as Record<string, unknown> | null;
  if (typeof report !== 'object' || report === null || Array.isArray(report)) {
    return ['report'];
  }
  const problems: string[] = [];
  if (!isIdentifierLike(report['clientId'])) problems.push('clientId');
  if (!['sharedworker', 'broadcastchannel'].includes(report['transport'] as string)) {
    problems.push('transport');
  }
  if (!isFinite(report['protocolVersion'])) problems.push('protocolVersion');
  if (!isFinite(report['reportedAt'])) problems.push('reportedAt');
  const configurations = report['configurations'];
  if (!Array.isArray(configurations)) {
    return [...problems, 'configurations'];
  }
  configurations.forEach((raw: unknown, index) => {
    const configuration = raw as Record<string, unknown> | null;
    if (
      typeof configuration !== 'object' ||
      configuration === null ||
      Array.isArray(configuration) ||
      !isIdentifierLike(configuration['name'])
    ) {
      problems.push(`configurations[${String(index)}]`);
    }
  });
  return problems;
}

const isIdentifierLike = (value: unknown): boolean => typeof value === 'string' && value.length > 0;

/** The device a `status` carries: a known kind, and both USB IDs in range for `usb`. */
function isStatusDevice(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const device = value as Record<string, unknown>;
  const isUsbId = (id: unknown): boolean =>
    typeof id === 'number' && Number.isInteger(id) && id >= 0 && id <= 0xffff;
  switch (device['kind']) {
    case 'usb':
      return isUsbId(device['vendorId']) && isUsbId(device['productId']);
    case 'non-usb':
    case 'any':
    case 'auto':
      return true;
    default:
      return false;
  }
}

function failureProblems(failure: DecodeFailure): string[] {
  switch (failure.reason) {
    case 'not-an-object':
      return [];
    case 'version-mismatch':
      return failure.theirVersion === undefined ||
        (Number.isSafeInteger(failure.theirVersion) &&
          failure.theirVersion >= 1 &&
          failure.theirVersion !== PROTOCOL_VERSION)
        ? []
        : [`theirVersion ${String(failure.theirVersion)}`];
    case 'unknown-type':
    case 'malformed':
    case 'limit-exceeded':
      // The type is quoted into logs: bounded, and never the sign that the decoder threw.
      return failure.type.length <= 67 && failure.type !== 'unreadable' ? [] : ['type'];
  }
}

// --- The properties -----------------------------------------------------------------------

describe.each(SEEDS)('decoders against hostile input (seed %i)', (seed) => {
  it('decodeMessage never throws, and every message it accepts is sound and survives another trip', () => {
    const random = createRandom(seed);
    let accepted = 0;

    for (let run = 0; run < RUNS_PER_SEED; run += 1) {
      const raw = asTheBusCarriesIt(random, hostileMessage(random));

      const result = decodeMessage(raw);

      if (result.ok) {
        accepted += 1;
        expect(messageProblems(result.message), `seed ${String(seed)}, run ${String(run)}`).toEqual(
          [],
        );
        expect(decodeMessage(structuredClone(result.message))).toEqual(result);
      } else {
        expect(failureProblems(result.failure), `seed ${String(seed)}, run ${String(run)}`).toEqual(
          [],
        );
      }
    }

    // A positive control: a decoder that refused everything would pass every check above.
    expect(accepted).toBeGreaterThan(RUNS_PER_SEED / 20);
  });

  it('isParticipantDiagnostics never throws, and accepts only a sound report', () => {
    const random = createRandom(seed);
    let accepted = 0;

    for (let run = 0; run < RUNS_PER_SEED; run += 1) {
      const report = sampleReport() as unknown as Record<string, unknown>;
      for (let count = random.int(3); count > 0; count -= 1) {
        mutateDeep(random, report);
      }
      const raw = asTheBusCarriesIt(random, random.chance(0.05) ? randomValue(random) : report);

      const isAccepted = isParticipantDiagnostics(raw);

      if (isAccepted) {
        accepted += 1;
        expect(reportProblems(raw), `seed ${String(seed)}, run ${String(run)}`).toEqual([]);
      }
    }

    expect(accepted).toBeGreaterThan(RUNS_PER_SEED / 20);
  });

  it('decodeAnnouncement never throws, and returns only a well-formed announcement of a version', () => {
    const random = createRandom(seed);
    let accepted = 0;

    for (let run = 0; run < RUNS_PER_SEED; run += 1) {
      const announcement = { ...versionAnnouncement(PROTOCOL_VERSION + 1, random.chance(0.5)) };
      for (let count = random.int(3); count > 0; count -= 1) {
        mutateDeep(random, announcement);
      }
      const raw = asTheBusCarriesIt(
        random,
        random.chance(0.05) ? randomValue(random) : announcement,
      );

      const decoded = decodeAnnouncement(raw);

      if (decoded !== undefined) {
        accepted += 1;
        expect(Object.keys(decoded).sort()).toEqual(['isReply', 'protocolVersion', 'type']);
        expect(decoded.type).toBe('serial-broker/protocol-version');
        expect(Number.isSafeInteger(decoded.protocolVersion) && decoded.protocolVersion >= 1).toBe(
          true,
        );
        expect(typeof decoded.isReply).toBe('boolean');
      }
    }

    expect(accepted).toBeGreaterThan(RUNS_PER_SEED / 20);
  });

  it('helloSenderOf never throws, and names only the bounded sender of a hello', () => {
    const random = createRandom(seed);
    let accepted = 0;

    for (let run = 0; run < RUNS_PER_SEED; run += 1) {
      const hello: Record<string, unknown> = {
        type: 'hello',
        v: random.pick(ATOMS)(),
        from: 'c-1',
        to: 'all',
      };
      for (let count = random.int(3); count > 0; count -= 1) {
        mutateDeep(random, hello);
      }
      const raw = asTheBusCarriesIt(random, random.chance(0.05) ? randomValue(random) : hello);

      const sender = helloSenderOf(raw);

      if (sender !== undefined) {
        accepted += 1;
        const record = raw as Record<string, unknown>;
        expect(record['type']).toBe('hello');
        expect(record['from']).toBe(sender);
        expect(isIdentifier(sender)).toBe(true);
      }
    }

    expect(accepted).toBeGreaterThan(RUNS_PER_SEED / 20);
  });
});
