import type { ParticipantDiagnostics } from '../core/diagnostics.js';

import { isFiniteNumber, isNonEmptyString, isRecord } from './guards.js';

/**
 * The check a diagnostics report from another context passes on arrival (ADR-0018).
 *
 * A report is only ever displayed, never acted on, and the decoder has already held it to its
 * structure budget: a tree of plain values of bounded size (`limits.ts`). So only what is needed to
 * file it is checked - who sent it, and that its configurations are a list of named entries. Every
 * field below that is what the other context sent, perhaps a build that reports differently, and
 * whatever displays it reads it defensively.
 *
 * @param value - Anything, from another context.
 * @returns `true` for a report that can be filed by context and configuration. Never throws.
 */
export function isParticipantDiagnostics(value: unknown): value is ParticipantDiagnostics {
  if (!isRecord(value)) {
    return false;
  }
  const configurations = value['configurations'];
  return (
    isNonEmptyString(value['clientId']) &&
    (value['transport'] === 'sharedworker' || value['transport'] === 'broadcastchannel') &&
    isFiniteNumber(value['protocolVersion']) &&
    isFiniteNumber(value['reportedAt']) &&
    Array.isArray(configurations) &&
    configurations.every(
      (configuration: unknown) =>
        isRecord(configuration) && isNonEmptyString(configuration['name']),
    )
  );
}
