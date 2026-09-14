# ADR-0027: Keep a remembered configuration while any tab runs it

- **Status:** Accepted
- **Date:** 2026-09-14
- **Amends:** ADR-0009, ADR-0022

## Context

ADR-0009 remembers configurations in `localStorage`, and `release(name)` removes the entry. The
entry is one per name for the whole origin (ADR-0022), but `release()` is a call in one tab. A tab
that releases a configuration while other tabs still run it therefore took it from all of them:
their next reload restored nothing, although nothing in those tabs had changed. The debugging
surface's _Disconnect_ does the same to the application's own configuration.

A tab that is closed, reloaded or crashes does not release anything, and its entry stays: that is
what brings the configuration back on the next visit.

Nothing tells a tab which other tabs run a configuration. The broker knows the tabs attached to it,
but the `BroadcastChannel` fallback has none, the broker is not asked about storage, and it notices
a dead tab only after three minutes (ADR-0021).

## Decision

A remembered entry is forgotten only when no tab still runs the configuration with `persist: true`.

Every tab running a configuration with `persist: true` holds the Web Lock
`serial-broker/persisted/v<STORAGE_SCHEMA_VERSION>/<name>` in **shared** mode for as long as the
configuration is set up there. A tab that forgets the entry - on `release()`, `releaseAll()`, or
setting the name up with `persist: false` - first lets its own hold go, then requests the lock
**exclusively with `ifAvailable`**, and removes the entry only inside that lock. If any tab holds it,
nothing is removed. `dispose()`, which is what a closing tab does, lets the hold go and forgets
nothing.

A tab saves its entry at `setup()`, as before, and saves it again once its hold is granted. A tab
that set the name up while another was forgetting it is queued behind that exclusive lock, so the
second save always comes after the removal.

The lock is versioned with the stored format, not with the protocol: tabs on different protocol
versions share the stored entries (ADR-0022), and so share this lock.

`release(name, { forgetDevice: true })` follows the same rule. It revokes the browser's permission,
which is the origin's and so affects every tab; the configuration the other tabs run stays
remembered, and waits for permission on the next visit.

## Alternatives considered

- **Put the entry back on the `storage` event.** The releasing tab removes the entry; every tab still
  running the configuration hears the `storage` event and writes it again. It needs a new injected
  listener and no lock, but it leaves a window in which the entry is absent: a tab reloading in that
  moment restores nothing, and when the other tabs are frozen or discarded in the background, or the
  browser is closed right after the release, nobody puts it back at all. ADR-0005 rejected storage
  events for coordination for the same kind of reason. The shared lock never removes an entry that
  is still needed, and needs no tab to be awake.
- **Ask the broker which tabs are attached.** Unavailable in the fallback, wrong for three minutes
  after a crash, and a round trip to a worker that may have died.
- **Keep a list of running tabs in the entry.** A crashed tab never removes itself, so the entry
  could never be forgotten again.
- **Never forget on `release()`.** Simple, but `release()` is how an application says a
  configuration is not wanted any more.

## Consequences

### Positive

- Releasing a configuration in one tab no longer costs the other tabs their configuration on
  reload, on both transports.
- A crashed or closed tab never keeps an entry alive: the browser lets its lock go (ADR-0005).
- Nothing new is injected; the lock manager is already part of the environment (ADR-0014).

### Negative

- One more held lock per remembered configuration per tab, visible in diagnostics, and the only lock
  this library takes in shared mode.
- The options remembered are those of the tab that saved last. A tab that releases does not rewrite
  the entry with the options of a tab that keeps running.
- A tab of a build before this decision holds no lock; releasing there still removes the entry.

### Risks and mitigations

- Where the browser refuses the lock request, the entry is kept rather than removed: a configuration
  restored once too often is set up and can be released again; one forgotten too early is lost.

## Verification

`test/integration/multi-tab/remembered-configurations.test.ts`, in both transport modes: a release
while another tab runs the configuration, the last release, a closed and a crashed tab, `releaseAll()`,
`forgetDevice`, a tab with `persist: false`, and a setup racing a release. The shared mode of the
fake lock manager has conformance tests in `test/harness/harness-conformance.test.ts`.
