# ADR-0022: Version stored configurations separately from the protocol

- **Status:** Accepted, amended by [ADR-0027](./0027-keep-a-remembered-configuration-while-a-tab-runs-it.md) and [ADR-0033](./0033-one-storage-key-per-configuration.md)
- **Date:** 2026-09-13
- **Amends:** ADR-0009

> **Amendment (ADR-0027).** Tabs running a remembered configuration hold a shared Web Lock, and an
> entry is removed only when none does. The lock carries `STORAGE_SCHEMA_VERSION`, not the protocol
> version, for the reason this record gives for the key.

> **Amendment (ADR-0033).** `STORAGE_SCHEMA_VERSION` is 2, and configurations no longer share one
> key: each has its own, `serial-broker/configurations/v2/entry/<name>`, listed in
> `serial-broker/configurations/v2/index`. The key of version 1, and the protocol-versioned keys
> this record moved to it, are removed unread instead of migrated.

## Context

ADR-0009 persists configurations in `localStorage` under `serial-broker/v<PROTOCOL_VERSION>/configurations`.
The protocol version is incremented on any change to a message between tabs (ADR-0008), which has
nothing to do with what is stored: an entry is the options `setup()` accepts, and it is validated
again on every read. Yet each protocol change moved the key, so every configuration a user had
remembered was silently not restored after such an update — four times before the first release.

## Decision

Stored configurations carry a version of their own, `STORAGE_SCHEMA_VERSION` in
`src/storage/configuration-store.ts`, and live under `serial-broker/configurations/v1`. It is
incremented only for a change to the stored format that validation on read cannot absorb.

Reading the current key when it is absent moves the newest entry found under the earlier,
protocol-versioned keys (protocol versions 4 down to 1) to it, then removes those keys. The moved
entries pass the same validation as any other.

## Alternatives considered

- **Keep the key tied to the protocol version.** Simple, and correct in the sense that nothing
  wrong is ever restored — but it discards the user's configurations for a reason that concerns
  them in no way.
- **An unversioned key.** Would work as long as the format never changes, and leaves no way to
  tell an old format from a corrupt entry once it does.
- **A new key without moving the old entries.** Nothing had been released, so little would be
  lost; but the move is a few lines, and without it every development setup loses its
  configurations once more.

## Consequences

### Positive

- A protocol change no longer costs anyone their remembered configurations.
- The storage format can change on its own schedule, with an explicit version to migrate from.

### Negative

- The legacy keys have to be listed explicitly: `localStorage` access goes through a narrowed
  interface (ADR-0014) that cannot enumerate keys.

### Risks and mitigations

- A tab of an older build that is still open writes the old key again. The move only happens while
  the current key is absent, so this leaves a stale key behind and nothing worse.

## Verification

`test/integration/storage-schema.test.ts`: entries under a protocol-versioned key are restored and
the old keys removed; the newest of several wins; a protocol version does not appear in the key.
