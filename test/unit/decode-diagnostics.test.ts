import { describe, expect, it } from 'vitest';

import { isParticipantDiagnostics } from '../../src/protocol/decode-diagnostics.js';

import { sampleReport } from './fixtures/diagnostics-report.js';

/** Returns a copy of the sample report with the value at `path` replaced. */
function withField(path: readonly (string | number)[], value: unknown): unknown {
  const report = structuredClone(sampleReport()) as unknown as Record<string, unknown>;
  let target: Record<string, unknown> = report;
  for (const key of path.slice(0, -1)) {
    target = target[key] as Record<string, unknown>;
  }
  const last = path.at(-1) as string | number;
  if (value === REMOVE) {
    delete target[last];
  } else {
    target[last] = value;
  }
  return report;
}

const REMOVE = Symbol('remove');
const CONFIGURATION = ['configurations', 0] as const;

/**
 * A report is display-only, but it is read field by field by whatever renders it. A field that
 * is not what its type says would fail there, far from the bus - so the whole tree is checked
 * on arrival (ADR-0018).
 */
describe('isParticipantDiagnostics', () => {
  it('accepts a complete report from an owner, including an unlimited reconnect budget', () => {
    expect(isParticipantDiagnostics(structuredClone(sampleReport()))).toBe(true);
  });

  it('accepts a participant with no connection of its own, watching any port', () => {
    const report = withField([...CONFIGURATION, 'connection'], undefined);
    const anyPort = withField([...CONFIGURATION, 'settings', 'device'], { any: true });

    expect(isParticipantDiagnostics(report)).toBe(true);
    expect(isParticipantDiagnostics(anyPort)).toBe(true);
  });

  it('accepts a report from a context with no configurations', () => {
    expect(isParticipantDiagnostics(withField(['configurations'], []))).toBe(true);
  });

  it.each([
    ['with no client id', ['clientId'], REMOVE],
    ['from an unknown transport', ['transport'], 'carrier-pigeon'],
    ['whose configurations are not a list', ['configurations'], { 0: {} }],
    ['with a role that is neither owner nor participant', [...CONFIGURATION, 'role'], 'admin'],
    ['with an unknown status', [...CONFIGURATION, 'status'], 'sleeping'],
    ['with an empty error code', [...CONFIGURATION, 'lastErrorCode'], ''],
    ['with a device that has neither IDs nor any', [...CONFIGURATION, 'settings', 'device'], {}],
    ['with a NaN setting', [...CONFIGURATION, 'settings', 'connection', 'factor'], Number.NaN],
    ['with a text setting that is a number', [...CONFIGURATION, 'settings', 'serial', 'parity'], 0],
    ['with no persist flag', [...CONFIGURATION, 'settings', 'persist'], REMOVE],
    ['with a missing listener count', [...CONFIGURATION, 'listeners', 'onSend'], REMOVE],
    ['with a fractional pending count', [...CONFIGURATION, 'pendingWrites', 'total'], 0.5],
    ['with an unknown connection state', [...CONFIGURATION, 'connection', 'state'], 'dreaming'],
    ['with a negative byte count', [...CONFIGURATION, 'connection', 'bytesSent'], -1],
    ['with a string byte count', [...CONFIGURATION, 'connection', 'bytesReceived'], '12'],
    [
      'with an infinite reconnect time',
      [...CONFIGURATION, 'connection', 'nextAttemptAt'],
      Infinity,
    ],
  ] as const)('rejects a report %s', (_label, path, value) => {
    expect(isParticipantDiagnostics(withField(path, value))).toBe(false);
  });

  it.each([
    ['null', null],
    ['a string', 'report'],
    ['an array', []],
  ])('rejects %s', (_label, value) => {
    expect(isParticipantDiagnostics(value)).toBe(false);
  });
});
