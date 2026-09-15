# ADR-0036: Take the device identity from the port the user chooses

- **Status:** Accepted
- **Date:** 2026-09-14

## Context

A configuration has to find its port again on every visit. Two things persist for that, in
different places:

1. **The permission** to use a particular physical port. It is owned by the browser: an application
   cannot grant, store or forge it. `Serial.requestPort()` prompts the user and, once granted,
   `Serial.getPorts()` returns that port on later visits without a prompt. The grant is per origin
   and revocable by the user at any time.
2. **What identifies the device**, which is ours to decide. `SerialPort` objects are not
   serialisable and expose no stable identifier. The only identifying information is
   `SerialPort.getInfo()`, which for a USB device yields `usbVendorId` and `usbProductId` - a device
   _type_, not an instance - and for anything else reports neither: a built-in RS-232 interface on
   an industrial PC, a virtual COM port, a Bluetooth serial port.

Vendor and product IDs are also what a developer who has just plugged a device in does not have,
and what an operator on a shop floor should never have to type. The browser shows the ports in its
own picker, but only after a choice, which needs a user gesture. Tim asked for the IDs to be always
optional, with a configuration set up without them taking its identity from the port the user
chooses.

## Decision

**The device filter has four shapes.** `device` in `SerialBrokerOptions`:

- `{ vendorId, productId }` - a USB device of that type;
- `{ nonUsb: true }` - only ports that report no USB identity (a port reporting just one of the two
  IDs counts as having none);
- `{ any: true }` - whatever the user granted, whatever it reports;
- omitted, or `{ auto: true }` - **auto mode**: the port the user chooses decides.

Passing two shapes at once, or an empty object, is `INVALID_ARGUMENT`. Internally the filter is a
discriminated union, so no code can read a vendor ID from a configuration that has none.

**Finding the port.** On `setup()` the tab holding the port calls `getPorts()` and opens the first
granted port its filter matches - no prompt, no gesture. When none matches, the status is
`awaiting-permission`, and the application calls `requestAccess(name)` **from a user gesture**; the
picker is filtered by the USB IDs where the filter has them, and unfiltered otherwise, because an
empty filter list would hide exactly the ports `nonUsb`, `any` and auto mode exist for.

**Auto mode resolves.** Until the user has chosen, an auto-mode configuration matches no granted
port, even when exactly one is granted. `requestAccess()` resolves it from the chosen port's
`getInfo()`: to `{ vendorId, productId }` when both IDs are reported, to `{ nonUsb: true }`
otherwise. From then on it matches, filters its picker and describes itself as that filter, and it
stays in auto mode with the resolution beside it: `{ auto: true, resolved: { … } }` wherever the
options are written out. An application may pass `resolved` itself.

**`requestAccess()` may be called before the tab holds the port** - in the same gesture that set the
configuration up, while the election is one lock round trip away. The choice is used once the tab
holds the port; if another tab turns out to hold it, the holder's device is adopted. A tab that
knows another tab holds the port, or is `queued`, is refused with `PERMISSION_REQUIRED`.

**The resolution is remembered, reported and shared.**

- _Remembered:_ the stored entry ([ADR-0033](./0033-one-storage-key-per-configuration.md)) keeps
  `{ auto: true, resolved }`. `setup()` of an unresolved auto-mode configuration with
  `remember: true` starts from a remembered auto-mode resolution of the same name, logged as
  `session.device-resolved` with `source: 'remembered'`, so a later visit reconnects without a
  prompt; so does `restore()`. What the call says wins, an explicit remembered device is never
  turned into a resolution, and `remember: false` takes nothing. Saving an unresolved auto-mode
  configuration keeps a resolution the stored entry already holds.
- _Reported:_ `getStatus()` has `deviceKind`: `'usb'`, `'non-usb'`, `'any'`, or `'auto'` while
  unresolved; `vendorId` and `productId` are set only for `'usb'`.
- _Shared:_ the `status` message carries the holder's device in effect. A tab in auto mode adopts a
  `usb` or `non-usb` device it hears from the tab holding the port: **the tab holding the port
  decides**, as for the tab limit ([ADR-0025](./0025-limit-the-tabs-using-a-configuration.md)). A
  holder that waits (`auto`) or accepts any port (`any`) hands on nothing, and an explicitly set up
  tab adopts nothing. A status is believed only while its term's Web Lock is held
  ([ADR-0030](./0030-hold-a-web-lock-for-every-term-of-holding-the-port.md)).

**Conflict rules within a tab** (`isDeviceCompatible`): auto never conflicts with auto; an unresolved
auto filter conflicts with nothing; a resolved one counts as its resolution; two explicit filters
conflict unless equal in kind and IDs, `nonUsb` and `any` being distinct kinds. Between tabs, devices
are not compared: the documentation says to pass the same options for a name in every tab.

