# Documentation

Documentation is part of the deliverable, not a follow-up task. A change that alters
behaviour and does not touch documentation is incomplete.

Style follows the **MDN Writing Style Guide**: second person, present tense, active voice,
short sentences, no marketing language, no "simply"/"just"/"obviously".

## Layers

| Artefact                 | Audience                                        | Rule                                                |
| ------------------------ | ----------------------------------------------- | --------------------------------------------------- |
| **TSDoc in source**      | Developers via IDE and generated API docs       | Every exported symbol.                              |
| **README.md**            | Someone deciding whether to use this            | Working example within the first screen.            |
| **docs/architecture.md** | Someone modifying the library                   | Explains the mechanism, not the API.                |
| **docs/adr/**            | Future maintainers asking "why is it like this" | One decision per record, immutable once accepted.   |
| **CHANGELOG.md**         | Upgraders                                       | Keep a Changelog format, every user-visible change. |
| **examples/**            | Someone integrating                             | Must run; CI type-checks them.                      |

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
 * Sends data to the device associated with a configuration.
 *
 * The write is performed by whichever tab currently owns the port; the caller does not need
 * to be that tab. Writes from a single tab preserve their order; writes from different tabs
 * are interleaved in the order the owning tab receives them.
 *
 * @param name - The configuration name passed to {@link setup}.
 * @param data - Text (encoded with the configured encoding, UTF-8 by default) or raw bytes.
 * @returns A promise that settles once the bytes have been handed to the device, not once
 *   the device has processed them.
 * @throws A {@link SerialBrokerError} with code `UNKNOWN_CONFIGURATION` if `name` was never
 *   set up, `NOT_CONNECTED` if no connection could be established before the write deadline,
 *   or `WRITE_FAILED` if the device rejected the write.
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
mechanism; the user-facing request used the word "master", the implementation uses "owner"
consistently, and the README notes the equivalence once.)

## ADRs

Format: MADR-derived, see [`0000-template.md`](../adr/0000-template.md).

- One decision per record. Numbered sequentially, never renumbered.
- **Immutable once accepted.** A decision that changes gets a new ADR that supersedes the old
  one; the old one is marked `Superseded by ADR-NNNN` and otherwise left untouched.
- Every ADR states what was **rejected** and why. An ADR without alternatives is a note, not
  a decision record.
- Code that exists because of an ADR references it: `// See ADR-0005.`
