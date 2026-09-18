# Security

## Reporting

Report vulnerabilities privately rather than through a public issue, with GitHub's private
vulnerability reporting: on the repository's **Security** tab, choose **Report a vulnerability**. Only
the maintainers see the report, and a fix can be prepared with you before anything is published.
Include what an attacker can do, not only what is wrong.

Where that choice is not offered, everyone who can read the repository can reach the maintainers
directly; report to them instead.

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
a name, the device filter (USB vendor and product IDs, `any`, `nonUsb`, or auto mode with the device
the user chose), line settings, reconnect and timeout settings, text encoding, receive settings,
`remember` and the tab limit. No payload data, no credentials, nothing derived from device traffic.

**What is logged.** Nothing, unless an application supplies a logger. When one is supplied,
payload bytes never appear at `info` level or above — serial traffic routinely carries card
numbers and PINs — and appear at `debug` only when `logPayloads` is explicitly enabled.

**Messages are validated and bounded, not authenticated.** Every message crossing a context
boundary is validated before a field is read, held to the limits below, and a malformed one is
dropped rather than partially applied. This defends against bugs, noise and unrelated scripts
using the same channel name. It is not a defence against a hostile same-origin script, which by
the first assumption above is already inside the boundary. The next section says precisely what
such a script can and cannot do.

**What a message says about the port is checked against the browser.** Which tab holds the port,
and for how long, is a Web Lock rather than an announcement (ADR-0005, ADR-0018): a tab believes a
claim or a status only while the lock named after that term of holding the port is held, and takes
the term for over only when the browser frees that lock. So a message can neither invent a term nor
end one. Messages are still not authenticated — a script that also takes Web Locks is a different
matter, and is listed below.

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
  whatever it is handed, and accepts nothing that is not a complete, well-typed message — a
  diagnostics report is typed only as far as filing it needs, and read defensively below that
  (ADR-0014). A seeded fuzz test holds the message, report, announcement and handshake decoders to
  that.
