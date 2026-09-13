# ADR-0023: Announce the protocol version on an unversioned channel

- **Status:** Accepted
- **Date:** 2026-09-13
- **Amends:** ADR-0008

## Context

ADR-0008 embeds the protocol version in every lock name, the worker name and the bus channel name,
so that tabs on different versions partition instead of misreading each other. Its rule 2 — report
a message from another version as `PROTOCOL_VERSION_MISMATCH` — is therefore almost never reached:
partitioned tabs never exchange a message. What a mixed deployment actually shows is its
consequence, a tab that cannot open the device and keeps reconnecting, with nothing that names the
cause.

## Decision

Every tab announces its protocol version on one `BroadcastChannel` whose name carries no version,
`serial-broker/announcements`, when it joins the bus (its first `setup()`). The channel carries one
message, `{ type: 'serial-broker/protocol-version', protocolVersion, isReply }`, and both the name
and the message are frozen: every later version must still send and understand exactly this.

A tab that receives an announcement from another version reports `PROTOCOL_VERSION_MISMATCH` to its
configurations, once per version, and answers with its own announcement marked as a reply. Replies
are never answered. So a tab opened later learns of the tabs already open, and two versions cannot
keep each other talking.

The channel is opened through the injected environment (ADR-0014) and is optional there: where the
platform has no `BroadcastChannel`, mismatches go unnoticed as before.

## Alternatives considered

- **Leave the version out of the lock and bus names.** Tabs would meet and could compare versions,
  but a message misread by another version is exactly the corruption ADR-0008 exists to prevent.
- **A versionless `hello` on the existing bus.** The bus name is versioned for the same reason; an
  exception for one message type couples the bus to every future format.
- **Web Locks `query()`.** Shows lock names, and so the versions holding them, but only held and
  pending locks, not every tab, and it is a snapshot to poll.
- **Only document it.** The documentation already said "reload every tab"; the point is to say it
  at the moment it is needed.

## Consequences

### Positive

- A mixed deployment is reported by name, through `onError`, where before it only showed as a
  reconnect loop.

### Negative

- One more channel per tab, and a message format that can never change. It is deliberately minimal.
- A tab that has no configuration set up when the announcement arrives only logs the mismatch, like
  any other error not tied to a configuration.

### Risks and mitigations

- Any script of the origin can post to the channel. Announcements are decoded strictly, anything
  else is ignored, and the worst a forged one can cause is one error report per forged version.

## Verification

`test/integration/multi-tab/protocol-versions.test.ts`, in both transport modes: a tab on another
version is reported and answered; a reply is not answered; tabs on the same version say nothing to
each other's applications; malformed announcements are ignored.
