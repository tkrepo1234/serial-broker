# ADR-0030: Hold a Web Lock for every term of holding the port

- **Status:** Accepted
- **Date:** 2026-09-14

## Context

[ADR-0013](./0013-write-ordering-and-delivery-semantics.md) lets the tab that issued a write decide
its fate: not repeatable once it has let the tab holding the port begin it (originally: once that tab
reported `write-started`), settled by `write-result`, and - when that tab is gone - failed if it had
started, handed on if it had not.
Everything depends on knowing when the tab holding the port is gone and when its last word has
arrived.

A new owner's `owner-claimed` proves less than it seems. The ownership lock cannot be granted while
it is held ([ADR-0005](./0005-owner-election-via-web-locks.md)), so a claim proves that the former
owner let go of the lock - not that its last messages have arrived. They come from another sender,
and nothing orders the messages of two senders: not the `BroadcastChannel`, and not a busy main
thread. Two defects followed, both reproduced: a write that succeeded failed with
`OWNER_LOST_DURING_WRITE`, and a write reached the device twice, handed to the new owner before the
former owner's `write-started` arrived.

The bus is also open to every script of the origin (SECURITY.md). A message could invent a term,
end a live one, state another tab limit, resolve a write whose bytes were still queued, or deliver
device data that never arrived. What is needed is a statement about a term that a message cannot
make. The browser makes one about Web Locks: a lock is held or it is not, every context sees the
same answer, and the browser frees it when the holder dies.

## Decision

**Every time of holding a configuration's port is a term, and every term is a Web Lock**, held by
the tab holding the port for the whole term:

```text
serial-broker/term/v<protocol>/<maxTabs>/<term>/<clientId>/<configName>
```

The name carries everything a tab must check before believing what is said in the term's name: the
term identifier, created by the tab granted ownership; the context speaking for it; and the tab
limit that context runs ([ADR-0025](./0025-limit-the-tabs-using-a-configuration.md)). The
configuration name comes last, because it is the only part that may contain a `/`.

- **The term lock is taken inside the election.** The ownership lock's callback takes the term's
  lock before the context counts as the owner; a term lock the browser refuses lets the ownership
  lock go too, and both are requested again. No tab holds the ownership lock without a term.
- **Messages name their term.** `owner-claimed`, `owner-released`, `status` and `write-ready`
  (originally `write-started`) carry the sender's term; `owner-claimed` and `status` carry its
  `maxTabs`. A `write-request` names the term it is **addressed** to, and only the tab holding that
  term writes it.
- **A term ends cleanly in a fixed order.** The holder closes the port, waits until every write it
  performed has been answered (bounded by `writeTimeoutMs`), queues a second request of its own on
  the term's lock - the **goodbye request** - sends `owner-released` as the term's last message,
  and lets the lock go.
- **Every other tab** checks the lock with `ifAvailable` when it first hears of a term, and queues
  for it in `shared` mode to learn when the term is over.

From that, four rules:

1. **A claim or a status is believed only while the term's lock is held.** A message naming a term,
   a sender or a tab limit that no held lock names changes nothing. Messages of a term still being
   checked wait for the answer, in order.
2. **A term ends when its lock is free** - exactly when the browser frees it, with no grace period and
   no timer - **unless its holder is letting go cleanly**, which the goodbye request queued on the
   lock says. Then the term ends at its `owner-released`, so that everything it said about its
   writes has arrived first.
3. **A goodbye is believed only from the term's own holder, and never before the browser has freed
   the term's lock.** Anyone of the origin can queue a request on a term's lock, so what a queued
   request means is only asked of a lock that is free, where a crash leaves nothing queued. No
   message ends a term whose holder is still writing to the device.
4. **`maxTabs` is believed because it is part of the lock's name.**

**One table decides who may say what** (`OwnerTerms.authorize()`): claims and statuses once their
term's lock is held; `write-ready` and `write-result` only from the term the write was addressed to
and the context speaking for it; `data-received`, `data-sent` and `error` only from a context
speaking for a term this tab knows of. A tab that has just joined knows no term until the status it
asked for arrives, so device data reaching it in that window is dropped, logged once per
configuration (`session.data-without-a-term`).

