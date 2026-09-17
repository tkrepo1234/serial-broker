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
 * A report is display-only, and bounded by the decoder before this check. Only what files it - its
 * sender and its named configurations - is checked; the rest is displayed defensively (ADR-0018).
 */
describe('isParticipantDiagnostics', () => {
  it('accepts a complete report, and one from a context with no configurations', () => {
    expect(isParticipantDiagnostics(structuredClone(sampleReport()))).toBe(true);
    expect(isParticipantDiagnostics(withField(['configurations'], []))).toBe(true);
  });

  it('leaves the fields of a configuration to whatever displays them', () => {
    // A build that reports differently is still listed; what it says is shown as it said it.
    expect(isParticipantDiagnostics(withField([...CONFIGURATION, 'status'], 'sleeping'))).toBe(
      true,
    );
    expect(isParticipantDiagnostics(withField([...CONFIGURATION, 'settings'], REMOVE))).toBe(true);
  });

  it.each([
    ['with no client id', ['clientId'], REMOVE],
    ['from an unknown transport', ['transport'], 'carrier-pigeon'],
    ['with no protocol version', ['protocolVersion'], REMOVE],
    ['with an infinite report time', ['reportedAt'], Infinity],
    ['whose configurations are not a list', ['configurations'], { 0: {} }],
    ['with a configuration that is not an object', [...CONFIGURATION], 'Reader'],
    ['with a configuration that has no name', [...CONFIGURATION, 'name'], ''],
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
