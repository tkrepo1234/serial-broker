# ADR-0034: Start the debugging surface from a chosen port, under its own policy

- **Status:** Accepted, amended by [ADR-0036](./0036-take-the-device-identity-from-the-chosen-port.md)
- **Date:** 2026-09-14
- **Amends:** ADR-0019, which ships the debugging surface

> **Amendment (ADR-0036).** The derivation moved into the library as auto mode. _Choose a
> device…_ no longer opens the picker itself or reads the chosen port: it asks for a name and the
> line settings, and _Connect_ sets the configuration up without a device and calls
> `requestAccess()` in that click. The library takes the device from the port chosen, remembers it,
> and shares it with the other tabs. `debug/src/chosen-port.ts` keeps only the name suggestion and
> the form values for that flow. The policy decision below is unchanged.

## Context

[ADR-0019](./0019-ship-the-debugging-surface.md) ships the page for operators of a deployment. It
is also the first thing a developer trying serial-broker opens, and for them it started at a wall:
_New configuration_ asks for a vendor ID and a product ID before anything can happen. Those are
exactly what someone who has just plugged a device in does not have. The browser knows them — it
shows them in its own port picker, and `SerialPort.getInfo()` reports them afterwards — but only
after a port has been chosen, and `requestPort()` needs a user gesture, so nothing can ask for it
on the page's behalf.

The page also ships as static files that operators serve. Its own markup decides part of what it
may do: it carried its styles inline, which is the one thing that forces every policy written for
it to allow inline styles. `frame-ancestors` cannot be set from the page at all — a `<meta>`
element ignores it — so that part stays a header the operator sends (ADR-0019 already says so, and
the page refuses to start in a frame of another origin).

## Decision

**A developer connects to a device by choosing it, not by naming it.** _Choose a device…_ is the
page's main action, next to _New configuration_ and again in the empty state. It calls
`navigator.serial.requestPort()` **with no filter**, inside the click, so every port the browser
offers is listed and the gesture is kept. From what the chosen port reports, the page derives a
complete setup and opens the usual dialog on it:

- the device: `{ vendorId, productId }` when the port reports **both** USB IDs, `{ any: true }`
  otherwise — a built-in RS-232 port, a virtual COM port, a Bluetooth port, or a port that reports
  half an identity, which is no identity a filter could use (ADR-0016);
- a name no configuration on this origin uses yet: `USB 0x1a86:7523`, `Serial port`,
  `Bluetooth port`, numbered where that name is taken;
- 9600 baud, offered with the other common rates, and every other line setting at the library's
  default, all of them still editable.

One _Connect_ then sets the configuration up. The permission was granted in the picker a moment
ago, so `getPorts()` finds the port and the connection needs no second prompt — this visit and
every later one. A dismissed picker is an answer, not a failure: `NotFoundError` shows a plain
notice and changes nothing. Where several granted ports match the derived filter, the dialog says
so, because the configuration opens the first of them and the platform cannot tell identical
devices apart.

The derivation is pure and unit-tested (`debug/src/chosen-port.ts`); the page validates none of it,
as everywhere else in this page, and lets the library have the verdict.

**The page carries a strict `Content-Security-Policy` of its own**, as a `<meta>` element, so it
holds wherever the page is served and whatever the server sends:

```text
default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self'; connect-src 'self';
img-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'
```

To make `style-src 'self'` possible, the stylesheet moved from the page into
`debug/public/debug.css`, shipped as `dist/debug/debug.css`, and no element carries a `style`
attribute. `frame-ancestors` stays the operator's header, and `debug/README.md` keeps the complete
policy to send.

## Alternatives considered

- **Ask for the IDs and offer a picker afterwards**, as the page did: _New configuration_, then
  _Choose device…_ once the configuration waits for permission. It works, and it asks for the two
  numbers first — the wall this removes. It stays available for a configuration whose device was
  never granted, which is what it is for.
- **Filter the picker by the presets.** The page knows four common USB-serial chips, so it could
  pass them as `filters`. It would hide every other adapter and every non-USB port, which is
  precisely the device someone needs the picker for. Rejected.
- **Connect without a dialog**, straight from the chosen port with the defaults. The baud rate has
  to match the device and 9600 is a guess, so the first thing that would happen is garbage on the
  traffic panel with no obvious place to change it. One confirmation, with the rate in it, is
  cheaper than that.
- **A dialog of its own for the chosen port.** A second form for the same options, drifting apart
  from the one beside it. The existing dialog already holds every option of `setup()`; it gains a
  mode, a note and a `Connect` button.
- **Name configurations after the preset** (`CH340 adapter`). Two adapters of the same chip then
  fight over one name, and the name of a device that is not a preset would have to be invented
  anyway. The IDs are what the page shows for the device everywhere else.
- **Keep the styles inline and allow `'unsafe-inline'` for them.** That allowance covers every
  inline style, including any an injection manages to place, and it is the weakest part of most
  real policies. Hashing the block instead (`'sha256-…'`) keeps the policy strict but breaks on
  every edit of the stylesheet, and inline `style` attributes would still need `'unsafe-hashes'`.
  A stylesheet file costs one request and needs neither.
- **Leave the policy to the operator entirely.** An operator who serves `dist/` wholesale sends no
  policy at all, and the page is the one that can send bytes to devices. The `<meta>` policy is the
  part the page can carry itself; the header still adds `frame-ancestors`.

## Consequences

### Positive

- A developer with a device and no documentation can reach an open port: choose, confirm, connected.
- The page connects to ports with no USB identity without anyone having to know that `any` exists.
- The derived configuration is an ordinary one: it is remembered, edited and shared like every other.
- The page runs with no inline script and no inline style, on `default-src 'none'`. An injected
  `<script>`, a `<base>` tag or a form posting elsewhere does not execute, redirect or send.

### Negative

- The page has one more file, `dist/debug/debug.css`, which has to be served with `index.html`.
- A copy of the page served through something that rewrites HTML, or that injects a script, breaks
  under its own policy instead of silently running the injection. That is the point, but it is a
  change for anyone who did the injecting on purpose.
- Where several granted ports match, the page can only say so. A port chosen in the picker cannot
  be pinned to the configuration: the platform exposes nothing to pin it by (ADR-0009).

### Risks and mitigations

- **A port granted for one configuration is opened by another with an `any` filter.** The dialog
  says how many granted ports match before anything is set up, and the device stays editable.
- **A browser without Web Serial.** The page already reports that it cannot start and hides
  everything that would set a configuration up, the new action and the `?` beside it included.
  The controls are named in one place, `SETUP_ACTION_IDS`, and the markup is checked against it.

## Verification

`test/unit/debug-surface.test.ts` pins the derivation: a USB port becomes a configuration whose
filter `matchesDevice()` accepts that same port, a port with no identity — or half an identity —
becomes `{ any: true }`, suggested names avoid the names in use, the note warns where several
granted ports match, and a dismissed picker is recognised as an answer. It also reads the page's
markup and holds every header control that sets a configuration up against `SETUP_ACTION_IDS`, so
a control that a page which cannot start would leave behind fails the suite.

The policy was checked in Chromium against a build served from `dist/`: the page loads styled, the
`SharedWorker` starts, a configuration can be created, and no `securitypolicyviolation` is raised
while the page is used. An inline `<script>` added to the loaded page does not execute, which is
the policy doing its work.