**Releasing.** `release(name)` stops using a configuration and forgets its remembered entry under
the rule of ADR-0033; it does not revoke the browser permission, so the next `setup()` is still
prompt-free. `release(name, { forgetDevice: true })` also calls `SerialPort.forget()` where the
browser supports it. To choose a different device in auto mode, release the configuration.

## Alternatives considered

- **Persist a serialised port handle, or match on a port index or `getPorts()` order.** A port is
  neither serialisable nor identifiable across sessions, and the order is not specified as stable;
  a port appearing would silently repoint a configuration at another device.
- **Prompt automatically during `setup()`.** `requestPort()` requires transient user activation, and
  `setup()` typically runs during page initialisation; the resulting `SecurityError` would look like
  a library bug. `awaiting-permission` makes the constraint explicit.
- **Match on serial number.** `getInfo()` exposes none.
- **Optional IDs on the USB filter** (`{ vendorId?, productId? }`), or an `acceptAnyDevice` flag
  beside it. A typo would silently turn a specific filter into a wildcard; the discriminant makes
  the mistake unrepresentable.
- **Connect to the single granted port in auto mode without asking.** It saves one click and is a
  guess in every other case: the port may have been granted for another configuration or
  application of the origin.
- **Turn a resolved auto-mode configuration into the explicit one it resolved to.** Tabs of one name
  would diverge once the holder is re-chosen elsewhere; keeping the mode makes every auto-mode tab
  follow the holder.
- **Share the choice through a message from the choosing tab to the holder.** The holder would act on
  a device a message named, which a script of the origin could forge. The holder decides and tells.
- **Derive the configuration in the debugging surface.** What the page did before this decision
  ([ADR-0019](./0019-ship-the-debugging-surface.md)); every application would have to write it again,
  and the result was not shared between tabs.
- **Let only `restore()` read a remembered resolution.** The path the Quickstart teaches, `setup()`,
  then asked the user on every visit and saved over the choice.

## Consequences

### Positive

- `setup(name, { serial })` is a complete configuration; the first connection needs no IDs.
- A device chosen once, in any tab, is the device of every auto-mode tab of the configuration, now
  and on the next visit, and `setup()` plus `requestAccess()` can be one click.
- Ports without a USB identity - industrial PCs, virtual and Bluetooth ports - are supported.
- Reopening after a reload, a crash or a device power cycle is automatic, and no secret, handle or
  permission is stored by the library.

### Negative

- Two identical devices on one machine cannot be addressed separately, and an `any` filter cannot
  tell two granted ports apart: the first is used and a warning logged.
- An auto-mode configuration no user has chosen a port for waits forever, however many ports are
  granted; `deviceKind: 'auto'` says so.
- A tab that chose before learning another tab holds the configuration has its choice overridden by
  the holder's device; the permission stays with the browser.
- A user revoking the permission turns an automatic reconnect into `awaiting-permission`.

### Risks and mitigations

- **A device adopted from a forged status.** A script of the origin can post a status in the holder's
  name for the holder's live term, on either transport, and have its device believed - as it can
  already state any status for that term. It gains nothing it did not have: the tab opens only
  devices the user granted to this origin, and a script of the origin can open every one of them
  itself (SECURITY.md).
- **Two configurations using `any` on one machine** fight over the same port; the documentation says
  to use USB filters wherever the devices have IDs.

## Verification

`test/unit/validation.test.ts` (the four shapes, mixtures, `resolved`, conflict rules),
`test/unit/port-matcher.test.ts` (matching of every kind, resolution, the unfiltered picker, the
single granted port not taken); `test/integration/non-usb-devices.test.ts` and
`permission-and-persistence.test.ts`; `test/integration/multi-tab/auto-device.test.ts`, in both
transport modes (resolution, adoption from the holder, remembered and restored resolutions, `setup()`
on a later visit, conflict rules, two tabs choosing differently); `hostile-bus.test.ts` (a status
naming a device for an invented term is not adopted); `test/unit/debug-surface.test.ts`.

## History

- 2026-09-12: USB vendor and product IDs, browser permission, `awaiting-permission` (ADR-0009).
- 2026-09-12: `{ any: true }` for ports without USB identity (ADR-0016).
- 2026-09-14: Accepted - `nonUsb`, auto mode, resolution shared through `status`.
- 2026-09-15: `setup()` takes the remembered resolution; option renamed `remember`; the identity
  secret no longer protects the holder's name (ADR-0006). ADR-0009 (identity and permission) and
  ADR-0016 folded in.
