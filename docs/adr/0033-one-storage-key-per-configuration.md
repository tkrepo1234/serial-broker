# ADR-0033: One storage key per configuration, with an index of the names

- **Status:** Accepted
- **Date:** 2026-09-14
- **Amends:** ADR-0009, ADR-0022

## Context

ADR-0022 keeps every remembered configuration in one `localStorage` key,
`serial-broker/configurations/v1`, holding a JSON object of name to options. Every write is a
read-modify-write of that object: `save()` reads all of them, replaces one, and writes all of them
back.

`localStorage` gives no atomicity across that sequence. Each tab works from its renderer's cached
copy of the area, and a write reaches the other renderers a moment later; the specification's
storage mutex is implemented by no engine. Two tabs that remember different configurations in the
same moment therefore both read the object as it was, and the one that writes second writes its own
stale copy of the other's entry over the newer one — or, for a name it has never seen, drops it
entirely. It is the classic lost update, and with one key it costs a whole configuration: not a
field, the entry. A tab that saves while another releases loses the same way.

Nothing in the library can lock `localStorage`. What it can do is stop tabs from writing each
other's data at all.

Storage is also the one place where a format from an older version arrives unannounced. Version 1
and the protocol-versioned keys before it (ADR-0022) are still out there in development setups.
Before 1.0 nothing is promised about stored data (see the release policy in CONTRIBUTING.md).

## Decision

Storage version 2 splits the object into one key per configuration, with an index:

- `serial-broker/configurations/v2/index` — a JSON array of the remembered names.
- `serial-broker/configurations/v2/entry/<name>` — the options of that one configuration, exactly
  what `setup()` accepts, as before.

`save()` writes the entry first and adds the name to the index only if the index does not list it
already. Two tabs saving different configurations write different keys, so neither can touch the
other's entry; the index is the only key they share, and the only thing at stake there is a name.
`remove()` takes the name out of the index first and then removes the entry.

Reads are defensive at both levels. An index that is not valid JSON, or not an array, is reported
as `STORAGE_CORRUPT` and removed. An index that is partly rubbish keeps the names in it and is
written back without the rest. A listed name whose entry is unparseable or no longer valid is
reported as `STORAGE_CORRUPT` with its `configName`, removed, and dropped from the index.

A listed name with no entry at all is _not_ reported. With one key per configuration it is an
ordinary outcome of the shared index: a tab that removes a configuration writes the index and the
entry as two operations, and a tab whose copy of the index is older re-lists the name in between.
The name is dropped from the index and logged at `info`; there is nothing the application could
act on, and reporting it would tell a user a configuration they themselves removed was corrupt.
A name whose entry could not be read because storage itself refused stays listed, since nothing
says it is gone.

Nothing is migrated. Version 1 and the protocol-versioned keys are removed, unread, the first time
`restore()` runs, so no copy of them lingers in `localStorage`.

`STORAGE_SCHEMA_VERSION` becomes 2, which also moves the persistence lock of ADR-0027 to
`serial-broker/persisted/v2/<name>` — deliberately: a tab of an older build reads and writes the
old keys, and must not be counted as a tab running a configuration stored in the new ones.

## Alternatives considered

- **Keep one key and merge on write.** Re-read the object, merge in the one changed entry, write it
  back. It is the same read-modify-write; the merge happens on a copy that is already stale.
- **Keep one key and write it from a Web Lock.** Serialises the tabs, but only against each other:
  the lock does not make the renderer's cached copy fresh, so the read inside it can still be stale.
  It would also make every `save()` asynchronous, on a path that runs inside `setup()`.
- **No index, enumerating the keys.** `Storage` has `length` and `key(n)`, so the entries could be
  found by prefix and the shared key would disappear entirely. It widens the narrow storage
  interface of ADR-0014 by two members that every stand-in must then implement faithfully, and it
  makes a restore scan every key of the origin, including those of the application. The index is
  one key, written rarely, and a name lost from it is repaired (see below).
- **One key per configuration without an index.** Nothing could find them.
- **Migrate version 1 into version 2.** A reader for a format nobody has in production, plus its
  tests, to save a click in a development setup. Before 1.0 the answer is to say what breaks.

## Consequences

### Positive

- Two tabs remembering different configurations can no longer lose each other's entry, which was
  possible on every save.
- One unreadable entry costs that configuration alone; the others do not share a key with it any
  more.
- A configuration is one key, so what the browser evicts, a developer edits or a script deletes is
  one configuration.

### Negative

- Storage holds one key per configuration plus one, instead of one. `localStorage` keys are cheap;
  the number of configurations an origin has is small.
- A name can still be lost from the index when two tabs write it in the same moment — the index is
  shared, and nothing can change that. It costs a name, not an entry: the entry stays, and the tab
  that saved it writes its name again as soon as its persistence hold is granted (ADR-0027), which
  is a round trip to the browser's lock manager later. `save()` writes the index only when the name
  is missing, so a tab that has nothing to add cannot be the one to lose it.
- An index that could not be read at all leaves its entries behind, unreadable and unreferenced,
  until the same names are saved again. They are a few hundred bytes of JSON and hold nothing
  sensitive (SECURITY.md).
- A configuration that disappears from storage for a reason nothing else notices — a browser
  evicting one key of an origin, say — is logged and not reported. That case is indistinguishable
  from the far commoner benign one, and an error the application cannot act on is worse than a log
  line it can read.

### Risks and mitigations

- A tab of an older build, open alongside, writes version 1 and has its keys removed by this
  version's next restore. Their formats are not read anyway, and a mixed pair of builds is a
  development situation, not a deployed one.
- The configuration name is now part of a key rather than a value inside one. Names are validated
  before they reach storage: bounded in length, free of control characters and free of unpaired
  surrogates. The name is also the last segment, after a fixed one, so no name can be read as a
  version or as the index key.

## Verification

`test/integration/storage-schema.test.ts`: the shape of the keys, a configuration per key with the
names listed, an unreadable index, an index that is partly rubbish, a listed name whose entry is
gone, the keys of older formats removed unread, and two tabs setting up different configurations at
the same moment. `test/unit/configuration-store.test.ts`: the index written only when the name is
missing, entries of other configurations left alone by a removal, an entry written by another tab
surviving this tab's save, a listed name kept when storage itself refuses, and nothing but an empty
index left once every configuration is removed. `test/integration/hardening-regressions.test.ts`: an invalid entry reported once, and
a name never listed when its entry could not be written.
