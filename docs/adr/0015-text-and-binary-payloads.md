# ADR-0015: Deliver bytes, offer text as a configured convenience

- **Status:** Accepted
- **Date:** 2026-09-12

## Context

A serial port carries bytes. Many devices are used as if they carried text, and requiring
every application to construct a `TextEncoder` for a simple command string would be poor
ergonomics for the most common case. But decoding _received_ bytes as text is a trap: a
multi-byte UTF-8 character can be split across two `read()` chunks, and naive per-chunk
decoding produces replacement characters at chunk boundaries.

## Decision

**Sending.** `send(name, data)` accepts `string` or `BufferSource` (`ArrayBuffer` or any
`ArrayBufferView`). A string is encoded with the configured encoding, UTF-8 by default.
Nothing is appended - no terminator, no newline, ever. What the caller passes is what the
device receives.

**Receiving.** `onReceive` always delivers `data: Uint8Array` - a copy, never a view onto an
internal buffer. When `encoding.decodeText` is enabled, the payload _additionally_ carries
`text: string`, decoded with a **stateful streaming decoder** (`TextDecoder` with
`stream: true`) held by the owner, so a character split across chunks is decoded
correctly rather than mangled. The decoder is reset whenever the connection is reopened,
because a partial character cannot span a disconnect.

`text` is `undefined` when decoding is disabled, which the payload type makes explicit at
compile time.

## Alternatives considered

- **Bytes only.** Purest, and it was the initial position. Rejected because every consumer
  would write the same stateful streaming decoder, and most would write it wrongly - the
  cross-chunk case is subtle and only fails on non-ASCII input, so it survives testing and
  breaks in production.
- **Text only, or a mode switch.** Makes binary protocols second-class and would mean two
  delivery contracts to test against every failover scenario.
- **Per-chunk `TextDecoder` without streaming state.** The obvious implementation, and the
  bug this decision exists to prevent.
- **Accepting a number array in `send()`.** Ambiguous with a string of digits in loosely typed
  call sites, and adds a validation burden for no benefit over `Uint8Array.from(...)`.

## Consequences

### Positive

- The common text case is a one-liner, and the correctness trap is handled once, centrally.
- Binary users pay nothing: with decoding disabled, no decoder is constructed.

### Negative

- The owner holds decoder state, which must be reset on reconnect and must not survive an
  ownership transfer. Explicitly covered by a test that splits a multi-byte character across
  a disconnect and asserts the partial sequence is dropped rather than mis-decoded.

## Verification

Unit tests for the streaming decoder across chunk boundaries and across reconnects;
scenario matrix row 15 for chunked writes.
