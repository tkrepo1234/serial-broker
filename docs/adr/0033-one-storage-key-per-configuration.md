# ADR-0033: One storage key per configuration, with an index of the names

- **Status:** Accepted
- **Date:** 2026-09-14

## Context

A released port is to be remembered and reused on the next visit without prompting the user again.
The permission to use the port belongs to the browser and persists on its own
([ADR-0036](./0036-take-the-device-identity-from-the-chosen-port.md)); the configuration - which
device, which serial settings - is ours to store, in `localStorage`.

Three forces shape how:

- **The protocol version changes often, the stored format rarely.** A stored entry is the options
  `setup()` accepts, validated again on every read. Tying the key to the protocol version silently
  lost every remembered configuration at each protocol change - four times before the first
  release.
- **`localStorage` gives no atomicity.** Each tab works from its renderer's cached copy of the
  area, and a write reaches the other renderers a moment later; the specification's storage mutex
  is implemented by no engine. With all configurations in one key, two tabs remembering different
  configurations in the same moment wrote each other's stale copy back - the classic lost update,
  costing a whole configuration.
- **An entry belongs to the origin, `release()` to one tab.** A tab that released a configuration
  while other tabs still ran it took it from all of them: their next reload restored nothing.

## Decision

**The stored format has a version of its own**, `STORAGE_SCHEMA_VERSION` in
`src/storage/configuration-store.ts`, incremented only for a change to what is stored that
validation on read cannot absorb.

**One key per configuration, with an index:**

- `serial-broker/configurations/v<storage version>/index` — a JSON array of the remembered names.
- `serial-broker/configurations/v<storage version>/entry/<name>` — the options of that one
  configuration, exactly what `setup()` accepts. For an auto-mode configuration the `device`
  carries its resolution (ADR-0036).

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

**An entry is forgotten only when no tab still runs the configuration with `remember: true`.**
Every such tab holds the Web Lock `serial-broker/persisted/v<storage version>/<name>` in **shared**
mode while the configuration is set up there. A tab that forgets the entry - on `release()`,
`releaseAll()`, or setting the name up with `remember: false` - first lets its own hold go, then
requests the lock **exclusively with `ifAvailable`**, and removes the entry only inside that lock.
`dispose()`, what a closing tab does, forgets nothing. A tab saves its entry at `setup()` and again
once its hold is granted, which also repairs a name lost from the index. The lock carries the storage
version, not the protocol version, because tabs on different protocol versions share the stored
entries. `release(name, { forgetDevice: true })` follows the same rule for the entry; the browser
permission it revokes is the origin's.

**Nothing is migrated.** Keys of an earlier format are neither read nor removed. Before 1.0 nothing
is promised about stored data (CONTRIBUTING.md).

## Alternatives considered

- **Keep the key tied to the protocol version.** Nothing wrong is ever restored, but the user's
  configurations are discarded for a reason that concerns them in no way.
- **An unversioned key.** Leaves no way to tell an old format from a corrupt entry once it changes.
- **One key, merged on write, or written from a Web Lock.** The merge happens on a copy that is
  already stale, and a lock does not make the renderer's cached copy fresh either.
- **No index, enumerating the keys.** Widens the narrow storage interface
  ([ADR-0014](./0014-dependency-injection-of-the-environment.md)) and makes a restore scan every key
  of the origin, including the application's.
- **Migrate earlier formats, or remove their keys on restore.** The first move from protocol-versioned
  keys was migrated (2026-09-13), and version 1's keys were removed unread (2026-09-14). Both served
  development setups only, and the removal was dropped with the rest of the reduction.
- **Put the entry back on the `storage` event.** Leaves a window in which the entry is absent, and
  nobody puts it back when the other tabs are frozen or the browser closes right after the release.
- **Ask the broker which tabs are attached.** Unavailable in the fallback, and a round trip to a
  worker that may have ended.
- **Keep a list of running tabs in the entry.** A crashed tab never removes itself.
- **Never forget on `release()`.** `release()` is how an application says a configuration is not
  wanted any more.

## Consequences

### Positive

- A protocol change no longer costs anyone their remembered configurations.
- Two tabs remembering different configurations can no longer lose each other's entry, and one
  unreadable entry costs that configuration alone.
- Releasing a configuration in one tab no longer costs the other tabs their configuration on
  reload, and a crashed or closed tab never keeps an entry alive.

### Negative

- A name can still be lost from the index when two tabs write it in the same moment. It costs a name,
  not an entry, and the tab that saved it lists it again once its hold is granted.
- An index that could not be read, or a removal racing a write, leaves unreferenced entries behind;
  so do keys of earlier formats. They are a few hundred bytes of JSON, never read again, and hold
  nothing sensitive.
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
stale tab's save. `test/integration/storage-schema.test.ts` covers the shape of the keys, an
unreadable or partly broken index, and a listed name whose entry is gone.
`test/integration/multi-tab/remembered-configurations.test.ts`, in both transport modes: a release
while another tab runs the configuration, the last release, a closed and a crashed tab,
`releaseAll()`, `forgetDevice`, a tab with `remember: false`, and a setup racing a release.

## History

- 2026-09-12: Configurations remembered in one protocol-versioned key (ADR-0009).
- 2026-09-13: A storage version of its own, migrating the old keys (ADR-0022).
- 2026-09-14: Remembered while any tab runs it, by a shared lock (ADR-0027); one key per
  configuration, version 2, older keys removed unread.
- 2026-09-15: The option is `remember` (was `persist`); older keys are no longer removed. ADR-0022
  and ADR-0027 folded in.
