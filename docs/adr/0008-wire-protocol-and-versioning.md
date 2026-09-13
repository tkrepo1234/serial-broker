# ADR-0008: Version the wire protocol independently

- **Status:** Accepted, amended by [ADR-0023](./0023-announce-the-protocol-version.md) and
  [ADR-0024](./0024-keep-the-worker-handshake-version-independent.md)
- **Date:** 2026-09-12

> **Amendment (ADR-0023).** Rule 2 is reached rarely, because rule 3 keeps the versions from ever
> exchanging a message. Tabs therefore also announce their protocol version on a channel whose name
> carries no version, and report a mismatch from that.

## Context

Tabs of the same origin are not guaranteed to run the same build. A user keeps a tab open for
days while the application deploys a new version; the old tab and the new tab then meet on the
same `SharedWorker` and the same Web Lock. If their message formats differ, the failure is
silent and catastrophic: a message misread as a write request, a status broadcast interpreted
as a payload, bytes sent to a device that never asked for them.

## Decision

The inter-context protocol carries an explicit integer version
(`PROTOCOL_VERSION` in `src/protocol/version.ts`), incremented on **any** change to the
message shapes — this is not SemVer, there are no compatible additions.

Rules:

1. Every message carries `{ v: PROTOCOL_VERSION, ... }`.
2. A participant ignores any message whose `v` differs from its own, reports it once per peer
   version with code `PROTOCOL_VERSION_MISMATCH`, and continues.
3. The Web Lock name and the `SharedWorker` name both embed the protocol version, so
   participants with different versions **do not contend for the same lock** and do not share
   a broker. Two incompatible versions therefore partition into two independent groups, each
   internally correct.
4. Partitioning means two owners for one physical device across versions. This is reported as
   an error to both groups rather than hidden, because it is a deployment problem the
   application must surface — and it is strictly better than silent corruption.

## Alternatives considered

- **Negotiate a common version.** Requires every version to implement every predecessor's
  format forever. Enormous cost for a scenario resolved by reloading a tab.
- **Ignore the problem; assume all tabs run the same build.** True right up to the deployment
  that breaks a customer's shop floor.
- **Refuse to run when a different version is detected.** Stops the _new_ tab from working
  because an _old_ tab exists — punishing the up-to-date context. Rejected in favour of
  partition-and-report.

## Consequences

### Positive

- No cross-version corruption is possible; the failure mode is partition, which is loud.
- The protocol can be changed freely, which keeps the design honest.

### Negative

- During a deployment with mixed tabs, two groups may both try to own the device; the second
  `open()` fails and is reported. Documented as "reload all tabs after deploying a version
  with a protocol change", and the `PROTOCOL_VERSION_MISMATCH` error carries exactly that
  remediation string.

## Verification

Scenario matrix row 13.
