# ADR-0024: Keep the handshake with the worker readable by every protocol version

- **Status:** Accepted
- **Date:** 2026-09-13
- **Amends:** ADR-0007, ADR-0008

## Context

The name a tab starts the `SharedWorker` under carries the protocol version, so that tabs of
different versions never share a broker (ADR-0008). The name only selects the worker instance,
though. The script it runs is whatever the worker URL serves, and that can be of another version:
the installation guide tells applications with an unusual bundler setup to copy
`dist/serial-broker.worker.js` into their static assets, a copy that is easily left behind at the
next upgrade, and an HTTP or CDN cache can serve an old script under an unchanged URL.

Such a worker decoded the tab's `hello` as another version, dropped it, and dropped everything after
it. It never answered with `welcome`. `FallbackTransport` (ADR-0007, amended) reacts only to the
welcome or to the worker's `error` event, and a script that runs fires no error. So every tab stayed
on a worker that ignored it: no tab coordinated with any other, and nothing was reported. The version
announcement (ADR-0023) could not notice either, because all the tabs were of the same version.
Meanwhile the fallback's record of what the tab had sent kept growing.

## Decision

The exchange that opens a connection to the worker is frozen, from protocol version 5 on, the way
ADR-0023 froze the announcement. Every later version has to keep exactly this:

1. A tab's first message on the port is an object with `type: 'hello'` and the tab's identity, a
   non-empty string, in `from`.
2. A worker answers every such object, whatever its `v`, with an object with `type: 'welcome'`, its
   own protocol version in `v`, and the tab's identity in `to`. Nothing else in another version is
   answered or routed, and the tab is not registered.
3. A tab reads `v` before any other field.

A tab that receives a message in another version on the worker's port therefore knows that the
worker runs another version: a broker passes on only messages in its own version, so nothing else
could have sent it. The tab reports the decode failure, which the client reports as
`PROTOCOL_VERSION_MISMATCH`. Before a welcome in its own version it also treats the worker like one
whose script did not load: nothing the tab sent reached anyone, so `FallbackTransport` replays it
over `BroadcastChannel` and logs `environment.transport-fallback` with
`reason: 'worker-other-protocol-version'`. With `transport: 'sharedworker'` there is nothing to fall
back to, and the mismatch is only reported.

The shapes and the rules are kept in `src/protocol/handshake.ts`.

## Alternatives considered

- **Only report the mismatch.** Smaller, but the tabs would stay cut off from each other although
  `BroadcastChannel` connects them. The report tells the operator what to fix; the fallback keeps
  the application working until then.
- **Put the protocol version into the worker URL**, for instance as a query string. It makes a
  cached old script less likely, but the URL belongs to the application (`workerUrl`), and a file
  copied from another release is the same file whatever the query says.
- **A versionless `hello` on its own channel**, as the announcement does. The worker port already
  connects exactly the two parties concerned; a second channel would only have to be matched up
  with it.

## Consequences

### Positive

- A stale worker script is reported by name in every tab, and the tabs keep coordinating over
  `BroadcastChannel`.

### Negative

- Two more message shapes that can never change. Only their type, the sender identity, and `v` are
  frozen; everything else about them may still change with the protocol version.
- The report reads "Another tab runs an incompatible version of this library", which is worded for
  the announcement; here the other version is the worker script.
- Workers of protocol version 4 and earlier predate the contract and still answer nothing. None of
  them was released.

### Risks and mitigations

- The partition described in ADR-0007's amendment can occur here too. Tabs that fell back close
  their port, and once no tab holds one the stale worker ends; a tab opened after the script was
  fixed starts a new worker and does not hear the tabs on `BroadcastChannel`. Ownership is still the
  Web Lock, so only one tab opens the device. Reloading the older tabs resolves it, which the
  mismatch report already asks for.

## Verification

`test/unit/worker-script.test.ts` (the worker answers a `hello` in another version),
`test/unit/transports.test.ts` and `test/unit/fallback-transport.test.ts` (the tab falls back and
names the reason), and `test/integration/multi-tab/worker-script-fallback.test.ts` (two tabs on a
worker script of another version share the port).

## Amendment (2026-09-14): give up on a worker of another version

### Context

Where a tab cannot fall back, the mismatch was only reported: with `transport: 'sharedworker'`, and
on a worker started in place of one that died (ADR-0021, amended), long after the welcome of the
tab's own version. Such a worker answers `hello` and nothing else, so the tab's heartbeats went
unanswered and it took the worker for dead. It reported `BROKER_UNAVAILABLE`, whose remediation says
the tabs reconnect on their own, and started another worker from the same URL, which ran the same
script - logging `transport.worker-restarted` about every 45 seconds for as long as the tab stayed
open.

### Decision

A message in another version on the worker's port ends the tab's use of workers wherever it does not
fall back. The tab closes its port, stops its heartbeats, starts no other worker, and logs
`transport.worker-other-protocol-version` at `warn`, once. The mismatch is still reported once. A
broker that only stops answering is still taken for dead and replaced.

Only a reload brings the tab onto a worker again, once the page and the script the URL serves are of
the same release. Closing the port lets the stale worker end when no tab holds one any more, as for
tabs that fell back.

### Alternatives considered

- **Keep starting workers, less often.** It would pick up a script fixed on the server while the tab
  stayed open, but only after every tab let go of the stale worker, and never after a new release
  was deployed under the same URL, where the tab itself is the older side.

### Consequences

- Such a tab is cut off until it is reloaded, as before, but says so once, and no longer reports a
  worker that is alive as lost.

### Verification

`test/unit/worker-transport-liveness.test.ts` and
`test/integration/multi-tab/worker-script-fallback.test.ts`.
