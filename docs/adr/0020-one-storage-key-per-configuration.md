# ADR-0020: Remembered configurations: one storage key each, kept while any tab runs them

- **Status:** Accepted

## Context

A released port is to be remembered and reused on the next visit without prompting the user again.
The permission to use the port belongs to the browser and persists on its own
([ADR-0022](./0022-take-the-device-identity-from-the-chosen-port.md)); the configuration - which
device, which serial settings - is ours to store, in `localStorage`.

Three forces shape how:

- **The protocol version changes often, the stored format rarely.** A stored entry is the options
  `setup()` accepts, validated again on every read. A key tied to the protocol version would silently
  lose every remembered configuration at each protocol change.
- **`localStorage` gives no atomicity.** Each tab works from its renderer's cached copy of the
  area, and a write reaches the other renderers a moment later; the specification's storage mutex
  is implemented by no engine. With all configurations in one key, two tabs remembering different
  configurations in the same moment write each other's stale copy back - the classic lost update,
  costing a whole configuration.
- **An entry belongs to the origin, `release()` to one tab.** A tab that releases a configuration
  while other tabs run it must not take it from all of them: their next reload would restore
  nothing.

## Decision

**The stored format has a version of its own**, `STORAGE_SCHEMA_VERSION` in
`src/storage/configuration-store.ts`, incremented only for a change to what is stored that
validation on read cannot absorb.

**One key per configuration, with an index:**

- `serial-broker/configurations/v<storage version>/index` - a JSON array of the remembered names.
- `serial-broker/configurations/v<storage version>/entry/<name>` - the options of that one
  configuration, exactly what `setup()` accepts. For an auto-mode configuration the `device`
  carries its resolution (ADR-0022).

`save()` writes the entry first and adds the name to the index only if the index does not list it
already. `remove()` takes the name out of the index first and removes the entry once that write has
landed; a name the index does not list is not touched.

**Reads are defensive at both levels.** An index that is not valid JSON, or not an array, is
removed, and `load()` reports it as `STORAGE_CORRUPT`; a save or a removal that finds it removes it
quietly. An index that is partly rubbish keeps the names in it and is written back without the rest.
A listed name whose entry is unparseable or invalid is reported as `STORAGE_CORRUPT` with its
`configName`, removed, and dropped from the index. A listed name with **no** entry is an ordinary
outcome of the shared index - another tab removed it while this one's copy was stale - so it is
dropped and logged at `info`, not reported. A name whose entry storage itself refused to read stays
listed.

**Forgetting is asked for, never a side effect of releasing.** `release(name)` stops using the
configuration in this tab and closes the port if this tab held it; what is remembered stays, so
`restore()` and a later `setup()` bring it back. `release(name, { forget: true })` removes the
remembered entry as well. `forgetDevice` revokes the browser's permission and is independent of
both; the two together remove every trace of the configuration in this browser. Setting the name up
with `remember: false` still forgets an entry an earlier setup left behind - otherwise `restore()`
would bring back a configuration the application has just said not to remember.

**An entry is forgotten only when no tab still runs the configuration with `remember: true`.**
Every such tab holds the Web Lock `serial-broker/persisted/v<storage version>/<name>` in **shared**
mode while the configuration is set up there. A tab that forgets the entry - on
`release(name, { forget: true })`, `releaseAll({ forget: true })`, or setting the name up with
`remember: false` - first lets its own hold go, then requests the lock **exclusively with
`ifAvailable`**, and removes the entry only inside that lock. A release that forgets nothing lets
its hold go too, and nothing else: the tab has stopped running the configuration, and a hold kept
past that would refuse every other tab's `forget` for the life of the tab. `dispose()`, what a
closing tab does, does the same. A tab saves its entry at `setup()` and again once its hold is
granted, which also repairs a name lost from the index. The lock carries the storage version, not
the protocol version, because tabs on different protocol versions share the stored entries.
`forget` on a configuration set up with `remember: false` finds nothing stored under the name and
does nothing, rather than reporting anything: the option names what must not survive, and nothing
does.

