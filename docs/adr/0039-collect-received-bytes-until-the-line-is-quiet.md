# ADR-0039: Collect received bytes until the line is quiet

- **Status:** Accepted; supersedes the "no buffering, no timing heuristics" part of
  [ADR-0002](./0002-scope-transport-only.md)
- **Date:** 2026-09-15
- **Deciders:** maintainers

## Context

ADR-0002 delivered every chunk exactly as `reader.read()` returned it. A read returns whatever the
driver holds at that moment, and on a real device that is often one byte. Writing `1234\r\n` to the
Arduino echo port produced six `onReceive` events - `1`, `2`, `3`, `4`, `\r`, `\n` - where an
application, and the person watching the debugging surface, expects one (Tim, 2026-09-15). Every
consumer had to collect bytes itself before it could look at an answer, and every tab received six
messages over the bus instead of one.

This is not framing. Nothing about the device's protocol is assumed: no delimiter, no length, no
checksum. The only knowledge used is time - a device that has stopped sending for a moment has
most likely finished what it was saying - which is how serial terminals and many field protocols
(Modbus RTU's silent interval among them) tell one message from the next.

## Decision

The tab holding the port collects the chunks it reads and delivers them as one `onReceive` event,
in every tab, when:

- the line has been quiet for **`receive.idleMs`** (default **50 ms**), or
- **`receive.maxWaitMs`** (default **500 ms**) have passed since the first byte of the delivery,
  however busy the line stays, or
- 64 KiB have been collected, or
- the connection ends - lost, released or handed over - so that nothing read is held back when
  the status says the connection is gone.

`receive.idleMs: 0` delivers every chunk as it is read, which is the behaviour ADR-0002 described.

The defaults are chosen for the devices this library is for. At 9600 baud a character takes about
1 ms and a USB-serial adapter adds up to 16 ms of latency; the Arduino used for the hardware tests
echoes at about 80 bytes a second, 12.5 ms apart. 50 ms joins all of these into one answer and is
below what a person notices. 500 ms keeps a device that streams without pause from being delivered
in pieces far apart.

The settings of the tab holding the port apply: that tab reads the device, and every other tab
receives its deliveries. They are therefore not part of the comparison that decides a
`CONFIGURATION_CONFLICT` - two tabs disagreeing about `idleMs` is not two ways of opening a port.

Text decoding happens on the delivered bytes, with the same streaming decoder, so a multi-byte
character split across reads is still decoded intact (ADR-0015).

## Alternatives considered

- **Keep ADR-0002 and let applications collect.** Every application would write the same timer,
  and the debugging surface would keep showing one line per byte. The complaint came from using the
  library, not from a theory about it.
- **Delimiter-based framing (`\r\n`).** Rejected for the reason ADR-0002 gives: it is wrong for
  binary protocols, and it invites checksums and escaping next. Time alone is protocol-neutral.
- **Collect in each receiving tab.** The bus would still carry one message per byte, and tabs could
  disagree about where one delivery ends. Collecting once, where the bytes are read, gives every
  tab the same deliveries.
- **A fixed interval derived from the baud rate.** 3.5 characters is right for a UART and wrong for a
  USB device whose latency has nothing to do with its nominal baud rate - as the Arduino shows.

## Consequences

### Positive

- An answer arrives as one event in every tab; the bus carries one message instead of one per byte.
- Applications that already collected bytes keep working: they receive larger pieces.

### Negative

- Delivery is delayed by up to `idleMs` after the device stops sending - 50 ms by default. An
  application that needs every byte at once sets `idleMs: 0`.
- Chunk boundaries now depend on timing on two levels, the driver's and this one. They still carry
  no meaning, as before.
- Bytes collected but not yet delivered when the tab holding the port crashes are lost, like bytes
  the device sends while no tab holds the port.

## Verification

- `test/unit/receive-buffer.test.ts` - quiet time, longest wait, size limit, flush, copies.
- `test/integration/receiving.test.ts` - an answer arriving byte by byte is one event in every tab;
  `idleMs: 0` delivers each chunk; a busy line is delivered at `maxWaitMs`; what was collected is
  delivered before a lost connection is reported.
