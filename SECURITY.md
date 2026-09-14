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

## Threat model: the application side

What serial-broker stores, logs, reports and ships on behalf of an application, and who can read
it. How tabs talk to each other is a separate matter.

### Who could get at what

- **A script of another origin** reaches nothing: storage, Web Locks and the message bus are per
  origin, and a `SharedWorker` script must be of the page's origin.
- **Any script on the application's origin** — the application's own code, a third-party script it
  includes, an XSS payload, a same-origin page such as an uploaded HTML file — is inside the
  boundary. It can read and write everything below, observe all traffic and send to the device.
  serial-broker cannot defend against it; keeping untrusted script off the origin, with a
  content security policy, can.
- **A reader of logs, error reports or a support dump** must not find payload bytes there unless
  the application chose to put them there.
- **An operator who opens a link, or a page that frames another**, is who the debugging surface has
  to protect.

### What is stored

`localStorage`, under `serial-broker/configurations/v1`, holds one JSON object with an entry per
remembered configuration — one set up with `persist: true`, the default. Each entry is the options
passed to `setup()`: the device filter, line settings, reconnect and timeout settings, text
encoding, `persist` and `maxTabs`. Older releases used `serial-broker/v1/configurations` to
`serial-broker/v4/configurations`; those are moved to the current key once and removed.

- **Any same-origin script can read it, change it and delete it**, and it survives until the site
  data is cleared — also across a user logging out of the application. It holds no payload data,
  nothing received from a device and no permission.
- **An entry written by another script is validated like the application's own options** when
  `restore()` reads it. The most it can do is set up a configuration for a device the user has
  already granted.
- **Configuration names are visible in more places than storage**: in Web Lock names, which any
  same-origin context can list with `navigator.locks.query()`, in every log record and in
  diagnostics reports. Name configurations after the device's role, never after a person, an
  account or anything secret.

The debugging surface stores its own settings under `serial-broker/debug/library-settings`: a
worker URL, a transport and whether to log payloads.

### What is logged

Nothing, unless the application passes a `logger`. The logger then receives records of every level,
and filtering them is the application's decision.

- **Payload bytes** appear only in the `debug` records `supervisor.sent` and `supervisor.received`,
  as the hex of the first 64 bytes, and only with `logPayloads: true`. `configure()` rejects any
  value but a boolean, so a truthy string cannot turn it on. Leave it off in production: whatever
  the logger forwards then carries card numbers and PINs.
- **Decoded text is never logged**, whatever the settings.
- **Other text in log records is not traffic**: the configuration name on every record, and in
  `reason` and `error` fields and in `client.error` messages the text of exceptions the browser
  raised. A browser exception can name a device or a path; treat a log as operational data, not as
  public.

### What errors carry

`context` holds structured detail, and never the bytes of a write: argument names and types, and
for a rejected primitive its value — which for a name is the name, but for a string passed to
`send()` is only its type; byte counts, attempt counts, device IDs and protocol versions;
`UNKNOWN_CONFIGURATION` lists the names set up in the tab.

Two things carry text the application or the browser chose:

- **`LISTENER_THREW`** has, in its message and in `cause`, whatever the application's listener
  threw. A listener whose exception quotes the data it was handling puts that data into the error.
  The error stays in the tab it arose in.
- **Errors of a connection are delivered to every tab of the configuration** as `toJSON()`
  produces them: code, message, context, remediation, and the name and message of the cause.

`toJSON()` is meant for logging services. Before sending `LISTENER_THREW` to one, check what the
listener's exception contains.

### The debugging surface, when it is deployed

`dist/debug/` is static content that nothing serves unless an operator does (ADR-0019). Once it is
served, anyone who can open it on the application's origin sees every configuration of every tab,
all settings, all traffic in full with decoded text, errors with their context, the Web Locks and
the granted ports — and can set up configurations, send bytes, change settings, disconnect, and
revoke device permissions.

- **Serve it only where operators alone can reach it**, behind the application's own
  authentication, or not in production at all.
- **It renders all data as text, never as markup**: configuration names, payloads, error messages
  and values from the address cannot inject HTML or script into it.
- **A link can set its worker URL, transport and payload logging.** A worker URL is a script the
  page runs with the origin's rights, so the page asks before using one that only the link names,
  and never uses one of another origin or a `data:` or `blob:` URL. Transport and payload logging
  run no code and are taken from a link as they are; payload logging only affects the page's own log.
- **It refuses to start inside a page of another origin**, which could otherwise lay its own content
  over the page's buttons. A server can do better than the page: send
  `Content-Security-Policy: frame-ancestors 'self'`, as [debug/README.md](./debug/README.md)
  describes.
