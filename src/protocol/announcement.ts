import { isRecord } from './guards.js';
import { isProtocolVersion } from './version.js';

/**
 * The version announcement: how tabs on different protocol versions learn of each other.
 *
 * Everything else a tab says travels on a bus whose name carries the protocol version, so tabs on
 * different versions never hear one another (ADR-0008). This channel's name carries no version,
 * and the shape of its one message is frozen: every later version has to send and understand
 * exactly this, or it could no longer detect the versions before it. See ADR-0023.
 */

/** The channel every tab announces its protocol version on. Never versioned, never renamed. */
export const ANNOUNCEMENT_CHANNEL_NAME = 'serial-broker/announcements';

const ANNOUNCEMENT_TYPE = 'serial-broker/protocol-version';

/** The one message of the announcement channel. Frozen, like the channel's name. */
export interface VersionAnnouncement {
  readonly type: typeof ANNOUNCEMENT_TYPE;
  /** The sender's `PROTOCOL_VERSION`. */
  readonly protocolVersion: number;
  /** `true` when answering another tab's announcement. A reply is never answered in turn. */
  readonly isReply: boolean;
}

/** Builds this tab's announcement, or its reply to another tab's. */
export function versionAnnouncement(
  protocolVersion: number,
  isReply: boolean,
): VersionAnnouncement {
  return { type: ANNOUNCEMENT_TYPE, protocolVersion, isReply };
}

/**
 * Reads an announcement.
 *
 * @returns `undefined` for anything else on the channel, which is ignored: the channel is open to
 *   every script of the origin.
 */
export function decodeAnnouncement(raw: unknown): VersionAnnouncement | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const { type, protocolVersion, isReply } = raw;
  // Only a positive safe integer: a sender choosing `-0`, `2 ** 60` or a negative number names no
  // build, and every distinct value would be reported as a version of its own.
  if (
    type !== ANNOUNCEMENT_TYPE ||
    !isProtocolVersion(protocolVersion) ||
    typeof isReply !== 'boolean'
  ) {
    return undefined;
  }
  return versionAnnouncement(protocolVersion, isReply);
}