**Nothing is migrated.** Keys of another storage version are neither read nor removed. Before 1.0
nothing is promised about stored data (BACKLOG.md, standing constraints).

## Alternatives considered

- **Tie the key to the protocol version.** Nothing wrong is ever restored, but the user's
  configurations are discarded for a reason that concerns them in no way.
- **An unversioned key.** Leaves no way to tell an old format from a corrupt entry once it changes.
- **One key, merged on write, or written from a Web Lock.** The merge happens on a copy that is
  already stale, and a lock does not make the renderer's cached copy fresh either.
- **No index, enumerating the keys.** Widens the narrow storage interface
  ([ADR-0012](./0012-dependency-injection-of-the-environment.md)) and makes a restore scan every key
  of the origin, including the application's.
- **Migrate other storage versions, or remove their keys on restore.** It buys a tidy
  `localStorage` with code that has to keep every format the library ever wrote readable. A stale key costs a few hundred bytes and holds
  nothing sensitive.
- **Put the entry back on the `storage` event.** Leaves a window in which the entry is absent, and
  nobody puts it back when the other tabs are frozen or the browser closes right after the release.
- **Ask the broker which tabs are attached.** Unavailable in the fallback, and a round trip to a
  worker that may have ended.
- **Keep a list of running tabs in the entry.** A crashed tab never removes itself.
- **Forget on every `release()`**, on the reading that `release()` is how an application says a
  configuration is not wanted any more. It makes a disconnect a deletion: with one tab open - the
  normal case on a production line - pressing _Disconnect_ takes the entry with it, and the next
  visit has nothing to restore. Closing a port and deleting its configuration are different
  intentions, and only the caller knows which one it means.
- **Never forget at all, and let the application clear storage itself.** The entries are in keys
  this library owns, names and versions; reaching into them from outside is what this record exists
  to avoid.
- **Let `forgetDevice: true` imply `forget: true`.** Reads well for "remove everything", and hides a
  deletion behind an option about the browser's permission. They are two stores, kept by two
  parties; each is asked for separately.

## Consequences

### Positive

- A protocol change costs nobody their remembered configurations.
- Two tabs remembering different configurations cannot lose each other's entry, and one
  unreadable entry costs that configuration alone.
- Releasing a configuration in one tab does not cost the other tabs their configuration on
  reload, and a crashed or closed tab never keeps an entry alive.
- A tab that disconnects keeps its configuration for the next visit, whether or not any other tab
  runs it. Only a caller that asked to forget it loses it.

### Negative

- A name can be lost from the index when two tabs write it in the same moment. It costs a name,
  not an entry, and the tab that saved it lists it again once its hold is granted.
- An index that could not be read, or a removal racing a write, leaves unreferenced entries behind;
  so do keys of another storage version. They are a few hundred bytes of JSON, never read again,
  and hold nothing sensitive.
- One more held lock per remembered configuration per tab. The options remembered are those of the
  tab that saved last.
- A configuration that disappears from storage for a reason nothing else notices is logged, not
  reported: it cannot be told from the far commoner benign case.

### Risks and mitigations

- Where the browser refuses the lock request, the entry is kept rather than removed: a configuration
  restored once too often can be released again; one forgotten too early is lost.
- The configuration name is part of a key. Names are validated before they reach storage - bounded,
  no control characters, no unpaired surrogates - and are the last segment, after a fixed one.

## Verification

`test/unit/configuration-store.test.ts` holds the proof of the lost update: two stores over the same
entries, one reading from a copy taken before the other's write, and the newer entry survives the
stale tab's save, and covers a listed name whose entry is gone and storage that refuses one entry.
`test/integration/permission-and-persistence.test.ts` ("the layout of remembered configurations")
covers the shape of the keys and an unreadable or partly broken index.
`test/integration/multi-tab/remembered-configurations.test.ts`, in both transport modes: a release
that forgets nothing and the `restore()` that brings the configuration back, `forget: true` while
another tab runs the configuration, the last release, a closed and a crashed tab,
`releaseAll({ forget: true })`, `forgetDevice`, `forget` on a configuration with `remember: false`,
and a setup racing a release.
