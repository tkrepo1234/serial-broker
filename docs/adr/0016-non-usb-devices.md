# ADR-0016: Support ports that are not USB devices

- **Status:** Accepted, amended by [ADR-0036](./0036-take-the-device-identity-from-the-chosen-port.md)
- **Date:** 2026-09-12
- **Amends:** ADR-0009 (device identity), which remains the rule for USB devices

> **Amendment (ADR-0036).** The filter has two more shapes: `{ nonUsb: true }`, which matches only
> ports that report no USB identity - a port reporting one of the two IDs counts as having none -
> and `{ auto: true }`, also what an omitted `device` means, which takes the device from the port
> the user chooses and resolves to a USB identity or to `nonUsb`. `any` and a USB filter still do
> not mix; `nonUsb` is its own kind, compatible with `nonUsb` and with nothing else.

## Context

[ADR-0009](./0009-device-identity-and-permission-persistence.md) identifies devices by their
USB vendor and product IDs, because `SerialPort.getInfo()` exposes nothing else. That is
correct, and it is also incomplete: `getInfo()` reports `usbVendorId` and `usbProductId` only
when the port _is part of a USB device_. For anything else it reports neither.

"Anything else" is not an edge case:

- A built-in RS-232 interface on an industrial PC or a rack-mounted controller. These are
  exactly the machines a shop-floor application runs on.
- A virtual COM port pair (`com0com` and equivalents), which is the only way to exercise this
  library end to end without physical hardware.
- A Bluetooth serial profile, where `getInfo()` may report a service class id instead.

With only a USB filter, the library cannot connect to any of them: `findGrantedPort` compares
against `undefined` and never matches. The device is granted, present and usable, and the
library reports `awaiting-permission` forever.

This was found while planning how to test without hardware, which is a good illustration of
why that plan was worth making.

## Decision

The device filter becomes a discriminated union:

```ts
type DeviceFilter =
  | { vendorId: number; productId: number } // a USB device, as before
  | { any: true }; // whatever the user granted
```

- `{ any: true }` matches every port the user has granted, whatever it reports.
- `requestPort()` is called with **no** `filters` for such a configuration. An empty filter
  array would hide precisely the ports this exists to find.
- Passing both shapes at once is rejected. Resolving it either way would be a guess about what
  the caller meant, and a guess about which device to open is not a guess worth making.
- Internally the filter is normalised to `{ kind: 'usb', ... } | { kind: 'any' }`, so no code
  can read a vendor ID from a configuration that does not have one. The compiler enforces it.
- `getStatus()` reports `vendorId` and `productId` as `undefined` for an `any` configuration.
- Two `any` configurations are compatible with each other; an `any` and a USB configuration
  are not, because one would open a port the other did not ask for.

## Alternatives considered

- **Optional IDs on the existing filter** (`{ vendorId?, productId? }`). Smaller diff, and
  wrong: "no IDs given" and "IDs that happen to be undefined" become indistinguishable, a
  typo in a property name silently turns a specific filter into a wildcard, and every
  consumer of the normalised configuration has to remember to check. The discriminant makes
  the mistake unrepresentable.
- **A separate `acceptAnyDevice: true` option next to `device`.** Two fields that constrain
  each other, with `device` meaningless when the flag is set. The union says the same thing
  once.
- **Matching on the port's index in `getPorts()`.** The specification does not promise a
  stable order, and a port appearing or disappearing would silently repoint a configuration at
  a different device. Rejected outright - this is the failure mode that damages equipment.
- **Leaving it out and documenting the limitation.** Considered seriously, because a wildcard
  filter is genuinely weaker: it cannot tell two ports apart. Rejected because the alternative
  is not "a weaker guarantee" but "no support at all" for a whole class of machines the
  library is meant for.

## Consequences

### Positive

- Industrial PCs with built-in serial interfaces are supported.
- The library can be tested end to end against a virtual COM port pair, with no hardware.
- The USB path is unchanged and remains the recommended one, because it is the only one that
  can distinguish devices.

### Negative

- An `any` filter cannot tell two granted ports apart. With more than one, the library uses
  the first and warns - the same honest-but-limited behaviour ADR-0009 already accepts for two
  identical USB devices. Documented in the README as a known limitation.
- Two configurations both using `any` on one machine will fight over the same port. The
  library cannot detect this; the documentation says to use USB filters whenever the devices
  have IDs.

## Verification

Unit tests for the filter's validation, including the rejection of a mixed filter; matcher
tests for a port that reports no IDs at all; an integration test that connects, sends and
receives through an `any` configuration against a device with no USB identity.
