import { isNonEmptyString, isRecord } from './guards.js';
import { MAX_IDENTIFIER_LENGTH } from './limits.js';
import { BROKER_ID, type ClientId, type WelcomeMessage } from './messages.js';
import { PROTOCOL_VERSION } from './version.js';

/**
 * The handshake between a tab and the worker: the one exchange that works across protocol versions.
 *
 * A tab starts the worker under a name that carries its protocol version (ADR-0007), but the script
 * the browser runs under that name is whatever the worker URL serves. A worker file copied from an
 * earlier release, or one kept by a cache, can be of another version. Such a worker drops
 * everything the tab says, and a tab that hears nothing back cannot tell it from a worker that is
 * only slow to start - so it would stay cut off from every other tab, with nothing reported.
 *
 * This exchange is therefore frozen, like the version announcement (ADR-0007). Every later version
 * has to keep exactly this:
 *
 * 1. A tab's first message on the port is an object with `type: 'hello'` and the tab's identity, a
 *    non-empty string, in `from`.
 * 2. A worker answers every such object, whatever its `v`, with an object with `type: 'welcome'`,
 *    its own protocol version in `v`, and the tab's identity in `to`. Nothing else in another
 *    version is answered or routed.
 * 3. A tab reads `v` before any other field. A message in another version on the worker's port can
 *    only come from the worker itself, and means that nothing the tab sent has reached anyone.
 */

/**
 * How long a tab waits for the worker's `welcome` before it gives up on that worker.
 *
 * The one timer the liveness of the bus needs (ADR-0024): a worker that has ended frees its
 * lifetime lock, but a worker whose script fetch hangs, or one that cannot take its lock, never
 * holds one to free. Only whether the welcome has arrived is checked, not how late the timer ran,
 * so a hidden tab whose timers the browser holds back is not misjudged: its welcome arrived long
 * before. A tab that has never been welcomed moves to `BroadcastChannel` (ADR-0006); one that was,
 * starts a new worker.
 */
export const HANDSHAKE_DEADLINE_MS = 45_000;

/**
 * The worker's answer to a tab's `hello`, in this build's protocol version.
 *
 * @param workerId - The identity the worker's lifetime lock is named after (ADR-0024).
 */
export function welcomeFor(clientId: ClientId, workerId: string): WelcomeMessage {
  return { type: 'welcome', v: PROTOCOL_VERSION, from: BROKER_ID, to: clientId, worker: workerId };
}

/**
 * Reads who sent a `hello`, whatever protocol version it is in.
 *
 * Only the frozen fields are read: every other part of the message may differ between versions.
 *
 * @param raw - Anything that arrived on a worker port. Entirely untrusted.
 * @returns The sender's identity, or `undefined` for anything that is not a `hello`.
 */
export function helloSenderOf(raw: unknown): ClientId | undefined {
  if (!isRecord(raw) || raw['type'] !== 'hello') {
    return undefined;
  }
  const from = raw['from'];
  // Bounded like every identifier (`MAX_IDENTIFIER_LENGTH`): the worker echoes it back in the welcome,
  // and a sender must not make it post a string of any length. Every build creates identifiers of
  // about 50 characters, so no version is refused by it.
  if (!isNonEmptyString(from) || from.length > MAX_IDENTIFIER_LENGTH) {
    return undefined;
  }
  return from as ClientId;
}
