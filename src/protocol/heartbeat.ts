/**
 * How participants show the broker that they are still there (ADR-0021).
 *
 * A `MessagePort` reports nothing when the context behind it dies, so the broker cannot tell a
 * crashed tab from a quiet one. Every participant on the `SharedWorker` sends a heartbeat, and
 * the broker forgets whoever stays silent for too long.
 */

/** How often a participant sends a heartbeat. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * How long a participant may send nothing before the broker forgets it.
 *
 * Far longer than the interval, on purpose: a browser throttles the timers of a tab that has been
 * hidden for a while to about one run a minute, and a tab that is only throttled must not be
 * forgotten. Should it be, its next heartbeat restores it.
 */
export const SILENT_PARTICIPANT_TIMEOUT_MS = 180_000;

/** How often the broker looks for participants that have fallen silent. */
export const SWEEP_INTERVAL_MS = 30_000;
