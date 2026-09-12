# ADR-0009: Identify devices by USB IDs, persist configuration, rely on browser permission

- **Status:** Accepted
- **Date:** 2026-09-12

## Context

The requirement is that a released port is *remembered* and reused on the next visit, without
prompting the user again.

Two separate things must persist, and they persist in different places:

1. **The permission** to use a particular physical port. This is owned by the browser. An
   application cannot grant, store or forge it. `Serial.requestPort()` prompts the user and,
   once granted, `Serial.getPorts()` returns that port on subsequent visits without a prompt.
   The grant is per-origin and revocable by the user at any time.
2. **The configuration** - which device type to look for and with which serial settings. This
   is ours to store.

Critically, `SerialPort` objects are not serialisable and have no stable identifier exposed to
script. The only identifying information available is `SerialPort.getInfo()`, which for USB
devices yields `usbVendorId` and `usbProductId` - a *device type*, not a device instance.

## Decision

- A configuration is `{ name, device, serial, ... }` and is persisted in `localStorage` under
  `serial-broker/v<PROTOCOL_VERSION>/configurations`, validated on read and discarded
  per-entry if malformed.
- On `setup()`, the library calls `getPorts()` and selects the first port whose `getInfo()`
  matches the configured vendor and product IDs. If one is found, it opens it - no prompt, no
  user gesture, no application code.
- If none is found, the status becomes `awaiting-permission`. The application must call
  `requestAccess(name)` **from within a user gesture**; the library passes the configured IDs
  as `filters` to `requestPort()` so the browser picker is pre-filtered.
- `release(name)` stops using a configuration and removes it from storage; it does **not**
  revoke the browser permission (`SerialPort.forget()` is deliberately not called, so the next
  `setup()` is still prompt-free). A separate, explicitly named option
  `release(name, { forgetDevice: true })` calls `forget()` where the browser supports it.

## Alternatives considered

- **Persist a serialised port handle.** Not possible; `SerialPort` is neither serialisable nor
  identifiable across sessions.
- **Prompt automatically during `setup()`.** Cannot work: `requestPort()` requires transient
  user activation, and `setup()` is typically called during page initialisation. Attempting
  it produces a `SecurityError` that would look like a library bug. The two-step
  `setup()` -> `awaiting-permission` -> `requestAccess()` flow makes the platform constraint
  explicit instead of hiding a failure.
- **Match on a port index or on `getPorts()` order.** Order is not specified as stable.
- **Match on serial number.** `getInfo()` exposes no serial number in the current
  specification. When two identical devices are attached, the library matches the first
  granted port of that type and reports the ambiguity at `warn` level; distinguishing them is
  not possible in the platform today and is called out as a known limitation in the README.

## Consequences

### Positive
- Reopening after a reload, a crash or a device power cycle is fully automatic.
- No secret, handle or permission is stored by the library - the browser stays the authority,
  and the stored configuration contains nothing sensitive.

### Negative
- Two identical devices on one machine cannot be addressed separately. Documented.
- A user revoking the permission in site settings turns an automatic reconnect into
  `awaiting-permission`; this is reported via `onStatusChange` with a remediation string.

## Verification

Scenario matrix rows 1, 2, 8, 10.
