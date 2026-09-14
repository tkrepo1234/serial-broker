# ADR-0036: Take the device identity from the port the user chooses

- **Status:** Accepted
- **Date:** 2026-09-14
- **Amends:** ADR-0009 (device identity), ADR-0016 (the device filter), ADR-0034 (the debugging
  surface's _Choose a device…_), ADR-0033 (what the stored entry holds)

## Context

A configuration has always had to name its device before anything could happen: USB vendor and
product IDs (ADR-0009), or `{ any: true }` for a port that reports none (ADR-0016). Both are
things a developer who has just plugged a device in does not have, and things an operator on a
shop floor should never have to type. The browser knows them - it shows the ports in its own
picker, and `SerialPort.getInfo()` reports the IDs once a port is chosen - but only after the
choice, which needs a user gesture.

ADR-0034 worked around this in the debugging surface alone: the page opened the picker itself,
read the chosen port, and derived a `setup()` call from it. That put the derivation in a page
rather than in the library, so every application that wants the same first-run experience would
have to write it again; and the configuration it produced was an ordinary explicit one, so a
port chosen in one tab said nothing to the other tabs of the configuration.

Tim asked for the rule to be the library's: vendor and product ID must always be optional, and a
configuration set up without them takes its identity from the port the user chooses.

## Decision

**A configuration is set up explicitly or in auto mode.** `device` becomes optional in
`SerialBrokerOptions`. Omitted, or `{ auto: true }`, is auto mode; `{ vendorId, productId }` and
`{ any: true }` stay the explicit modes, joined by a third, `{ nonUsb: true }`, which matches only
ports that report no USB identity. Passing two shapes at once is `INVALID_ARGUMENT`, as before.
An empty object is not auto mode: it names the USB shape without its IDs, and is rejected as it
always was.

**In auto mode, the port the user chooses decides the device.** `setup()` reports
`awaiting-permission` until `requestAccess()` opens the picker with no filter. The chosen port's
`getInfo()` resolves the configuration: to `{ vendorId, productId }` when it reports both USB
IDs, and to `{ nonUsb: true }` otherwise - a port with exactly one of the two IDs counts as having
none, as ADR-0034 decided, because no filter could find it again by half an identity. From then
on the configuration matches ports, filters its picker and describes itself exactly as the
explicit filter it resolved to would; it remains in auto mode, with the resolution beside the
mode: `{ kind: 'auto', resolved }` internally, `{ auto: true, resolved: { … } }` wherever the
options are written out.

**Until the user has chosen, an auto-mode configuration matches no granted port, even when
exactly one is granted.** Considered and rejected: connecting to the single granted port without
asking. It would save one click in the common case, and it would be a guess in every other: the
one port may have been granted for another configuration of the origin, or for another
application on the same origin, and auto mode promises the device the user chose, not the device
that happened to be there. The click it would save is also no longer needed where it mattered
most - see the next decision.

**`requestAccess()` may be called before the tab holds the port.** It was refused with
`PERMISSION_REQUIRED` in any tab that did not hold the port, because only the holder can act on
the choice. That was too strict by one case: a tab that has just called `setup()` and does not
yet know whether anyone holds the port, because the ownership election is one lock round trip
away. Such a tab may open the picker at once, in the same gesture that set the configuration up.
The choice is kept and used the moment the tab holds the port; if it turns out that another tab
holds it, the holder's device is adopted when its status arrives (below), and the choice, being a
browser permission, is not lost either way. A tab that knows another tab holds the port - it has
heard its claim or its status, or it is `queued` - is refused as before.

**The resolution is remembered, reported and shared.**

- _Remembered_: the stored entry (ADR-0033) is still exactly what `setup()` accepts, and the
  `device` written into it is `{ auto: true, resolved: { … } }`. `restore()` and a later visit
  therefore reconnect to the chosen device without a prompt, as an explicit configuration would,
  while the restored configuration is still in auto mode. A stored auto entry with no resolution
  stays auto, and waits for the user again. An application may pass `resolved` itself to seed a
  resolution.
- _Reported_: `getStatus()` gains `deviceKind`: `'usb'`, `'non-usb'`, `'any'`, or `'auto'` for a
  configuration in auto mode that has not resolved. `vendorId` and `productId` are set only for
  `'usb'`, so a non-USB resolution shows as `deviceKind: 'non-usb'` with both undefined. The
  diagnostics report and the debugging surface show the device in effect the same way.
- _Shared_: the `status` message carries `device` - the holder's device in effect, by kind, with
  the two IDs for a USB one - and the protocol version becomes 9. A tab set up in auto mode adopts
  a `usb` or `non-usb` device it hears from the tab holding the port, replacing whatever it had
  resolved to itself: **the tab holding the port decides**, as it does for the tab limit
  (ADR-0025). It then matches, filters its picker and remembers that device as if it had chosen
  it. A holder that is itself waiting (`auto`), or that accepts any port (`any`), hands on nothing:
  `any` is not a device, and a tab that adopted it could no longer resolve. A tab set up explicitly
  adopts nothing.

  A status is believed only while the term's Web Lock is held, and that lock is named after the
  term, the sender and the tab limit (ADR-0030). A script of the origin can therefore not make a
  tab adopt a device by posting a status in its own name, or for a term nobody holds. On the
  `BroadcastChannel` it can post one in the holder's name, for the holder's live term - exactly as
  it can already state any _status_ for that term - and that is believed, for the device as for
  the status. What it gains is nothing it did not have: the tab would open a device only among
  those the user has granted to this origin, and a script of the origin can open every one of them
  itself (SECURITY.md). On the `SharedWorker` a `hello` binds the identity to a secret (ADR-0028),
  so the holder's name cannot be used at all.

**Conflict rules.** Within one tab, `setup()` for a name already set up compares the two devices
(`isDeviceCompatible`):

- auto mode never conflicts with auto mode, whatever either has resolved to - both say "the device
  the tab holding the port chose", and the session already running keeps its resolution;
- an auto-mode filter that has not resolved conflicts with nothing: it has committed to nothing,
  and the second `setup()` is a no-op like any compatible one, so an explicit device passed then
  is not taken up;
- an auto-mode filter that has resolved counts as the device it resolved to: an explicit filter
  equal to it is compatible, anything else is `CONFIGURATION_CONFLICT`;
- two explicit filters conflict as before, `nonUsb` being its own kind: two `nonUsb` filters are
  compatible, `nonUsb` and `any` are not.

Between tabs, serial-broker compares devices no more than it did. Tab A resolved to device X and
tab B set up explicitly with device Y report no conflict: B keeps Y, opens Y when it holds the
port, and A - being in auto mode - adopts Y then. This is the situation two explicit tabs with
different devices have always been in, and the documentation says, as it did, to pass the same
options for a name in every tab.

**The debugging surface's _Choose a device…_ is this mode.** The page no longer opens the picker
itself or derives anything from the chosen port. The action opens the setup dialog with the device
fields hidden - a name and the line settings are all it asks for - and _Connect_ sets the
configuration up in auto mode and calls `requestAccess()` in that click, which is what the fourth
decision exists for. A dismissed picker releases the configuration again, so nothing waits for a
device nobody chose and nothing is remembered. _New configuration_ keeps the device list, with
_Automatic (from the chosen device)_ as its default entry beside the presets, _Other USB device_,
_Port without USB identity_ and _Any port_; editing a resolved configuration keeps its resolution,
so changing a baud rate does not ask for the device again.

## Alternatives considered

- **Turn a resolved auto-mode configuration into the explicit one it resolved to.** Smaller: no
  `resolved`, no auto-mode conflict rule. But a restored configuration would then be explicit, and
  a tab that restored X would keep X when the holder is later re-chosen to Y in another tab - the
  tabs of one name diverging, with the stored entry agreeing with the holder and not with them.
  Keeping the mode makes every auto-mode tab follow the holder, which is the property that makes
  "choose it once, in any tab" true.
- **Resolve the device from the `any` filter's first granted port.** That is what `any` does, and
  it is the wrong answer for the same reason the single-granted-port shortcut is: the first
  granted port is not a choice.
- **Share the choice through a message of its own, from the tab that chose to the holder.** The
  holder would then act on a device a message named, which is what ADR-0030 removed for terms and
  limits; and a script of the origin could redirect the holder to another granted device. The
  holder decides, and tells; nobody tells the holder.
- **Keep the page's own derivation (ADR-0034) and add auto mode beside it.** Two paths to the same
  outcome, one of them in a page. The page's version also produced an explicit configuration,
  losing the sharing.
- **Let `requestAccess()` open the picker in every tab, holder or not.** A tab that knows another
  tab holds the port would take a choice nobody can act on until the holder goes away, and would
  contradict the holder meanwhile. The one case that needs the picker before ownership is settled
  is the one that is allowed.
- **`{ vendorId, productId, auto: true }` as the resolved shape.** It reads as two shapes at once,
  which is exactly what validation rejects; `resolved` keeps the mode and the device apart.

## Consequences

### Positive

- `setup(name, { serial })` is a complete configuration. The first connection needs no vendor ID,
  product ID or device type, in the library and not only in its debugging surface.
- A device chosen once, in any tab, is the device of every tab of the configuration, now and on
  the next visit.
- A port with no USB identity is handled without anyone knowing that `any` or `nonUsb` exist.
- `setup()` and `requestAccess()` can be one click, which is how a "Connect" button wants to work.

### Negative

- The protocol version is 9 and the stored `device` may carry `resolved`; tabs and stored entries
  of earlier builds do not federate or restore (before 1.0, as CONTRIBUTING.md says).
- A configuration in auto mode that no user has chosen a port for waits forever, however many
  ports are granted. That is the decision, and `deviceKind: 'auto'` says so.
- A tab that chose a port before learning that another tab holds the configuration has its choice
  overridden by the holder's device. The permission it obtained stays with the browser.
- `getStatus()` has one more field, and `SerialBrokerStatusSnapshot` one more documented key.

### Risks and mitigations

- **A resolution adopted from a forged status on the `BroadcastChannel`.** Discussed above: no more
  than a script of the origin can do directly, and impossible on the `SharedWorker` transport.
- **Two auto-mode tabs choosing different ports before either holds the port.** The holder's
  choice wins and the other tab follows; both choices are granted permissions, and the losing one
  is simply not used. Tested.
- **An application that relied on `device` being required.** Its `setup()` calls carry a device
  and are unchanged; a call that forgot it used to fail with `INVALID_ARGUMENT` and now waits for
  the user, which `deviceKind: 'auto'` and the `awaiting-permission` status make visible.

## Verification

`test/unit/validation.test.ts` covers the four shapes, the mixtures, `resolved`, the round trip
through `toSetupOptions()` and the conflict rules; `test/unit/port-matcher.test.ts` the matching
of every kind, the resolution of USB, bare and half-identified ports, the unfiltered picker and the
single granted port that is not taken. `test/unit/decode-matrix.test.ts`, `bus-limits.test.ts` and
`decoder-fuzz.test.ts` hold the `status` message to its new field.
`test/integration/multi-tab/auto-device.test.ts` covers, in both transport modes where tabs are
involved: auto mode waiting for the user with one port granted; `requestAccess()` resolving a USB
and a non-USB port, and being allowed in the same gesture as `setup()`; the resolution stored and
restored, and an unresolved stored entry restored as waiting; a second tab adopting the device
the first resolved, filtering its picker by it and opening it when it takes over; the conflict
rules within a tab; an explicit tab and an auto-mode tab side by side; and two tabs that chose
differently converging on the holder's device. `test/integration/multi-tab/hostile-bus.test.ts`
posts a status naming a device in a script's own name and in the holder's name for an invented
term, and shows that neither is adopted. `test/unit/debug-surface.test.ts` pins the page's part:
auto mode by default, a resolution kept through the edit dialog, and the summaries.
