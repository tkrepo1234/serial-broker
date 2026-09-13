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

/**
 * How many heartbeats in a row the broker may leave unanswered before a participant gives up on
 * the worker (ADR-0021).
 *
 * The broker answers every heartbeat at once, so heartbeats going unanswered mean that the worker
 * died or hangs - a port to a dead worker reports nothing else. Counted in heartbeats rather than
 * measured in time: a browser holds back the timers of a hidden tab to about one run a minute, and
 * such a tab sends fewer heartbeats, each of them still answered, so throttling can delay the
 * verdict but never cause it. A long task in the tab can push one answer past the next heartbeat,
 * not three in a row. With three, a dead worker is noticed 45 to 60 seconds after its last answer
 * in a visible tab, and within about four minutes in a hidden one.
 */
export const MAX_UNANSWERED_HEARTBEATS = 3;
