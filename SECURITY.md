# Security

## Reporting

Report vulnerabilities privately to the maintainers rather than through a public issue. Include
what an attacker can do, not only what is wrong.

## What this library assumes

**Everything within one origin is trusted equally.** Tabs of the same origin coordinate through
a `SharedWorker` and Web Locks, and neither mechanism can distinguish one same-origin context
from another. A script running in any tab of your origin can therefore read every byte the
device sends and write anything to it. That is inherent to the design, and it is the same trust
boundary the Web Serial API itself uses.

It follows that this library must not be used to isolate untrusted same-origin content — a
third-party script or an untrusted iframe without `sandbox` gets full access to the device.

**Permission belongs to the browser.** The library never stores, forges or transmits a device
permission; it only asks the browser which ports the user has already granted. Revoking access
in site settings takes effect immediately.

**What is persisted.** `localStorage` holds only configurations: the options passed to `setup()` —
a name, the device filter (USB vendor and product IDs, or `any`), line settings, reconnect and
timeout settings, text encoding and the tab limit. No payload data, no credentials, nothing
derived from device traffic.

**What is logged.** Nothing, unless an application supplies a logger. When one is supplied,
payload bytes never appear at `info` level or above — serial traffic routinely carries card
numbers and PINs — and appear at `debug` only when `logPayloads` is explicitly enabled.

**Messages are validated, not authenticated.** Every message crossing a context boundary is
validated before a field is read, and a malformed one is dropped rather than partially applied.
This defends against bugs and against unrelated scripts using the same channel name. It is not
a defence against a hostile same-origin script, which by the first assumption above is already
inside the boundary.
