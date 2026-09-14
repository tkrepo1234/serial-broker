/**
 * Version of the inter-context message protocol.
 *
 * This is **not** the package version and does not follow SemVer. It is incremented on any
 * change to the message shapes in `messages.ts` - there are no compatible additions, because
 * a participant that misreads one field can send bytes to a device that nobody asked for.
 *
 * Contexts running different protocol versions do not federate: the version is part of the
 * lock name and the broker channel name, so they partition into independent groups rather than
 * corrupting each other (ADR-0008). They still learn of each other through the version
 * announcement, whose channel carries no version, and report `PROTOCOL_VERSION_MISMATCH`
 * (ADR-0023).
 */
export const PROTOCOL_VERSION = 8;

/**
 * `true` for a value that can be a protocol version: a positive safe integer.
 *
 * Whatever else a sender puts where a version belongs - an object, a string, a fraction, `NaN`,
 * `-0` - names no build of this library. Reporting it as a version would let one sender produce a
 * new "version" with every message, and each is reported once (ADR-0008, ADR-0023).
 */
export function isProtocolVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/** Prefix for every name this library claims in a shared namespace. */
const NAMESPACE = 'serial-broker';

/**
 * Name of the Web Lock that represents ownership of a configuration's port.
 *
 * Holding this lock *is* being the owner - there is no separate flag that could disagree with
 * it. See ADR-0005.
 */
export function ownerLockName(configName: string): string {
  return `${NAMESPACE}/owner/v${String(PROTOCOL_VERSION)}/${configName}`;
}

/**
 * Name of the Web Lock that is place `place` of a configuration's `maxTabs` places (ADR-0025).
 *
 * The limit is part of the name, so tabs that disagree about it never share places; they find out
 * from the status of the tab holding the port instead. The configuration name comes last, so that a
 * name containing `/` cannot be mistaken for a limit or a place.
 */
export function tabSlotLockName(configName: string, maxTabs: number, place: number): string {
  return `${NAMESPACE}/tab-slot/v${String(PROTOCOL_VERSION)}/${String(maxTabs)}/${String(place)}/${configName}`;
}

/** Name of the Web Lock tabs queue at before competing for one of the places (ADR-0025). */
export function tabSlotGateLockName(configName: string, maxTabs: number): string {
  return `${NAMESPACE}/tab-slot-gate/v${String(PROTOCOL_VERSION)}/${String(maxTabs)}/${configName}`;
}

/** Name of the `SharedWorker` instance, and of the `BroadcastChannel` in the fallback. */
export function brokerChannelName(): string {
  return `${NAMESPACE}/broker/v${String(PROTOCOL_VERSION)}`;
}
