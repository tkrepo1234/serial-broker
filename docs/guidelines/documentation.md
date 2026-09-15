# Documentation

Documentation is part of the deliverable, not a follow-up task. A change that alters
behaviour and does not touch documentation is incomplete.

Style follows the **MDN Writing Style Guide**: second person, present tense, active voice,
short sentences, no marketing language, no "simply"/"just"/"obviously".

## Layers

| Artefact                   | Audience                                        | Rule                                                                                                          |
| -------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **TSDoc in source**        | Developers via IDE and generated API docs       | Every exported symbol.                                                                                        |
| **README.md**              | Someone deciding whether to use this            | Working example within the first screen.                                                                      |
| **docs/site/internals.md** | Someone modifying the library                   | Explains the mechanism, not the API.                                                                          |
| **docs/adr/**              | Future maintainers asking "why is it like this" | One decision per record, immutable once accepted.                                                             |
| **CHANGELOG.md**           | Upgraders                                       | Keep a Changelog format, every user-visible change.                                                           |
| **docs/site/**             | Application developers                          | Chapters and examples, built by `npm run docs`, which fails on any warning; the example code is type-checked. |
| **debug/**                 | Someone operating or testing a deployment       | Ships in `dist/debug/`; type-checked and linted.                                                              |

## TSDoc rules

Every exported symbol carries a doc comment with:

- A one-sentence summary in the imperative ("Registers a configuration…"), then a blank line,
  then detail.
- `@param` for every parameter, stating **units, valid ranges and defaults**.
- `@returns` describing the value _and_ when the promise settles.
- `@throws` listing every error `code` the call can produce, with the condition.
- `@remarks` for behaviour that is not obvious from the signature — especially anything
  about cross-tab effects, user-gesture requirements, or persistence.
- `@example` with runnable code for every public method.
- `@defaultValue` on every optional option property.

````ts
/**
 * Sends data to the device.
 *
 * The write is performed by whichever tab currently owns the port; the caller does not have
 * to be that tab and cannot tell whether it is. Writes issued by one tab reach the device in
 * the order that tab issued them; writes from different tabs have no defined relative order.
 *
 * @param name - The configuration name passed to {@link SerialBrokerApi.setup}.
 * @param data - Text, encoded as UTF-8, or raw bytes. Nothing is appended.
 * @returns A promise that resolves once the browser has taken the bytes for the port - not once
 *   the device has received them, which Web Serial does not report.
 * @throws A {@link SerialBrokerError} with code `UNKNOWN_CONFIGURATION` if `name` is not set
 *   up in this tab, `INVALID_ARGUMENT` for a string while an encoding other than UTF-8 is
 *   configured, `WRITE_TIMEOUT` if no connection took the write within
 *   `connection.writeTimeoutMs`, or `WRITE_FAILED` if the device rejected it.
 * @example
 * ```ts
 * await SerialBroker.send('CardReader', 'STATUS?\r\n');
 * await SerialBroker.send('CardReader', new Uint8Array([0x02, 0x41, 0x03]));
 * ```
 */
````

Do not document the obvious (`@param name - The name.`). Either say something useful or
leave the tag out and let the type speak.

## Terminology

Use these words and only these words, in code, comments and prose:

| Term              | Meaning                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| **configuration** | A named set of device filter + serial settings. The unit of everything.                                |
| **owner**         | The browser context that currently holds the physical port. (Internal only — never in the public API.) |
| **participant**   | Any context attached to a configuration.                                                               |
| **broker**        | The `SharedWorker` that routes messages between participants.                                          |
| **payload**       | The bytes on the wire. Never "message" — that is a protocol-layer concept.                             |
| **frame**         | Reserved for the protocol layer. This library has no frames.                                           |

Banned: "master/slave" in code and documentation — the role is **owner**, the others are
**participants**. ([ADR-0005](../adr/0005-owner-election-via-web-locks.md) explains the
mechanism; the user-facing request used the word "master", and the implementation uses "owner"
consistently. Application-facing documentation says "the tab that holds the port".)

## ADRs

Format: MADR-derived, see [`0000-template.md`](../adr/0000-template.md).

- One decision per record. Numbered sequentially, never renumbered.
- **One current record per decision** ([ADR-0001](../adr/0001-record-architecture-decisions.md)).
  A decision that changes is folded into its current record, which is rewritten to state the
  decision as it now stands and gains a one-line entry under **History**. No amendments are
  appended.
- A record whose decision was replaced, merged into another or retired becomes a stub of about ten
  lines - `Superseded by ADR-NNNN (date)`, the original decision in one sentence, a one-line trail -
  and keeps its number and file, so citations still resolve.
- `docs/adr/README.md` lists the current records and the superseded trail.
- Every ADR states what was **rejected** and why. An ADR without alternatives is a note, not
  a decision record.
- Code that exists because of an ADR references it: `// See ADR-0005.`
