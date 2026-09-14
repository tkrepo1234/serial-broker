# Security

## Reporting

Report vulnerabilities privately rather than through a public issue, with GitHub's private
vulnerability reporting: on the repository's **Security** tab, choose **Report a vulnerability**. Only
the maintainers see the report, and a fix can be prepared with you before anything is published.
Include what an attacker can do, not only what is wrong.

GitHub offers private reporting for public repositories only. While the repository is private,
everyone who can read it can reach the maintainers directly; report to them instead.

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

**Messages are validated and bounded, not authenticated.** Every message crossing a context
boundary is validated before a field is read, held to the limits below, and a malformed one is
dropped rather than partially applied. This defends against bugs, noise and unrelated scripts
using the same channel name. It is not a defence against a hostile same-origin script, which by
the first assumption above is already inside the boundary. The next section says precisely what
such a script can and cannot do.

## The bus is open to every script of the origin

Tabs talk over a `SharedWorker` port, a `BroadcastChannel` named `serial-broker/broker/v<protocol>`,
and the announcement channel `serial-broker/announcements`; diagnostics requests and reports travel
the same way. Any script of the origin can start the same worker, open the same channels, and post
anything: a bug in the application, a browser extension's content script running in the page, a
tab still running an older build. It can also request the same Web Locks. Nothing in the browser
tells serial-broker which document a message came from. A `BroadcastChannel` carries no sender
identity at all, and a tab's identifier on the bus is no secret: it is in every message the tab
sends, and in its diagnostics report.

### What such a script cannot do

- **Break a tab or the worker with what it posts.** Every decoder is total: it never throws,
  whatever it is handed, and accepts nothing that is not a complete, well-typed message. A seeded
  fuzz test holds the message, report, announcement and handshake decoders to that.
- **Make a tab or the worker hold, or pass on, anything of any size.** Every field is bounded (see
  [Limits](#limits)). An accepted message is rebuilt from the fields its type declares, so nothing a
  sender adds travels further - not to the application, and not into the copy the broker makes for
  each tab. A payload view is copied if it does not span exactly its own buffer, so a small view
  cannot keep a large buffer alive. What exceeds a limit is dropped, and logged once per context at
  `warn`, not once per message.
- **Make a tab report a stream of versions out of garbage.** Only a positive safe integer is taken
  for a protocol version; anything else in `v` is reported, once, as no version at all.
- **Speak on the worker for more than one identity per port.** The worker holds each port to the
  identity its first message, `hello`, named. A message before `hello`, one that names another
  sender, and a `hello` in the name of the broker itself are refused.
- **Take a tab's messages away on the worker, or end its participation.** A port that says `hello`
  under a tab's identity is served next to the tab's own port, never instead of it, and its
  `goodbye` ends only its own port. (A tab that connects again after a worker hung does the same
  thing, and the worker cannot tell the two apart; see below.)
- **Grow the broker without bound.** It keeps a bounded number of participants, ports per
  participant, and configurations.

### What such a script can do

These follow from the missing sender identity, and no validation can prevent them:

- **Read** all traffic, statuses and errors of a configuration, by attaching to it on the worker or
  by listening on the channel. On the worker, by saying `hello` under a tab's identity, it also
  receives a copy of what is addressed to that tab alone, such as the write requests sent to the tab
  holding the port.
- **Write to the device**, with a `write-request` addressed to the current term, which every status
  names - or by calling serial-broker itself.
- **Say anything a tab can say**, on either transport. On the worker it must first say `hello` under
  the identity it speaks for. The consequences include:
  - device data, sent data and errors that never happened, delivered to `onReceive`, `onSend` and
    `onError`;
  - a status that is not the device's, in every tab that does not hold the port;
  - a claim or a status of a term nobody holds: the tabs that do not hold the port take the real
    holder's term for ended, ignore its statuses, address their writes to the invented term, and
    see them time out, until the port changes hands;
  - a status naming another tab limit, which makes those tabs withdraw from the configuration;
  - a `write-result` for a pending write whose request id it knows. On `BroadcastChannel` every
    write request reaches every tab, request id included.
- **Hold the Web Locks** - the ownership lock or the places of a tab limit - and so keep every tab
  away from the device.
- **Cost work within the limits.** There is no rate limit: every well-formed message is decoded and
  handled, the tab holding the port answers every `status-request`, every tab answers every
  `diagnostics-request`, and every tab reports each distinct protocol version announced once.
- **Occupy the broker.** A script that keeps as many participants alive as the broker keeps leaves
  no room for tabs opened afterwards, which then fall back to `BroadcastChannel` or, with
  `transport: 'sharedworker'`, keep trying.

The hardening therefore buys robustness, not isolation: a buggy, noisy or outdated script cannot
crash a tab, exhaust its memory, or make one port speak for all tabs. Only a script that is not of
the same origin is kept out.

### Limits

Every limit is far above what serial-broker sends itself. They are defined, with the reasons for
each value, in `src/protocol/limits.ts`.

| Limit                          | Value            | Bounds                                                                       |
| ------------------------------ | ---------------- | ---------------------------------------------------------------------------- |
| `MAX_IDENTIFIER_LENGTH`        | 256 characters   | A client id, request id, term, diagnostics request id, and a `hello` sender. |
| `MAX_CONFIG_NAME_LENGTH`       | 128 characters   | A configuration name in a message: the limit `setup()` enforces.             |
| `MAX_PAYLOAD_BYTES`            | 16 MiB           | The payload of a `write-request`, `data-received` or `data-sent`.            |
| `MAX_TEXT_LENGTH`              | 32 MiB of UTF-16 | The decoded text of a `data-received`.                                       |
| `MAX_HEARTBEAT_CONFIGURATIONS` | 1024 names       | Each list of configuration names in a heartbeat.                             |
| `MAX_ERROR_VALUES`             | 256 values       | A serialised error, its context and cause, however nested.                   |
| `MAX_ERROR_CHARACTERS`         | 64 KiB           | All strings of a serialised error together.                                  |
| `MAX_REPORT_VALUES`            | 65 536 values    | A diagnostics report, however nested.                                        |
| `MAX_REPORT_CHARACTERS`        | 1 MiB            | All strings of a diagnostics report together.                                |
| `MAX_REPORTED_CONFIGURATIONS`  | 1024             | The configurations one diagnostics report describes.                         |
| `MAX_PARTICIPANTS`             | 1024             | The tabs and observers the broker keeps.                                     |
| `MAX_PORTS_PER_PARTICIPANT`    | 8                | The ports the broker keeps for one identity.                                 |
| `MAX_CONFIGURATIONS`           | 4096             | The configurations the broker keeps bookkeeping for.                         |

A cycle, a value shared between two places, a function or a symbol inside an error or a report
exceeds its limit too. A tab logs an exceeded limit as `transport.limit-exceeded`, with the limit's
name and value. The worker logs `worker.limit-exceeded`, `broker.limit-exceeded` and
`worker.message-refused`, which no tab sees.

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