Once a term has ended, a write it began and did not answer fails with `OWNER_LOST_DURING_WRITE`, and
a write addressed to it that it never began is handed to the term holding the port now. A tab that
does not hold the addressed term ignores the request, so a former holder sends nothing back; the
issuer hands the write on once the term has ended.

**One flood bound.** `MAX_TERM_FLOOD` bounds the terms a tab keeps and the messages waiting on one
term's check. Past it, what is over is forgotten first, then the oldest check, so the newest claim -
the one that can be the real holder - is always checked. A check the browser refuses says nothing
about the term: the tab forgets it, and the next message naming it is checked afresh. Only a granted
`ifAvailable` request refuses a term.

## Alternatives considered

- **Keep the claim as the proof, and wait a fixed delay after it.** A clean handover then waits for
  nothing, and a late message cannot be attributed to the old owner or the new.
- **Term identifiers without locks, a succeeded term ending after a grace period.** What ADR-0026
  decided on 2026-09-14: one second without a word. Too short and a slow message becomes a repeated
  command, too long and every failover waits; and a message could invent a term, or keep a dead one
  alive.
- **Order all messages through one sequencer.** The fallback has no broker, and a busy tab does not
  process queued tasks in a defined order either.
- **Number the terms.** A new owner cannot know the number of a term it never heard of, and storage
  shared between tabs is updated asynchronously across processes.
- **Have the new owner ask the old one what it accepted.** The old one may have crashed, which is the
  case that matters.
- **One lock per term, without the sender and the limit in its name.** The tab would take them from
  the message, which is what a forged `status` with another `maxTabs` abused.
- **`locks.query()` for everything.** Stale the moment it is taken. Query is used for one thing only:
  seeing the goodbye request, a fact about a queue rather than a holder.
- **End a term when its lock is free, in the clean case too.** The lock's release can reach another
  tab before the holder's last messages do - the defect this record exists to fix.
- **Sign or authenticate messages.** There is no key a script of the origin could not read.

## Consequences

### Positive

- A clean handover no longer fails a write that succeeded, and no longer writes one twice, on either
  transport.
- A forged message can no longer end a live term, invent a term, make a tab withdraw over a tab
  limit, resolve or strand a write, or deliver device data that never arrived.
- The end of a crashed holder's term is exact, and no timer decides anything about a term, so a
  hidden or frozen tab is no slower to notice than any other.

### Negative

- Becoming the owner costs one lock round trip before the claim goes out; the other tabs show
  `reconnecting` only once the departing owner has closed the port.
- Each tab keeps one queued lock request per term it has heard of, and one `ifAvailable` request per
  term it checks.
- A tab that learns of a term only after the browser freed its lock ignores the term's messages and
  waits for the next status.
- Where a browser does not expose `locks.query()`, a clean end cannot be told from a crash: every
  term then ends when its lock is free.

### Risks and mitigations

- **A word from a crashed holder that arrives after the browser freed its lock is too late.** Until
  2026-09-15 that let a write look unstarted whose `write-started` a crash delayed: it was handed on
  and could reach the device twice. Since the holder asks the issuing tab before it begins, and that
  tab counts what it let begin as begun, a late word no longer changes whether a write began
  ([ADR-0013](./0013-write-ordering-and-delivery-semantics.md)); only a late result is lost, and the
  write is `OWNER_LOST_DURING_WRITE`.
- **A script of the origin can take Web Locks.** It can hold a lock named for a term it invented, or
  queue on a real term's lock so that tabs wait for a goodbye that never comes - a delay, never an
  end. A script that takes locks can already keep every tab away from the device.
- **A tab that joins while a device streams misses what arrives before it knows the term** - one
  round trip across the bus, longer where the answer waits for the status answer rate
  ([ADR-0031](./0031-bound-and-rate-limit-what-the-bus-can-cost-a-tab.md)).

## Verification

`test/unit/owner-terms.test.ts` covers the rules against a lock manager; `test/unit/pending-writes.test.ts`
a write started or answered by another term. `test/integration/multi-tab/handover-races.test.ts`
reproduces both handover defects with messages from the former owner held back, and
`failover.test.ts` the exact end after a crash, in both transport modes.
`test/integration/multi-tab/hostile-bus.test.ts` posts forged claims, statuses, goodbyes, write
results and device data as a script of the origin, including a goodbye with a request of the
script's own queued on the real term's lock; `session-regressions.test.ts` covers a clean release.
