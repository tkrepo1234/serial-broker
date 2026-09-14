# ADR-0030: Hold a Web Lock for every term of holding the port

- **Status:** Accepted
- **Date:** 2026-09-14
- **Amends:** ADR-0026, ADR-0025, ADR-0013

## Context

ADR-0026 made every time of holding a configuration's port a **term** with an identifier, and
attributes ownership, write and status messages to it. The identifier is only ever a string in a
message. Two things follow, and both are on the bus, which is open to every script of the origin
(SECURITY.md):

- **A message could invent a term.** One `owner-claimed` naming a term nobody holds made every tab
  that does not hold the port take the real holder's term for succeeded, ignore its statuses,
  address its writes to the invented term and watch them time out - until the port next changed
  hands. `owner-released` was worse: it ended the named term at once, failing a write that term had
  begun with `OWNER_LOST_DURING_WRITE` and leaving the tab with no term to write to. A `status` with
  another `maxTabs` made every tab with a different limit withdraw from the configuration for good
  (ADR-0025).
- **A term that was succeeded ended on a timer.** A term whose holder crashed said nothing more, so
  a tab ended it once `FORMER_OWNER_GRACE_MS` (one second) had passed with no word from it. The
  second was a guess: too short and a slow message turns into a repeated command, too long and
  every failover after a crash waits for it. The guess also depended on messages, so a script could
  keep a dead term alive by sending in its name, or start the wait by claiming a term.

What both need is a statement about a term that a message cannot make. The browser already makes
one about ownership: a Web Lock is held or it is not, every context sees the same answer, and the
browser frees it when the holder dies (ADR-0005). Nothing else in a browser has that property.

Writes were also taken from the wrong source. `write-started` and `write-result` were believed from
any sender: a script that read a request id off the channel - every `write-request` reaches every
tab on the `BroadcastChannel` - could resolve a write whose bytes were still queued at the port, or
mark a write started that nobody was writing, stranding it. And `data-received` was delivered to the
application from any sender at all.

## Decision

Every term is a Web Lock, and the tab that holds the port holds it for the whole term:

```text
serial-broker/term/v<protocol>/<maxTabs>/<term>/<clientId>/<configName>
```

The name carries everything a tab must check before believing what is said in the term's name: the
term, the context speaking for it, and the tab limit that context runs the configuration with. The
configuration name comes last, because it is the only one of the four that may contain a `/`.
`owner-claimed` therefore carries `maxTabs` as `status` does, and the protocol version becomes 8.

- The tab granted ownership takes the term's lock **before** its first word in the term -
  `owner-claimed`, the port, every status - and lets it go **after** its last, `owner-released`.
- Before it lets the lock go, it queues a second request of its own on the same lock: the
  **goodbye request**. It is granted once the tabs watching the term have looked, and let go again.
- Every other tab checks the lock with `ifAvailable` when it first hears of a term, and queues for
  it in `shared` mode to learn when the term is over.

From that, four rules:

1. **A claim or a status is believed only while the term's lock is held.** A message naming a term,
   a sender or a tab limit that no held lock names is not about a term of this configuration, and
   changes nothing. The messages of a term still being checked wait for the answer, in order.
2. **A term ends when its lock is free** - exactly when the browser frees it, with no grace period
   and no timer - **unless its holder is letting go cleanly**, which the goodbye request queued on
   the lock says. Then the term ends at its `owner-released`, the last message it sends, so that
   everything it said about its writes has arrived first (ADR-0026).
3. **A goodbye is believed only from the term's own holder, and only while that goodbye request is
   queued.** So no message ends a term whose holder is still writing to the device.
4. **`maxTabs` is believed because it is part of the lock's name.** A tab withdraws for a tab limit
   the tab holding the port demonstrably runs, never for one a message claims.

The session takes the same line with the rest of what a term says:

- `write-started` and `write-result` count only from the term the write was addressed to, and only
  from the context that speaks for that term. A result from anywhere else concerns a copy that
  reached the wrong tab, or was forged.
