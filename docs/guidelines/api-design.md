# API Design

The public surface is the product. It is small on purpose, and it is the hardest part of this
library to change, so it gets the most scrutiny.

Influences: Google's API Design Tips, the W3C TAG Design Principles, and MDN's documented
behaviour of the Web platform APIs this library wraps.

## Principles

1. **Expose intent, hide mechanism.** The application says _"I want a connection to this kind
   of device, called this"_. It never learns which tab owns the port, that a `SharedWorker`
   exists, that a Web Lock is held, or that a reconnect is in flight beyond a coarse status.
   Anything that would let an application depend on the coordination mechanism is a design
   defect. See [ADR-0011](../adr/0011-encapsulation-boundary.md). The one deliberate exception is
   the read-only diagnostics observer, behind an entry point of its own, for operators rather
   than application code ([ADR-0018](../adr/0018-diagnostics-observer.md)).

2. **Name-addressed, not handle-addressed.** Every operation takes the configuration `name`.
   No object handle is returned that could outlive its configuration, be shared across tabs
   incorrectly, or leak internals through its prototype. The name is the capability.

3. **Idempotent, declarative setup.** `setup()` declares a desired state. Calling it twice
   with equal options is a no-op for a working configuration, not an error and not a reconnect;
   for a `failed` one it is how the application says "try again", in any tab. Calling it with options that
   would open the port differently, or with a different `maxTabs`, rejects with
   `CONFIGURATION_CONFLICT`: nothing is reconfigured silently, because the port may be open in
   another tab with the old settings.

4. **Everything async that touches the world.** `setup`, `send`, `release`, `releaseAll`,
   `requestAccess`, `restore` and `dispose` return promises. Pure inspection (`getStatus`,
   `exists`, `names`) is synchronous
   and reads a locally cached snapshot — it never blocks and never lies about being current
   (the snapshot carries the timestamp of its last update).

5. **One obvious way.** No overload takes four shapes. `send()` accepts `string` or
   `BufferSource` because that distinction is inherent to serial traffic; it does not accept
   arrays of numbers, numbers, or objects with a `toString`.

6. **Options are structures, not positional arguments.** Every option object is extensible
   without a breaking change, groups related settings (`device`, `serial`, `connection`,
   `encoding`), and has a documented default for every field. New options are always optional.

7. **Events are the only push channel.** Four events, fixed: `onReceive`, `onSend`,
   `onError`, `onStatusChange`. Adding a fifth requires an ADR; the bar is that it cannot be
   derived from the existing four.

8. **`subscribe` returns an unsubscribe function** in addition to `unsubscribe(name, event,
cb)` existing. Both are supported because the first is ergonomic and the second is
   required for symmetry with code that stores callbacks.

## Compatibility rules

- Everything exported from `src/index.ts` is covered by SemVer.
- **Breaking:** removing or renaming an export, a status value, an error code, an event name
  or an option; narrowing an accepted input type; widening a returned type; changing when an
  event fires.
- **Non-breaking:** adding an optional option, a new error code, a new status value _only if_
  the status union is documented as extensible (it is — consumers must handle unknown
  statuses defensively), a new event payload field.
- The wire protocol between tabs is versioned independently of the package version; two
  library versions with different protocol versions coexist without corrupting each other by
  refusing to federate. See [ADR-0008](../adr/0008-wire-protocol-and-versioning.md).

## What this library will never do

Listed here so the boundary is defensible in review:

- Frame, parse, checksum or interpret payload bytes. That belongs to a protocol layer built
  _on top_ of this one ([ADR-0002](../adr/0002-scope-transport-only.md)).
- Provide request/response correlation, command queues with replies, or retry-on-payload.
- Expose the underlying `SerialPort` object. Handing it out would let one tab close a port
  that other tabs depend on, and would break every invariant this library maintains.
- Poll for devices, or drive a device-picker UI on the application's behalf.