- **Make a tab or the worker hold, or pass on, anything of any size.** Every field is bounded (see
  [Limits](#limits)). An accepted message is rebuilt from the fields its type declares, so nothing a
  sender adds travels further — not to the application, and not into the copy the broker makes for
  each tab. A payload view is copied if it does not span exactly its own buffer, so a small view
  cannot keep a large buffer alive. What exceeds a limit is dropped, and logged once per context at
  `warn`, not once per message.
- **Make a tab report a stream of versions out of garbage.** Only a positive safe integer is taken
  for a protocol version; anything else in `v` is reported, once, as no version at all.
- **Speak on the worker for more than one identity per port.** The worker holds each port to the
  identity its first message, `hello`, named. A message before `hello`, one that names another
  sender, and a `hello` in the name of the broker itself are refused.
- **Divert or delay another tab's writes by claiming the port.** The broker tracks no owner: a write
  request goes to every participant of its configuration, and only the tab holding the term it names
  acts on it (ADR-0006).
- **Take a tab's messages away on the worker, or end its participation.** Ports of one identity are
  served next to each other, never instead of each other, and a context's participation ends only
  when the browser lets go of the Web Lock that context holds for its lifetime (ADR-0024).
- **Grow the broker without bound.** It keeps a bounded number of participants, ports per
  participant, and configurations.
- **End, or invent, a term of holding the port.** A term is a Web Lock held by the tab that holds
  the port, from before its first word in that term until after its last (ADR-0018). A claim, a
  status or a goodbye naming a term nobody holds changes nothing, and no message ends a term whose
  lock is still held — not even a goodbye posted while a request of the script's own waits on that
  lock, because a term ends only once the browser has freed it. So a forged goodbye cannot fail a
  write that a tab is still performing, and a forged claim cannot make the other tabs address their
  writes into the void.
- **Make a tab withdraw over a tab limit.** The limit of the tab holding the port is part of that
  term's lock name, so a status naming another limit names no term of the configuration
  (ADR-0017).
- **Settle, strand or begin another tab's write.** A write is asked about, or answered, only by the
  term it was addressed to and only by the context that holds that term's lock. A `write-ready` or
  `write-result` from anywhere else — with a request id read off the channel — is ignored, so no
  script can tell an application that bytes reached the device. The tab holding the port begins a
  write only on a `write-approval` from the context that issued it; one from any other identity is
  ignored, and the write is not begun (ADR-0011).
- **Pass off data or errors as the device's** to a tab that knows who holds the port:
  `data-received`, `data-sent` and `error` are delivered only from a context that speaks for a term
  this tab knows of. A script that speaks under the identity of the tab holding the port still can;
  see below.
- **Make a tab answer, log or report without limit.** Answers to `status-request` and
  `diagnostics-request` and the reports one diagnostics collection keeps are rate-limited, each by a
  named limit (see [Rates](#rates)); what is dropped, and a malformed message, is logged once per
  context and kind rather than per message. A tab
  that asks for the status during a flood is still answered: one answer covers every request.
- **Make the tab holding the port hold writes without bound.** A port keeps at most
  `MAX_WAITING_WRITES` writes and `MAX_WAITING_WRITE_BYTES` of payload; a write beyond either is
  refused with `WRITE_QUEUE_FULL`, which says that nothing of it was written.

### What such a script can do

These follow from the missing sender identity, and no validation can prevent them:

- **Read** all traffic, statuses, errors and write requests of a configuration, by attaching to it
  on the worker or by listening on the channel — and what is addressed to one tab alone, by saying
  `hello` on the worker under that tab's identity, which is no secret (ADR-0006).
- **Write to the device**, with a `write-request` addressed to the current term, which every status
  names — or by calling serial-broker itself.
- **Say anything a tab can say**, on either transport, under the identity of any tab, the tab
  holding the port included, and in the name of the term that tab really holds — both are on the bus
  for anyone to read. On the worker it first says `hello` under that identity on a port of its own.
  The consequences include:
  - device data and sent data that never happened, delivered to `onReceive` and `onSend`;
  - a status that is not the device's, in every tab that does not hold the port;
  - a `write-result` for a write addressed to that term, whose request id it knows: every write
    request reaches every participant, request id included;
  - a `write-approval` under the identity of the tab that issued a write, which lets the tab holding
    the port begin that write after its issuer gave it up — no more than a `write-request` of the
    script's own puts on the device;
  - errors that did not happen, delivered to `onError`.
- **Hold the Web Locks** — the ownership lock, the places of a tab limit, or a lock named for a term
  it invents — and so keep every tab away from the device, have an invented term believed while it
  holds its lock, or, by queueing on the lock of a real term, make the other tabs wait for a goodbye
  that never comes. A script that takes locks is beyond what validation or attribution can reach;
  the first assumption of this document is why.
- **Cost work up to the rates.** Every well-formed message is decoded, and a flood can crowd
  legitimate answers, reports and log records out of the rates above — the tabs go on sharing the
  port either way. Every tab also reports each distinct protocol version announced once. A flood of
  claims naming invented terms costs each tab one lock check per term, up to the few terms it keeps;
  the newest claim is always one of them, so the term that really holds the port is checked.
  What a tab misses while it is learning which term that is — the chunks of a device streaming into
  a tab that has just joined — it misses; the drop is recorded once per configuration.
- **Occupy the broker.** A script that keeps as many participants alive as the broker keeps leaves
  no room for tabs opened afterwards, which then fall back to `BroadcastChannel` or, with
  `transport: 'sharedworker'`, keep trying.

The hardening therefore buys robustness, not isolation: a buggy, noisy or outdated script cannot
crash a tab, exhaust its memory, or make one port speak for all tabs. Only a script that is not of
the same origin is kept out.

### Limits

Every limit is far above what serial-broker sends itself. They are defined, with the reasons for
each value, in `src/protocol/limits.ts`.

| Limit                                  | Value            | Bounds                                                                       |
| -------------------------------------- | ---------------- | ---------------------------------------------------------------------------- |
| `MAX_IDENTIFIER_LENGTH`                | 256 characters   | A client id, request id, term, diagnostics request id, and a `hello` sender. |
| `MAX_CONFIG_NAME_LENGTH`               | 128 characters   | A configuration name in a message: the limit `setup()` enforces.             |
| `MAX_PAYLOAD_BYTES`                    | 16 MiB           | The payload of a `write-request`, `data-received` or `data-sent`.            |
| `MAX_TEXT_LENGTH`                      | 32 MiB of UTF-16 | The decoded text of a `data-received`.                                       |
| `MAX_HELLO_CONFIGURATIONS`             | 1024 names       | The list of configuration names in a `hello`.                                |
| `MAX_ERROR_VALUES`                     | 256 values       | A serialised error, its context and cause, however nested.                   |
| `MAX_ERROR_CHARACTERS`                 | 64 KiB           | All strings of a serialised error together.                                  |
| `MAX_REPORT_VALUES`                    | 65 536 values    | A diagnostics report, however nested.                                        |
| `MAX_REPORT_CHARACTERS`                | 1 MiB            | All strings of a diagnostics report together.                                |
| `MAX_PARTICIPANTS`                     | 1024             | The tabs and observers the broker keeps.                                     |
| `MAX_PORTS_PER_PARTICIPANT`            | 8                | The ports the broker keeps for one identity.                                 |
| `MAX_CONFIGURATIONS`                   | 4096             | The configurations the broker keeps bookkeeping for.                         |
| `MAX_REPORTS_PER_COLLECTION`           | 1024             | The reports one diagnostics collection keeps.                                |
| `MAX_REPORT_CHARACTERS_PER_COLLECTION` | 16 MiB           | All strings of the reports one collection keeps, together.                   |
| `MAX_WAITING_WRITES`                   | 4096             | The writes waiting at one tab's port.                                        |
| `MAX_WAITING_WRITE_BYTES`              | 64 MiB           | The payload bytes waiting at one tab's port.                                 |
| `MAX_LOG_RECORD_VALUES`                | 32 fields        | The fields of one of the worker's records, forwarded to a tab.               |
| `MAX_LOG_RECORD_CHARACTERS`            | 4 KiB            | The message and fields of such a record together.                            |

A cycle, a value shared between two places, a function or a symbol inside an error or a report
exceeds its limit too. A tab logs an exceeded limit as `transport.limit-exceeded`, with the limit's
name. The worker logs `worker.limit-exceeded`, `broker.limit-exceeded` and
`worker.message-refused`, once per kind, and sends those records to the tabs connected to it, which
write them to their own loggers. Such a record names identities, limits, message types and reasons;
never a payload.

### Rates

How often the bus may make a tab work, beyond dropping a message (ADR-0019). Each is a burst
allowed at once and an allowance coming back per second; the values and their reasons are in
`src/protocol/limits.ts`. The first thing dropped is logged at `warn`, once per context and limit.

| Limit                     | Burst | Per second | Bounds                                                                                                                |
| ------------------------- | ----- | ---------- | --------------------------------------------------------------------------------------------------------------------- |
| `STATUS_ANSWER_RATE`      | 32    | 32         | Answers to `status-request` by the tab holding the port. Requests beyond it are answered together by the next answer. |
| `DIAGNOSTICS_ANSWER_RATE` | 8     | 4          | Answers to `diagnostics-request` by each tab.                                                                         |

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

`localStorage` holds every remembered configuration — one set up with `remember: true`, the default —
under two kinds of key:

- `serial-broker/configurations/v1/index`, a JSON array of the remembered names;
- `serial-broker/configurations/v1/entry/<name>`, one per configuration, holding the options passed
  to `setup()`: the device filter — for a configuration in auto mode, the device the user chose,
  as `{ auto: true, resolved: … }` — line settings, reconnect and timeout settings, text encoding,
  receive settings, `remember` and `maxTabs`.

A key written under another storage version is neither read nor removed (ADR-0020): nothing is
migrated, and such a key stays until the site data is cleared.

- **Any same-origin script can read it, change it and delete it**, and it survives until the site
  data is cleared — also across a user logging out of the application. It holds no payload data,
  nothing received from a device and no permission.
- **An entry written by another script is validated like the application's own options** when
  `restore()` reads it. The most it can do is set up a configuration for a device the user has
  already granted.
- **Configuration names are visible in more places than storage**: in the storage keys themselves,
  in Web Lock names, which any same-origin context can list with `navigator.locks.query()`, in every
  log record and in diagnostics reports. Name configurations after the device's role, never after a
  person, an account or anything secret.

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

`dist/debug/` is static content that nothing serves unless an operator does (ADR-0015). Once it is
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
