# ADR-0002: Wrap the transport only; collect received bytes until the line is quiet

- **Status:** Accepted

## Context

Serial devices speak wildly different protocols: line-oriented ASCII terminated by `\r\n`,
STX/ETX-framed binary with a BCC, Modbus RTU with a 3.5-character silent interval, fixed
length records, length-prefixed frames. Any framing rule this library picked would be wrong
for most devices, and a framing rule that is _configurable enough_ to fit all of them is a
second product.

Reading from a serial port yields arbitrary chunks: one logical message can arrive in five
`read()` results, and five messages can arrive in one. On a real device a read often returns a
single byte: an Arduino echoing `1234\r\n` at 9600 baud delivers it in six reads, where an
application - and the person watching the debugging surface - expects one answer.

## Decision

This library wraps the transport and nothing else: no framing, no delimiters, no lengths, no
checksums, no request/response correlation and no interpretation of the bytes. Protocol handling
belongs in a separate layer built on top of this one, consuming `onReceive` and calling `send`.

The one thing it does to received bytes is **collect them until the line is quiet**, which uses
time and nothing about the device's protocol. The tab holding the port collects what it reads and
delivers it as one `onReceive` event, in every tab, when:

- the line has been quiet for **`receive.idleMs`** (default **50 ms**), or
- **`receive.maxWaitMs`** (default **500 ms**) have passed since the first byte of the delivery,
  however busy the line stays, or
- 64 KiB have been collected (`MAX_RECEIVE_DELIVERY_BYTES`), or
- the connection ends - lost, released or handed over - so that nothing read is held back once the
  status says the connection is gone.

`receive.idleMs: 0` delivers every chunk as it is read.

The defaults are chosen for the devices this library is for. At 9600 baud a character takes about
1 ms and a USB-serial adapter adds up to 16 ms of latency; the Arduino echoes at about 80 bytes a
second, 12.5 ms apart. 50 ms joins all of these into one answer and is below what a person notices;
500 ms keeps a device that streams without pause from being delivered in pieces far apart.

**A delivery says when bytes may be missing before it** (`afterGap`). A layer that assembles lines
or frames across deliveries has to drop the one in progress when the stream it sees is broken, and
cannot tell that from the bytes. Each tab decides it from what it saw itself, so nothing about it
travels on the wire and nothing reveals which tab holds the port: `true` on the tab's first
delivery, and on the first after its status left `open` or after its message bus replaced a worker
that died. The last is the one gap the status does not show - the port stays open while what was
broadcast into the dead worker is lost. Watching the status alone, as an application could before,
misses it.

The settings of the tab holding the port apply, because that tab reads the device. They are not
part of the comparison that decides a `CONFIGURATION_CONFLICT`: two tabs disagreeing about `idleMs`
is not two ways of opening a port. Text decoding happens on the delivered bytes, with a streaming
decoder, so a character split across reads is decoded intact ([ADR-0013](./0013-text-and-binary-payloads.md)).

## Alternatives considered

- **Configurable delimiter-based framing.** Attractive for the common line-oriented case, but it
  fails for binary protocols with escaping, it needs timeouts to handle partial frames, and once a
  delimiter option exists, the requests for checksums, escaping and length prefixes follow
  immediately. Rejected as scope creep that compromises the core guarantee.
- **A pluggable codec interface in this library.** Would mean shipping a plugin contract,
  versioning it, and running application code inside the owner tab's read loop where an exception
  can stall the port. The same composition is achievable outside the library with less coupling.
- **Optional "line mode".** The 80% case, but it splits the delivery semantics in two and doubles
  the test matrix for every failover scenario; a ten-line helper on top of `onReceive` does it.
- **Deliver every chunk exactly as read.** Every application would write the same timer, a terminal
  would show one line per byte, and every tab would receive one bus message per byte. An
  application that wants it sets `idleMs: 0`.
- **Collect in each receiving tab.** The bus would still carry one message per byte, and tabs could
  disagree about where one delivery ends. Collecting once, where the bytes are read, gives every
  tab the same deliveries.
- **A fixed interval derived from the baud rate.** 3.5 characters is right for a UART and wrong for
  a USB device whose latency has nothing to do with its nominal baud rate.

## Consequences

### Positive

- The delivery contract is simply stated: bytes in, bytes out, in order, with no meaning attached
  to where one delivery ends.
- No release of this library can break a device by changing framing behaviour.
- An answer arrives as one event in every tab, and the bus carries one message instead of one per
  byte.

### Negative

- Every consumer writes or imports its own framing. The documentation shows the common patterns.
- Delivery is delayed by up to `idleMs` after the device stops sending. An application that needs
  every byte at once sets `idleMs: 0`.
- Chunk boundaries depend on timing on two levels, the driver's and this one. They carry no meaning.
- Bytes collected but not yet delivered when the tab holding the port crashes are lost, like bytes
  the device sends while no tab holds the port.

## Verification

`test/unit/receive-buffer.test.ts` - quiet time, longest wait, size limit, flush, copies.
`test/integration/receiving.test.ts` - in every tab: an answer arriving byte by byte is one event,
`idleMs: 0` delivers each chunk as it is read, a line that never pauses is delivered at
`maxWaitMs`, and what was collected is delivered before a lost connection is reported.
`test/integration/multi-tab/receive-after-gap.test.ts` - `afterGap` on the first delivery, after an
unplug, a handover, a crash of the tab holding the port and a replaced worker, and on no other.
`test/browser/failover.spec.ts` - the first delivery after a real worker was terminated is marked in
every tab.
