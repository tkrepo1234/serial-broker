# Changelog

All notable changes to this project are documented here, in
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. This project follows
[Semantic Versioning](https://semver.org/); before 1.0, breaking changes bump the minor.

The **wire protocol version** is tracked separately from the package version and is noted
explicitly whenever it changes, because tabs running different protocol versions do not
coordinate with each other. See
[ADR-0008](./docs/adr/0008-wire-protocol-and-versioning.md).

## [Unreleased]

The first release verified against real hardware - an Arduino echo board and the USB/IP device
emulator attached by usbip-win2 - in Microsoft Edge on Windows. Still before 1.0: a minor version
may break the API, and every break is listed below.

**Wire protocol version 14** (7 in 0.1.0-alpha.1). Tabs of this build and tabs of an earlier one do
not share a worker, a lock or a bus; they detect each other and report `PROTOCOL_VERSION_MISMATCH`.
Remembered configurations moved from **storage version 1 to 2** and are not migrated.

### Upgrading from 0.1.0-alpha.1

- **Reload every tab after deploying.** Tabs of the alpha and of this release do not coordinate.
- **Remembered configurations are not carried over.** The first `restore()` finds none of the
  alpha's; set them up again. The browser keeps the device permissions, so no prompt reappears. The
  alpha's key `serial-broker/configurations/v1` is left in `localStorage`, unread.
- **`persist` is now `remember`.** An options object that still says `persist` is read with the
  default, `remember: true`; an `INVALID_ARGUMENT` names `options.remember`.
- **`onReceive` delivers what the device sent once the line is quiet**, not every read on its own:
  `receive.idleMs` (50 ms) of silence ends a delivery, `receive.maxWaitMs` (500 ms) bounds it. Set
  `receive: { idleMs: 0 }` to receive every chunk as it is read, as before.
- **A new `onStatusChange` listener is told the current status once**, right after `subscribe()`
  returns, with `previousStatus` equal to `status`. A listener that counts events, or treats every
  event as a change, has to allow for that one.
- **`setup()` without `device` no longer rejects** with `INVALID_ARGUMENT`: it waits in
  `awaiting-permission` for the user to choose a port. `getStatus()` gains `deviceKind`.
- **`setup()` with the same options starts a `failed` configuration again**, from any tab. Before,
  it did nothing; code that released first to try again still works but no longer needs to.
- **With `connection.autoReconnect: false`, connection errors carry `isRetryable: false`**:
  `DEVICE_DISCONNECTED`, `OPEN_FAILED`, `OPEN_TIMEOUT` and `READ_FAILED` say, in every tab, that
  nothing retries them. Code that skips retryable errors now sees these losses.
- **With `connection.autoReconnect: false`, a `failed` configuration stays `failed` through a
  handover**: when the tab holding the port closes or crashes, the next tab does not connect, and the
  other tabs keep `failed` instead of showing `reconnecting`. Call `setup()` again, in any tab.
- **`requestAccess()` works in any tab taking part in a configuration.** `PERMISSION_REQUIRED` is
  left for a tab `queued` under `maxTabs` or one that withdrew.
- **A write the device does not take in time no longer ends the connection.** `send()` still rejects
  with `WRITE_TIMEOUT`; the port stays open, the writes behind it fail at their deadline with
  `started: false`, and writing carries on when the device takes data again.
- **`send()` can reject with the new code `WRITE_QUEUE_FULL`**: a `switch` over every
  `SerialBrokerErrorCode` needs a case for it.
- **A resolved `send()` means the browser took the bytes for the port** - it always did; the
  documentation no longer says they reached the device.
- **`release(name)` no longer forgets the remembered configuration.** Closing the port is no longer
  a deletion: the entry stays, so `restore()` and a later `setup()` bring the configuration back.
  Code that relied on a release removing it passes `release(name, { forget: true })`, or
  `releaseAll({ forget: true })` for every configuration of the tab. `forgetDevice` is unchanged and
  says nothing about what is remembered (ADR-0033).
- **Only a hard-coded path into the package breaks with the renamed files.** Every import path is
  unchanged - `serial-broker`, `serial-broker/min`, `serial-broker/diagnostics`,
  `serial-broker/diagnostics/min`, `serial-broker/worker` - so an application that imports by
  package name needs no change. What needs one line changed is anything naming a file inside the
  package: a deployment step that copies `dist/index.min.js`, an import map pointing at it, a server
  that checks for it. Use `serial-broker.min.js` instead; the worker script keeps its name, so the
  URL every tab shares does not move.
- **The debugging surface needs `dist/debug/debug.css`** served next to `dist/debug/index.html`;
  serving `dist/` as a whole is unaffected.
- **Diagnostics:** a report's settings carry `remember`, `receive`, `connection.autoReconnect` and
  the full `DeviceFilter` as `device`; the connection reports `stalledWriteSince` and the state
  `listing`; other tabs' reports are checked at the top level only, so read nested fields defensively.
- **Log events:** `storage.migrated` and the `broker.*` ownership records are gone, and new ones
  arrive (see Changed). The Diagnostics chapter lists every current event.

### Added

- **Automatic device mode** (ADR-0036): `device` may be omitted, or `{ auto: true }`; the
  configuration takes its device from the port the user picks in an unfiltered picker - its vendor
  and product ID, or no USB identity - remembers it, and shares it with the other tabs.
  `requestAccess()` may follow `setup()` in the same click. New types `AutoDeviceFilter`,
  `ResolvedDeviceFilter` and `DeviceKind`.
- **`{ nonUsb: true }`** (`NonUsbDeviceFilter`) accepts only ports without a USB identity, and
  `getStatus()` reports **`deviceKind`**: `'usb'`, `'non-usb'`, `'any'` or `'auto'`.
- **Received bytes are collected until the line is quiet** (ADR-0039): `receive.idleMs` and
  `receive.maxWaitMs` (`ReceiveSettings`); the tab holding the port collects, and its settings apply
  everywhere.
- **`connection.autoReconnect`** (default `true`): with `false`, a lost connection or failed attempt
  ends in `failed`, and nothing is retried - not even on replug - until `setup()` is called again
  (ADR-0010).
- **Choosing a different device in auto mode**: `requestAccess(name, { chooseAgain: true })`
  (`RequestAccessOptions`) opens an unfiltered picker in any tab taking part; the chosen port becomes
  the device of every tab and is remembered, and the tab holding the port switches to it, also while
  open (`supervisor.device-changed`). A configuration that names its device rejects with
  `INVALID_ARGUMENT`. The debugging surface offers _Choose a different device…_ for it (ADR-0036).
- **`WRITE_QUEUE_FULL`**: the tab holding the port keeps at most 4096 writes and 64 MiB of payload
  waiting, from every tab together; a write beyond that is refused, and nothing of it was written.
- **The worker's records reach the application's logger** (ADR-0018): `worker.message-refused`,
  `worker.limit-exceeded`, `broker.limit-exceeded`, `worker.other-protocol-version` and
  `worker.message-error`, each once per key, with `clientId` and `reportedBy`.
- The debugging surface's **Choose a device…** sets a configuration up in auto mode and opens the
  picker in the same click, and the page carries a strict `Content-Security-Policy` (ADR-0019).
  _Choose device…_ is offered in every tab using a configuration that waits for permission, not only
  in the tab holding the port.
- **The documentation's navigation stays where it is put.** The theme moved it twice over: reading
  down a page dragged the navigation along by the same distance, and following a link into the
  middle of a page scrolled it to whichever entry matched the anchor. Either way the entry the
  reader was looking at was gone, in a list long enough that finding it again is work. The
  navigation is a map, not a second view of the page; the highlighting that says where the reader
  is remains.
- **The navigation's search box stays in view** while the list under it scrolls, and the chapter
  heading above the page being read stays fully visible: the theme scrolled that page's entry to
  the very top, which left the heading cut in half behind the search box and made the list read as
  though it had slipped a few lines.
- **An arrow back to the top of the documentation's navigation.** The sidebar scrolls separately
  from the page and its scrollbar is easy to miss, so a reader far down a long list - the
  application API now lists every method - had no sign that anything was above. The arrow appears
  in the top left of the sidebar as soon as that list is scrolled, and takes them back.
- **A documentation page showing a complete page with no build step**, "No build step" under
  Examples: the whole of `examples/minimal-js` - one HTML file, an import map, one inline module
  script - embedded from the example itself rather than described, with the line assembly a page
  without a compiler needs written in plain JavaScript beside it.
- **Eleven example applications**, each with a README, a fixed port and a Playwright smoke test
  against a Web Serial stand-in: `minimal`, `multi-tab-dashboard`, `exclusive`, `no-bundler`,
  `openui5`, `react`, `vue`, `svelte` and `angular` (`npm run test:examples`, in CI).
- **The debugging surface offers _Connect_, _Edit settings…_ and _Disconnect…_ as buttons**, for
  whichever configuration is selected, instead of hiding editing and every way of stopping behind a
  ⋯ menu. _Connect_ appears only where there is nothing connected yet. _Disconnect…_ then asks what
  else should go - the remembered configuration, the browser's permission for the device, both or
  neither - with nothing ticked, so the plain answer forgets nothing. It is offered for a
  configuration this page is not using too: forgetting is about what the browser keeps, and used to
  require connecting to an entry just to be allowed to drop it.
- **`release(name, { forget: true })` now forgets a configuration this tab has not set up.** It
  used to return without doing anything, so a page listing what the browser remembers - the
  debugging surface does - could only drop an entry by connecting to it first, which is an odd
  thing to ask of an operator who wants it gone. What is remembered, and the browser's permission
  for the device, belong to the origin rather than to a tab, so both are dropped when asked for;
  the entry is still kept while another tab runs the configuration remembered (ADR-0033).
  Disconnecting itself is unchanged: there is nothing to disconnect from, and that is still not an
  error.
- **`SerialBrokerError.context` is typed.** It was `Readonly<Record<string, unknown>>`, so every
  read was an unchecked cast - `error.context['started'] === false` - even in this library's own
  examples, while the documentation listed the fields for every code. The new
  `SerialBrokerErrorContext` names each documented field with its type, so `error.context.started`
  is a boolean or `undefined` and a misspelt name is a compile error. **Nothing is promised to be
  present**: which fields an error carries depends on where it arose, and an error from another tab
  may come from a later version carrying fields this one has never heard of - so every field is
  optional, and the building side still accepts unknown ones. `ContextFor<Code>` and `hasCode()`
  are exported for code that wants to name the connection between a code and its context.
- **`getStatus()` reports `maxTabs`.** A status component handed only a configuration name can now
  tell whether `queued` is reachable at all, and say what a tab is waiting for, without being passed
  the options the configuration was set up with. `Number.POSITIVE_INFINITY` when there is no limit.
- **`ReleaseOptions.forget`** (default `false`): removes the configuration remembered under the
  name, so `restore()` no longer brings it back. Independent of `forgetDevice`; together they leave
  no trace of the configuration in this browser. A no-op for a configuration set up with
  `remember: false`.
- The debugging surface's ⋯ menu offers _Disconnect_, _Disconnect and forget the configuration_, and
  _Disconnect, forget the configuration and the device_.
- **A classic script build.** `<script src="serial-broker.global.js"></script>` puts the whole
  library on one global, `SerialBroker`, for a page that writes no modules: no import map, no bare
  specifier, and no hash in `script-src` for an inline map. The global is the facade and carries the
  rest of the surface as properties. `serial-broker.diagnostics.global.js` does the same for the
  observer, on `SerialBrokerDiagnostics`. New package subpaths `serial-broker/global` and
  `serial-broker/diagnostics/global`. **`configure({ workerUrl })` is required** with these builds,
  before the first `setup()`: a classic script cannot locate the worker and never guesses one
  (ADR-0043).
- **Two of them are JavaScript**, beside their TypeScript siblings: `examples/minimal-js` is one HTML
  file - markup, an import map and a single inline module script, no modules and no build step - and
  `examples/openui5-js` is the OpenUI5 application and its reusable model in classic `sap.ui.define`
  JavaScript with no transpile step. Each README links to its sibling.
- **Test suites beyond the in-process one:** the built package in a real browser on every CI run
  (`npm run test:browser`, ADR-0035); opt-in hardware runs against an Arduino and the USB/IP emulator
  (`SERIAL_BROKER_HARDWARE=arduino|emulator`) that name the manual test plan's steps they run - on
  the emulator, unplugging, a hung device, a write held while its owner crashes, the backoff while
  the device stays away and forgetting the device among them; an opt-in extreme-usage suite
  (`npm run test:extreme`) in-process and in 20 Edge pages, with results in `RESULTS.md`.
- **Benchmarks** judged against expectations written down first (`npm run bench`,
  `npm run bench:browser`, ADR-0037), with build sizes, in a new Performance chapter.
- **Documentation chapters:** Guarantees (every promise in one place), First connection (replacing
  Quickstart), Known limits, Tasks, counted, and Performance. `test/unit/documentation.test.ts` checks
  documented option defaults, ranges and log events against the source.

### Changed

- **Breaking:** wire protocol version 14 and storage version 2; see Upgrading.
- **Breaking:** the option `persist` is `remember`, and received data is collected by default.
- **Breaking:** `SerialBrokerOptions.device` is optional; `SerialBrokerStatusSnapshot` has the key
  `deviceKind` and reports `vendorId`/`productId` only for `'usb'`; `EffectiveSettings.device` is the
  full `DeviceFilter` union; the context of `DEVICE_MISMATCH` gains `expectedDevice`.
- **Breaking:** a new `onStatusChange` listener receives the current status once.
- **Releasing forgets nothing by default**: a disconnect is not a deletion, and the application
  decides when something is forgotten. A release still lets go of the shared hold that says this tab
  runs a remembered configuration, so another tab's `forget` is never blocked by a tab that has
  disconnected (ADR-0033, ADR-0027).
- **The worker script is minified**, with its source map published beside it: 48.9 KB became
  23.0 KB, and 13.4 KB became 8.0 KB gzipped, on every tab of every installation. Same file, same
  URL, so tabs on any build still share one worker.
- **Published files are named after the package, not after the entry file**: `serial-broker.js`,
  `serial-broker.cjs`, `serial-broker.min.js`, `serial-broker.d.ts` and `serial-broker.diagnostics.*`;
  every `.map` follows its file, and `serial-broker.worker.js` is unchanged.
- **The toolchain's configuration moved to `config/`.** The repository root went from 22 tracked
  files to 14: Prettier, tsup, Vitest, Playwright and TypeDoc keep their configuration there, and
  each npm script names it with a path flag. `package.json`, the tsconfigs, `eslint.config.js` and
  `.editorconfig` stay in the root, where the tools that search for them look. Running one of these
  tools by hand now needs its own `--config` flag (ADR-0042).
- **`WRITE_TIMEOUT` with `started: true` means the issuing tab let the write begin**, and each tab's
  writes are timed by its own `connection.writeTimeoutMs`; the tab holding the port waits at most its
  own `writeTimeoutMs` for its queue and the approval together. Tabs may set it differently.
- **`setup()` retries a `failed` configuration** in whichever tab it is called (ADR-0010), and
  **`requestAccess()` is allowed in any participating tab**: the tab holding the port looks for the
  granted port again, in auto mode with the device chosen there (ADR-0036).
- **Who is still there is told by Web Locks, not heartbeats** (ADR-0041): the worker forgets a tab
  the moment the browser frees that tab's lock, instead of after three silent minutes, and tabs
  replace a worker the moment its lock is freed, instead of after three unanswered heartbeats.
- **Every term of holding the port is a Web Lock** (ADR-0030): a tab believes a claim, a status or
  a release about a term only while its lock is held, and a crashed holder's term ends when the
  browser frees the lock, with no one-second grace period.
- **The `BroadcastChannel` fallback restates instead of replaying**: after a switch the tab attaches
  what it takes part in and restates or asks for its status; traffic sent before the switch is lost.
- **Remembered configurations are stored one per key** (ADR-0033),
  `serial-broker/configurations/v2/entry/<name>` listed in `serial-broker/configurations/v2/index`;
  the Web Lock keeping a remembered configuration is `serial-broker/persisted/v2/<name>`.
- **Answers to status and diagnostics requests are rate-limited, and a diagnostics collection is
  bounded** (ADR-0031); status requests beyond the rate are answered together.
- **Log events:** new `session.device-resolved`, `session.term-not-held`, `session.term-flood`,
  `session.term-check-failed`, `session.term-watch-failed`, `session.data-without-a-term`,
  `session.status-answers-throttled`, `client.diagnostics-answers-dropped`,
  `diagnostics.limit-exceeded`, `supervisor.write-queue-full`, `supervisor.write-stalled`,
  `supervisor.device-changed`, `storage.lookup-failed`, `storage.stale-name`,
  `transport.context-lock-failed`, `transport.worker-watch-failed` and `worker.lock-failed`.
- `PERMISSION_REQUIRED`, `DEVICE_DISCONNECTED` and `RECONNECT_EXHAUSTED` have new remediation texts;
  the package describes itself as built for industrial production interfaces, and the README went
  from 364 to 99 lines, linking the chapters instead of repeating them.

### Removed

- The option `persist` (now `remember`).
- Migration of configurations remembered under `serial-broker/configurations/v1` and the
  protocol-versioned keys before it.
- The replay of messages sent before a switch to `BroadcastChannel`, with the log fields
  `replayedMessages` and `droppedMessages`.
- Log events `storage.migrated`, `broker.owner-claimed`, `broker.owner-gone`,
  `broker.owner-restored`, `broker.no-owner` and `broker.forgot-silent`.
- The Quickstart chapter (now First connection) and `docs/architecture.md` (merged into Internals).

### Fixed

- **The documentation said `isRetryable` was both `true` and `false`** with
  `connection.autoReconnect: false`. The code carries `false` - nothing retries them - and the
  reference said so; the full-featured example said the opposite, in its prose and in its code
  comment. Since the documentation recommends `autoReconnect: false` for a production line, and
  recommends skipping retryable errors, a reader following both would have shown the operator
  nothing when the device was unplugged.
- **The classic-script example raced.** It subscribed on the line after `setup()`, which resolves a
  moment later when it waits for an earlier release of the same name, and dropped the promise, so a
  wrong option became an invisible unhandled rejection. It chains and catches now.
- **Both OpenUI5 examples failed to load.** `ui5-tooling-modules` cuts a resolved path without a
  query string to the empty string, so bundling any package with a `new URL(…, import.meta.url)` -
  serial-broker has one, for the worker - fails and the component never resolves. Each example now
  corrects that one line in its own `node_modules` when it starts or builds, and says so; the
  library is unchanged (ADR-0044).
- **With one tab open - the ordinary case on a production line - disconnecting deleted the
  configuration**, and the next visit had nothing to restore. The debugging surface now keeps the
  configuration listed after _Disconnect_, with _Connect_ beside it.
- **The debugging surface's "The picker was dismissed" notice stayed** until _Choose a device_ was
  clicked again; it is cleared whenever another action starts.
- **A write rejected with `WRITE_TIMEOUT` and `started: false` is never written afterwards.** It
  could be: when the tab holding the port had a longer `writeTimeoutMs`, when the write reached that
  tab part way through its time, or when its request waited before that tab could handle it. The
  tab holding the port now asks the issuing tab before it begins a write from it, and the issuing tab
  agrees only while it has not given the write up (ADR-0013).
- **A write is never written twice when the tab holding the port crashes just after beginning it.**
  Such a write could be handed on to the next tab and written again - the one exception the alpha
  documented to at-most-once. A write the issuing tab approved counts as begun, so a crash reports
  `OWNER_LOST_DURING_WRITE` instead of handing it on (ADR-0013, ADR-0030).
- **The tabs recover within about half a second when a crash takes the `SharedWorker` with it** -
  as the crash of the tab that started the worker does - where the alpha's heartbeats needed 45 to
  60 seconds to notice the dead worker (browser benchmark `handover/crash`, `everyTab` median 0.4 s).
- **A forged `owner-claimed` can no longer divert other tabs' writes** on the `SharedWorker`: the
  broker believed any claim and sent `'owner'`-addressed writes to the claimant; it now routes to
  all participants and only the tab holding the term acts (ADR-0006).
- **A script of the origin can no longer steer a configuration through the bus** (ADR-0030): end a
  term another tab is writing in, invent one that sends writes into the void, make a tab withdraw
  by claiming another `maxTabs`, resolve a write with a forged `write-result`, or have device data
  and errors believed from a context that holds no term.
- **A write the device did not take in time made the port unusable**: the connection was torn down,
  and in Chromium on Windows a port with a write outstanding neither closes nor opens again until
  the page is gone - measured against the USB/IP emulator (ADR-0013).
- **Two tabs remembering different configurations at the same moment** no longer overwrite each
  other's entry, and one unreadable entry no longer risks the others (ADR-0033).
- **Setting the system clock no longer disturbs durations** - the stability window, write expiry,
  late deadlines - which are now measured on `performance.now()`; timestamps stay wall-clock
  (ADR-0014).
- **Every emitted type declaration type-checks without `@types/w3c-web-serial`** under
  `skipLibCheck: false`, not only those the entry points reach.

### Internals

- **Message types 18 → 16**: `heartbeat`, `attach`, `detach` and `goodbye` are gone; `worker-log`
  is new, and `write-started` is replaced by `write-ready` and `write-approval`, one more round trip
  for a write from another tab (logged as `supervisor.write-not-approved` when refused). `hello` carries every configuration a tab takes part in and is sent again when that
  changes; `welcome` names the worker; `owner-claimed` carries `maxTabs`; `status` carries the
  device; `status-request` carries `retry` and the chosen `device`. The `'owner'` target,
  `Transport.setOwnership` and `ownedConfigNames` are gone (ADR-0006).
- **Web Locks for liveness** (ADR-0041): `serial-broker/context/v13/<clientId>` per tab,
  `serial-broker/worker/v13/<workerId>` per worker; `TransportRequest` takes the context's `locks`.
  **Term locks** `serial-broker/term/v13/<maxTabs>/<term>/<clientId>/<name>` (ADR-0030). Every lock
  is held through `HeldLock`, and what a flood would repeat is logged once per key through `OnceLog`.
- Internal exports removed: `HEARTBEAT_INTERVAL_MS`, `SILENT_PARTICIPANT_TIMEOUT_MS`,
  `SWEEP_INTERVAL_MS`, `MAX_UNANSWERED_HEARTBEATS`, `FORMER_OWNER_GRACE_MS`, `MAX_REPLAYED_MESSAGES`,
  `MAX_REPORTED_CONFIGURATIONS`, `LIMITS`, `LimitWarnings`, `LEGACY_STORAGE_KEYS`;
  `MAX_HEARTBEAT_CONFIGURATIONS` is `MAX_HELLO_CONFIGURATIONS`. New: `MAX_WAITING_WRITES`,
  `MAX_WAITING_WRITE_BYTES`, `STATUS_ANSWER_RATE`, `DIAGNOSTICS_ANSWER_RATE`,
  `MAX_REPORTS_PER_COLLECTION`, `MAX_LOG_RECORD_VALUES`.
- The environment seam (ADR-0014): `Clock.monotonicNow()`, and Web Serial described structurally
  (`SerialPortLike`, `SerialOptionsLike` and friends) instead of through ambient types.
- `PortSupervisor` bounds and answers the writes it holds; a diagnostics report is filed after a
  top-level check, not validated in full (ADR-0018).
- **ADRs rolled up**: 0028 to 0041 are new; of 41 decisions, 24 are current and 17 are superseded
  stubs pointing forward (ADR-0001). The reduction inventory is in `docs/reviews/`.
- **In numbers, 0.1.0-alpha.1 → now:** `src/` 51 files, 11 847 → 13 343 lines (14 533 at its peak
  before the reduction of 2026-09-15); in-process tests 1 068 → 1 345, 22 of them the opt-in extreme
  suite; test and spec files 73 → 110, 15 888 → 21 851 lines; ADRs 2 318 → 2 874 lines; Markdown
  7 209 → 12 955 lines.

## [0.1.0-alpha.1] - 2026-09-14

The first release, marked as an alpha: it has not yet been verified against a real serial device.

### Added

- Cross-tab sharing of a Web Serial port: one tab holds the port, every tab reads and writes.
- Automatic ownership failover when the owning tab closes, crashes, or is killed, using the
  Web Locks API so that recovery needs no cooperation from the departing tab.
- Automatic reconnection with bounded exponential backoff and full jitter, short-circuited
  when the platform reports the device has reappeared.
- Configuration persistence in `localStorage`, so a later visit reconnects with no prompt
  where the browser still holds the device permission.
- Text and binary payloads, with streaming text decoding that survives a multi-byte character
  split across chunks.
- A single error type with stable codes, structured context and a mandatory remediation
  sentence, faithfully reconstructed when an error crosses a tab boundary.
- A `BroadcastChannel` fallback for contexts without `SharedWorker`, such as Chrome for
  Android, functionally equivalent to the default. It also takes over when the worker script
  fails to load, replaying what the tab sent before the failure.
- Tabs that die without saying goodbye are forgotten by the worker: every tab sends a heartbeat,
  and the worker drops one that has been silent for three minutes.
- Tabs on different protocol versions detect each other: every tab announces its version on a
  channel no version renames, and a mismatch is reported as `PROTOCOL_VERSION_MISMATCH`.
- A worker script of another protocol version - a copied worker file from another release, or a
  cached one - is reported as `PROTOCOL_VERSION_MISMATCH`, and the tabs move to `BroadcastChannel`
  instead of staying cut off from each other with nothing reported.
- Minified ES module builds, `serial-broker/min` and `serial-broker/diagnostics/min`, for pages
  without a bundler. They use the same worker script as the readable build, and every build is
  checked against the package exports.
- An opt-in structured logger. The library writes nothing to the console uninvited.
- A read-only diagnostics entry point, `serial-broker/diagnostics`. Every tab of the origin
  reports its role, connection state, reconnect timing, pending writes, listeners and effective
  settings, and a configuration's traffic can be watched - without the observing page taking part
  in ownership. The main entry point is unchanged and still reveals nothing of the kind.
- A debugging surface, shipped as static content in `dist/debug/`: one card per configuration on
  the origin, with the tabs running it, its traffic and settings, and the action that fits -
  join, choose a device, release. It sets nothing up on its own.
- `maxTabs` limits how many tabs use a configuration at once, 1 for exclusive use. A tab beyond
  the limit shows the new status `queued` and takes over, in arrival order, when a tab releases the
  configuration, closes or crashes. A tab running a different limit reports
  `CONFIGURATION_CONFLICT` and withdraws.
- Tabs notice a worker that died - crashed, ended for memory, or terminated from
  `chrome://inspect` - because it stops answering their heartbeats. Each reports
  `BROKER_UNAVAILABLE` once and connects to a new worker, where it takes up its part again. The tab
  holding the port restates its status there, and writes lost with the old worker are handed on.
- A write reaches the device at most once, also when the tab holding the port changes while other
  tabs have not yet heard of it: the new owner recognises a request it has already accepted.
- An unplugged device keeps the status `reconnecting`, and `maxAttempts` applies to it. Only a port
  that disappears without a `disconnect` event - a revoked permission - leads to
  `awaiting-permission`.
- Errors not tied to a configuration that arrive while nothing listens for `onError` - a corrupt
  remembered configuration found by `restore()` in a fresh tab, another protocol version noticed
  while nothing was set up - are kept for the first `onError` listener.

### Changed while hardening (2026-09-13)

- `transport: 'sharedworker'` fails with `BROKER_UNAVAILABLE` where the platform has no
  `SharedWorker`, instead of silently using a `BroadcastChannel`.
- `subscribe()` rejects an event name it does not know with `INVALID_ARGUMENT`, instead of
  registering a listener that is never called.
- A tab that withdrew over a different `maxTabs` rejects `send()` at once with
  `CONFIGURATION_CONFLICT`, instead of letting the write wait for its deadline.
- Errors thrown at the public surface carry the time they arose instead of `0`, and every
  `INVALID_ARGUMENT` has the same context: `argumentName`, `expected`, `actualType`,
  `actualValue`.
- Connection attempts are numbered from one alike in errors, log records and diagnostics.
- New log records: `supervisor.teardown-failed`, `client.dispose-failed`,
  `transport.dispose-failed`, and the `transport.*` records of a worker that stopped answering.
- Building and testing need Node 22.13 or later, as the toolchain does. This is declared in
  `devEngines`, so installing the package in an application is not restricted.
- A clean handover no longer fails a write that succeeded, or writes one twice: messages carry the
  term of holding the port, and a started write is failed with `OWNER_LOST_DURING_WRITE` only once
  that term has provably ended (ADR-0026). After a crash this takes up to one second. Other tabs
  show `reconnecting` only once the departing tab has closed the port.
- A `SecurityError` from opening the port, or ports that cannot be listed, end in `failed` at once
  instead of being retried forever or showing `awaiting-permission`; logged as
  `supervisor.gave-up`.
- `release()` forgets a remembered configuration only when no other tab still runs it with
  `persist: true` (ADR-0027); each such tab holds a shared Web Lock for it.
- A tab that meets a worker script of another protocol version and cannot fall back reports it
  once and stops starting new workers, instead of restarting one every 45 seconds.
- `isSupported()` needs a `SharedWorker` or a `BroadcastChannel`, no longer both.
- The published type definitions no longer need `@types/w3c-web-serial` installed; the build
  checks them in a project without it.
- `configure()`, `release()` and `releaseAll()` reject invalid options with `INVALID_ARGUMENT` and
  read them once, when called.
- `release()`, `releaseAll()` and `dispose()` called while a `dispose()` is under way resolve only
  once its ports are closed.
- Clearer remediation for `PROTOCOL_VERSION_MISMATCH`, `BROKER_UNAVAILABLE`, `NOT_CONNECTED` and
  `OWNER_LOST_DURING_WRITE`.
- The debugging surface asks before using a worker URL that only a link names, never uses one of
  another origin, and does not start when framed by another origin.

### Changed while hardening (2026-09-14)

- A message on the bus beyond a documented limit is dropped and logged once per tab as
  `transport.limit-exceeded`; every limit is listed in `SECURITY.md`. Accepted messages are rebuilt
  from their declared fields, so nothing a sender adds travels further.
- The worker holds each port to the identity its `hello` named: it refuses messages before `hello`
  and messages sent under another identity, and a port saying `hello` as an existing tab no longer
  takes that tab's messages or ends its participation.
- A version announcement whose version is not a positive safe integer is ignored.
- `SECURITY.md` says precisely what a script of the same origin can and cannot make serial-broker do.
- A write that rejects with `WRITE_TIMEOUT` and `started: false` is never written afterwards: the tab
  holding the port does not begin a write that waited `writeTimeoutMs` there
  (`supervisor.write-expired`).
- A tab resuming from being frozen, or from sleep, no longer fails a write that succeeded or writes
  one twice: a deadline that fires late first lets the messages that arrived meanwhile be heard.
- A large write is handed to the device one chunk at a time, instead of preparing every chunk first.
- A second `release()` while one is under way resolves only once the port is closed. A listener that
  releases from `onSend` or during `setup()` no longer fails a write or keeps the configuration
  remembered, and a diagnostics watcher removed during a delivery hears nothing more.
- A tab keeps at most 8 reported peer versions and 16 unheard errors, logged once as
  `client.peer-versions-limit` and `client.unheard-errors-dropped`.
- The function `subscribe()` returns removes only its own registration: called after the listener
  was removed and registered again, it leaves the new registration in place.
- In a context with an opaque origin - a sandboxed iframe without `allow-same-origin` - building the
  library raises `WEB_LOCKS_UNAVAILABLE` and `isSupported()` returns `false`, instead of the status
  staying `idle` with nothing said.
- `send()` rejects a payload over 16 MiB with `INVALID_ARGUMENT` in every tab, instead of the write
  timing out when another tab holds the port.
- Errors raised by the facade's own checks carry the time they arose.
- `BROKER_UNAVAILABLE` for a worker that stopped answering has `isRetryable: true`: the tabs replace
  the worker on their own.

### Notes

- Wire protocol version: **7**.
  never released; 2 added the diagnostics request and
  report, 3 the broker's `welcome`, 4 the `heartbeat`, and 5 has the broker answer every heartbeat
  with a `welcome` and freezes the shape of `hello` and `welcome` for every later version
  ([ADR-0024](./docs/adr/0024-keep-the-worker-handshake-version-independent.md)), and 6 adds the tab limit to the `status` message ([ADR-0025](./docs/adr/0025-limit-the-tabs-using-a-configuration.md)), and 7 names the term of holding the port in ownership, write and status messages ([ADR-0026](./docs/adr/0026-attribute-messages-to-a-term-of-holding-the-port.md)).
- Remembered configurations are stored under a key with a version of its own,
  `serial-broker/configurations/v1`, so a protocol change no longer discards them. Configurations
  remembered under the earlier, protocol-versioned keys are moved there when they are first read.