- `data-received` and `data-sent` are delivered only from a context that speaks for a term this tab
  knows of - the one holding the port, one still being waited for, or one being checked.

`FORMER_OWNER_GRACE_MS` and the tracker's timers are gone; `OwnerTerms` now holds lock requests
instead.

## Alternatives considered

- **Keep the grace period and only check claims against a lock.** Half the benefit: a crashed
  holder's term would still end a second late, and the period would still be a guess. The lock says
  exactly when the term is over, which is the number the guess was approximating.
- **One lock per term, without the sender and the limit in its name.** A tab would then have to
  take the sender and the limit from the message itself, which is what the forged `status` with
  another `maxTabs` abused. Checking a tab-slot lock instead (`serial-broker/tab-slot/...`) proves
  that _somebody_ runs that limit, not that the tab holding the port does, and costs one request per
  place - up to a hundred.
- **`locks.query()` for everything.** The snapshot is stale the moment it is taken, and a query
  answers only about the moment it ran; a queued request is a standing subscription to the end of a
  term. Query is used for one thing only: seeing the goodbye request, which is a fact about a queue
  rather than about a holder.
- **End a term when its lock is free, in the clean case too.** Simpler, and wrong in the common
  case: a tab that lets go sends its last results, its goodbye and then frees the lock, and the
  lock's release can reach another tab before those messages do - the defect ADR-0026 exists to fix.
- **Let the departing tab hold the lock for a while after its goodbye.** A timer again, and a
  closing tab - the usual case - has its locks freed by the browser at once anyway.
- **Sign or authenticate messages.** There is no key a script of the origin could not read, by the
  first assumption of SECURITY.md.

## Consequences

### Positive

- A forged message can no longer end a live term, invent a term, make a tab withdraw over a tab
  limit, resolve or strand a write, or deliver device data that never arrived.
- The end of a crashed holder's term is exact, and failover no longer waits out a second.
- No timer decides anything about a term, so a hidden or frozen tab - whose timers run up to a
  minute late - is no slower to notice than any other.
- Both transports behave identically, as the locks are not messages (ADR-0007).

### Negative

- Becoming the owner costs one lock round trip before the claim goes out.
- Each tab keeps one queued lock request per term it has heard of, and one `ifAvailable` request per
  term it checks.
- A tab that learns of a term only when the browser has already freed its lock refuses the term's
  messages. It never addressed a write to that term, so nothing is lost - but a status of it is
  ignored, and the tab waits for the next one.
- Reading `locks.query()` is now part of a decision. Where a browser does not expose it, a clean end
  cannot be told from a crash: every term then ends when its lock is free.

### Risks and mitigations

- **A word from a crashed holder that arrives after the browser freed its lock is too late.** A tab
  that crashes in the moment between handing bytes to the device and its `write-started` arriving
  leaves a write that looks like one it never received; it is handed to the next tab and may reach
  the device twice. ADR-0026 covered a second of such delay and called the rest unknowable; this
  covers none, in exchange for an exact end. The window is the transit of one message against the
  teardown of a crashed renderer, and only for a write in flight at that instant.
- **A script of the origin can take Web Locks**, as SECURITY.md says. It can hold a lock named for a
  term it invented and have that term believed, or queue an exclusive request on a real term's lock
  so that tabs wait for a goodbye that never comes. Both are beyond what a message alone can do, and
  a script that takes locks can already keep every tab away from the device.

## Verification

`test/unit/owner-terms.test.ts` covers the rules against a lock manager: a claim believed only when
the lock is held, a term kept alive while it is held, the exact end when the holder dies, the wait
for a goodbye when it does not.
`test/integration/multi-tab/hostile-bus.test.ts` posts the forged claim, status, goodbye, write
result and device data as a script of the origin, on the `BroadcastChannel`.
`test/integration/multi-tab/failover.test.ts` and `handover-races.test.ts` cover the exact end after
a crash and the clean handover heard out of order, in both transport modes;
`test/unit/pending-writes.test.ts` covers a write started or answered by another term.
