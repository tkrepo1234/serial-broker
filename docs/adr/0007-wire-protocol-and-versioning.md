# ADR-0007: Version the wire protocol; announce it; freeze the worker handshake

- **Status:** Accepted

## Context

Tabs of the same origin are not guaranteed to run the same build. A user keeps a tab open for
days while the application deploys a new version; the old tab and the new tab then meet on the
same `SharedWorker` and the same Web Lock. If their message formats differ, the failure is
silent and catastrophic: a message misread as a write request, a status broadcast interpreted
as a payload, bytes sent to a device that never asked for them.

The worker script is a second source of another version. A tab starts the worker under a name that
carries its version, but the script it runs is whatever the worker URL serves: a worker file copied
into an application's static assets and left behind at the next upgrade, or an old script kept by a
cache.

## Decision

The inter-context protocol carries an explicit integer version (`PROTOCOL_VERSION` in
`src/protocol/version.ts`), incremented on **any** change to the message shapes. This is not
SemVer; there are no compatible additions.

1. **Every message carries `v`**, and a tab reads it before any other field.
2. **Versions partition.** Every Web Lock name, the `SharedWorker` name and the `BroadcastChannel`
   name embed `v<version>`, so tabs of different versions do not contend for the same lock and do
   not share a bus. Two incompatible versions form two independent groups, each internally correct.
3. **A message in another version is dropped** and reported as `PROTOCOL_VERSION_MISMATCH`, once
   per version, whose remediation asks to reload every tab.
4. **Tabs announce their version on a channel that carries none.** Because of rule 2, partitioned
   tabs never exchange a message. So every tab, when it joins the bus (its first `setup()`), posts
   `{ type: 'serial-broker/protocol-version', protocolVersion, isReply }` on the `BroadcastChannel`
   `serial-broker/announcements`. A tab that receives an announcement of another version reports
   the mismatch to its configurations, once per version, and answers with its own announcement
   marked as a reply; replies are never answered. The channel is opened through the injected
   environment and is optional there.
5. **The handshake with the worker is readable by every version.** A tab's first message on the
   worker's port is an object with `type: 'hello'` and its identity, a non-empty string, in `from`.
   A worker answers every such object, whatever its `v`, with `type: 'welcome'`, its own version in
   `v` and the tab's identity in `to`; nothing else in another version is answered or routed. A
   message in another version on the worker's port can therefore only come from the worker: the tab
   reports the mismatch and, before any `welcome` of its own version, falls back to
   `BroadcastChannel` ([ADR-0006](./0006-sharedworker-as-message-broker.md)). Where it does not fall
   back - with `transport: 'sharedworker'`, or on a worker started in place of one that ended - it
   closes its port, starts no other worker, and logs `transport.worker-other-protocol-version` once:
   a new worker from the same URL would run the same script. Only a reload brings it onto a worker
   again.

The announcement's name and message, and the handshake's `type`, sender identity and `v`, are
frozen: every later version must still send and understand exactly these. The shapes are kept in
`src/protocol/announcement.ts` and `src/protocol/handshake.ts`. Remembered configurations carry a
storage version of their own ([ADR-0020](./0020-one-storage-key-per-configuration.md)).

## Alternatives considered

- **Negotiate a common version.** Requires every version to implement every predecessor's format
  forever. Enormous cost for a scenario resolved by reloading a tab.
- **Ignore the problem; assume all tabs run the same build.** True right up to the deployment
  that breaks a customer's shop floor.
- **Refuse to run when a different version is detected.** Stops the _new_ tab from working
  because an _old_ tab exists. Rejected in favour of partition-and-report.
- **Leave the version out of the lock and bus names.** Tabs would meet and could compare versions,
  but a message misread by another version is exactly the corruption this record prevents.
- **A versionless `hello` on the existing bus, or a second channel for the handshake.** The bus name
  is versioned for the reason above; the worker port already connects exactly the two parties
  concerned.
- **Web Locks `query()` to find other versions.** Shows only held and pending locks, not every tab,
  and is a snapshot to poll.
- **Only report a worker of another version, without falling back.** The tabs would stay cut off
  from each other although `BroadcastChannel` connects them.
- **Put the protocol version into the worker URL.** The URL belongs to the application
  (`workerUrl`), and a file copied from another release is the same file whatever the query says.
- **Keep starting workers, less often, on a worker of another version.** It would pick up a script
  fixed on the server only after every tab let go of the stale worker, and never where the tab
  itself is the older side.

## Consequences

### Positive

- No cross-version corruption is possible; the failure mode is partition, which is loud.
- A mixed deployment and a stale worker script are both reported by name, through `onError`.
- The protocol can be changed freely, which keeps the design honest.

### Negative

- During a deployment with mixed tabs, two groups may both try to own the device; the second
  `open()` fails and is reported. Documented as "reload all tabs after deploying a version with a
  protocol change".
- One more channel per tab, and message shapes that can never change. They are deliberately
  minimal.
- The report reads "Another tab or the shared worker runs an incompatible version of this library",
  followed by what was heard: one wording for a mixed deployment and for a stale worker script.
- Any script of the origin can post to the announcement channel. Announcements are decoded
  strictly, and the worst a forged one can cause is one error report per forged version.

## Verification

`test/integration/multi-tab/protocol-versions.test.ts` and `two-builds.test.ts`, in both transport
modes; `test/unit/worker-script.test.ts` (a worker answers a `hello` in another version),
`test/unit/transports.test.ts`, `test/unit/fallback-transport.test.ts` and
`test/unit/worker-transport-liveness.test.ts`; `test/unit/bus-limits.test.ts` (the frozen shape of
the announcement and its decoder); `test/integration/multi-tab/shared-worker.test.ts` (a worker
script of another version) and `hostile-bus.test.ts` (a message of another version on this build's
channel);
and `test/browser/transports.spec.ts`, which serves a worker of another protocol version.
