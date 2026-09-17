# Usability review, 2026-09-14

The usability part of BACKLOG.md, "Performance tests, example apps and a usability review": the step
counts, a cold read of every example application, and the check that no task needs a concept beyond
`setup`, `subscribe`, `requestAccess`, `send` and `release`.

## Method

- **Step counts.** Seven tasks, each written with serial-broker and with the Web Serial API alone,
  counted as calls, options and concepts. The table and the code are the documentation site's new
  chapter [Tasks, counted](../site/tasks.md); the code is type-checked with the other examples.
- **Cold read.** For each of the nine example applications (`minimal`, `multi-tab-dashboard`,
  `exclusive`, `no-bundler`, `openui5`, and `react`, `vue`, `svelte`, `angular` from their branches),
  the reviewer read the documentation site, the library's README and the TSDoc that the API reference
  is generated from, and the example's README for what to build. The reviewer then wrote the
  application's integration before opening its code. The four plain TypeScript and JavaScript
  attempts were type-checked against the built declarations; the framework ones were sketches. Every
  question and guess was logged as it came up. Only then was each example's code opened, to see where
  it answered the same question differently.
- **Checking the answers.** Where the documentation left a question open, the source answered it,
  and where that mattered, a run on the test harness (`test/harness/`) did.
- **Limits.** The reviewer was an agent reading everything in one session, not a developer new to
  the library. The example READMEs say what each application shows, and some of their design
  decisions give answers away; they had to be read to know what to build. A person reading cold will
  find gaps this review did not.

## Findings in brief

1. **A page in auto mode that calls only `setup()` asks for the device again on every visit, and
   forgets the remembered one.** The Quickstart, the Simple tier and the README said otherwise. The
   documentation called `restore()` first until
   [P1](#p1-auto-mode-takes-the-remembered-device-in-setup) fixed it in the library (2026-09-15),
   and says again what it said before.
2. Four steps that every integration writes come from the API, not from the application: reading
   the status after subscribing ([P3](#p3-a-new-onstatuschange-listener-hears-the-current-status)),
   releasing before a retry ([P2](#p2-setup-starts-a-failed-configuration-again)), `restore()` in auto
   mode ([P1](#p1-auto-mode-takes-the-remembered-device-in-setup), done), and finding the one tab that
   may ask for permission ([P4](#p4-requestaccess-from-any-tab)).
3. The rest were gaps in the documentation, each closed by a sentence or two where a reader looks
   for it.

## Cold-read log

Each entry: the question or guess, the applications where it came up, and how it is resolved.

**U1. Do I name the worker URL, and how does my toolchain serve the script?** All nine. Installing
said that Vite, webpack 5, Parcel 2 and Rollup find the script with nothing to do, but all nine
examples name it. The Angular CLI's builder and the OpenUI5 module bundler do not emit it, and the
`serial-broker/worker` export that Vite's `?url` import uses was not in the Installing table, which
said "three things" above five rows. _Fixed:_ Installing lists `serial-broker/worker` and says to
name the URL, with the Vite import and the copy route (`assets` in `angular.json`).

**U2. Which files does a page without a bundler copy?** `no-bundler`. The minified build was
described as "the same code", with no word on whether it loads further chunks. It does not (checked
in `dist/`). _Fixed:_ Installing says each minified build is one file that imports nothing else.

**U3. In auto mode, does a later visit reconnect with `setup()` alone?** `minimal` (the attempt used
auto mode, as the Quickstart does). The Quickstart said "On every later visit, `setup()` finds the
port and opens it with no prompt", and the Simple tier said the same. It is not so: `setup()` never
reads the remembered configurations. An auto-mode configuration set up on a later visit starts
unresolved and waits with `awaiting-permission` although the port is granted. It also saves itself
unresolved, over the entry that held the device, so a `restore()` after it finds nothing to
reconnect to. Measured on the harness (`BrowserHarness`, `READER` device): first visit `setup()`,
the picker, `close()`. A second tab's `setup()` only gave `awaiting-permission`, and the stored
entry was `{ "device": { "auto": true }, … }`. A third tab's `restore()` then also gave
`awaiting-permission`. `restore()` _before_ `setup()` reconnects, as `auto-device.test.ts` shows.
_Fixed in the documentation:_ the Quickstart, the Simple tier's code and text, the README and the
`setup()` TSDoc call `restore()` first. _Proposal:_ [P1](#p1-auto-mode-takes-the-remembered-device-in-setup).
_Fixed in the library (2026-09-15):_ P1 is implemented, and the documentation fix is reverted.

**U4. `subscribe()` needs the name to be set up, so how do I see a status change in between?** All
nine. The Simple tier answers it: read `getStatus()` after subscribing. All nine examples do.
_Left as documented;_ the step itself is [P3](#p3-a-new-onstatuschange-listener-hears-the-current-status).

**U5. When `setup()` rejects, is anything registered?** `minimal`, `react`, `vue`, `svelte`, which show
`failed` for a failed setup. Configuration said so for `INVALID_ARGUMENT` only. _Fixed:_ the
`setup()` TSDoc says nothing is registered when it rejects (checked in `serial-broker-client.ts`:
validation and the support check come before the session is created).

**U6. Can an `onError` event for a configuration carry `name: undefined`?** `minimal`. The TSDoc
said "or `undefined` for a failure not tied to one", yet listeners are registered per name. Every
emission uses the configuration's name, and errors not tied to one are delivered to each
configuration (`configuration-session.ts`). _Fixed:_ the `ErrorEvent.name` TSDoc says so. The type
keeps `| undefined`: narrowing it is an API change for the lead to decide, and nothing gains from it
now.

**U7. Every tab shows the connect button, so which one may press it?** All nine. The All-features
tier and Errors say that only the tab holding the port can ask, and that the others get
`PERMISSION_REQUIRED`. The Quickstart, which tells the reader to show the button for
`awaiting-permission`, did not. The user cannot know which tab holds the port: the API hides it on
purpose. _Fixed:_ the Quickstart says so and says to show the error. _Proposal:_
[P4](#p4-requestaccess-from-any-tab).

**U8. Do my listeners survive `release()`?** `multi-tab-dashboard`, `exclusive`, `vue`, `svelte`,
`angular`. Nothing said so. The Full-featured tier unsubscribes by hand before it releases, which
suggested that they would survive. They do not: `released` is delivered through `onStatusChange`,
then the listeners are cleared (`configuration-session.ts`, `release()`; confirmed on the harness).
_Fixed:_ the `release()` TSDoc, the `released` status TSDoc and the Tasks chapter. The Full-featured
tier's own unsubscribing is harmless, and stays.

**U9. After `failed`, does `setup()` try again?** `multi-tab-dashboard`, `exclusive`, `no-bundler`,
`vue`, `svelte`, `angular`. Configuration said that an equal second `setup()` does nothing, and
Errors said to "release and set up again" for two codes, but not that the no-op holds for a failed
configuration too. Every one of these examples releases before it sets up again: four check
`exists()` first, `svelte` and `angular` track it themselves.
_Fixed:_ Configuration and the `setup()` TSDoc say so. _Proposal:_
[P2](#p2-setup-starts-a-failed-configuration-again).

**U10. Does a second `setup()` with only `remember` changed apply it?** `multi-tab-dashboard`. "Other
options passed to a second `setup()` in the same tab are ignored" answered it, but only for a
reader who takes `remember` as one of them. _Fixed:_ the sentence names `remember`.

**U11. With `maxTabs`, is the first tab's first status `queued` or `idle`?** `exclusive`. The
documentation described `queued` only for a tab beyond the limit; a page that logs transitions
shows `queued -> idle` in the first tab as well (`configuration-session.ts`, `start()`). _Fixed:_
Configuration (`maxTabs`) and the `queued` status TSDoc.

**U12. Does `dispose()` on `pagehide` hand on a `maxTabs` place too, or only the port?** `exclusive`.
How shared ports behave says `dispose()` closes the port before the locks are let go, and places
are Web Locks (Limiting how many tabs use a port). _Left:_ the two sections together answer it, and
a sentence more would repeat them.

**U13. Two components set up the same name. Is that one configuration or two, and does one
`release()` end it for both?** `react`, `vue`, `svelte`, `angular`. The documentation said that a
second `setup()` "does nothing", not that there is no count. Every framework integration found out
and built a registry by name. _Fixed:_ Configuration and the `setup()` TSDoc say that a name is one
configuration per tab and that one `release()` ends it for every caller. _Considered, not proposed:_
a count per name would change what `release()` means for every application, and a framework
integration needs its own registry anyway, for its state.

**U14. Does a component release the device when it unmounts?** `react`, `vue`, `svelte`, `angular`,
`openui5`. The examples decided differently: Svelte releases on destroy by default, the others do
not. The documentation offered only "`dispose()` … useful in single-page applications that tear down
a feature area". _Fixed:_ the Tasks chapter (Release) says to release when the tab no longer needs
the device, not when one view closes if other code uses the name. Svelte's default fits a component
that is the only user, which its README says.

**U15. Can the options be a framework's reactive proxy?** `svelte`, which passes
`$state.snapshot(options)`. "Each option is read once, when the call is made" suggested a copy
without saying so. It is one: every field is read once and copied into a frozen object, and the
source comments name proxies (`normalizeConfiguration`, `normalizeDeviceFilter`). _Fixed:_
Configuration says the options are copied and a reactive proxy is fine.

**U16. Two configurations, one `{ any: true }` and one by USB IDs: can the first take the second's
port?** `openui5`, which runs exactly that pair. Configuration says `{ any: true }` is for "ports
with no USB identity where nothing else is granted", but Several devices did not warn. It can:
`findGrantedPort()` filters the granted ports by device only, and nothing keeps configurations
apart. _Fixed:_ Advanced > Several devices says to give every configuration a device of its own.

**U17. Where do lines come from?** All nine. Five assemble lines (`multi-tab-dashboard`, `openui5`,
`react`, `vue`, `angular`), and three of them handle CR, LF and a CR LF split across chunks. The README, the All-features tier and Advanced show an assembler. _Left:_
framing is outside the library by decision (ADR-0002), and the examples it takes are there.

**U18. With zone.js, do listeners run inside Angular's zone?** `angular`. _Left:_ a question about
the framework, not the library; the example uses signals, where it does not arise.

**U19. How does an ES module get into the UI5 loader?** `openui5`. _Left:_ framework tooling; the
example's README covers `ui5-tooling-modules`.

**U20. StrictMode subscribes twice, and a `setup()` can resolve after the component left.** `react`,
`vue`, `svelte`. The TSDoc says registering the same function twice has no extra effect, but fresh
arrow functions are not the same function. _Left:_ ordinary asynchronous hygiene in each framework,
and no change to the library would take it away.

**U21. What does `restore()` add for a page that knows its one configuration?** `multi-tab-dashboard`.
Nothing, when the device is named by USB IDs; with auto mode it is needed (U3). _Fixed:_ the Tasks
chapter (Remember and restore) says both. Since P1 (2026-09-15) it adds nothing in auto mode either,
and the chapter says so.

**U22. Should Send be disabled while the port is not open?** `minimal` and every framework example.
The documentation says a write waits for a connection up to `connection.writeTimeoutMs`. _Left:_
the application's choice, and the examples explain theirs.

## No task beyond the five

Every call an example makes beyond `setup`, `subscribe`, `requestAccess`, `send` and `release`,
counted from its sources:

| Example               | Beyond the five                                                       |
| --------------------- | --------------------------------------------------------------------- |
| `minimal`             | `getStatus`, `configure`                                              |
| `multi-tab-dashboard` | `getStatus`, `exists`, `restore`, `configure`, `openDiagnostics`      |
| `exclusive`           | `getStatus`, `exists`, `dispose`, `isSupported`, `configure`          |
| `no-bundler`          | `getStatus`, `exists`, `isSupported`, `PROTOCOL_VERSION`, `configure` |
| `openui5`             | `getStatus`, `restore`, `isSupported`, `configure`                    |
| `react`               | `getStatus`, `configure`                                              |
| `vue`                 | `getStatus`, `exists`, `configure`                                    |
| `svelte`              | `getStatus`, `dispose`, `configure`                                   |
| `angular`             | `getStatus`, `configure`                                              |

The exceptions, and why each stays:

| Beyond the five                    | Where                                | Reason                                                                                                                                                       |
| ---------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `getStatus()` after `subscribe()`  | all nine                             | Forced by the API: the status can change before the listener exists. [P3](#p3-a-new-onstatuschange-listener-hears-the-current-status).                       |
| `exists()` and a release, to retry | four by `exists()`, two by own state | Forced by the API: `setup()` does nothing for a failed configuration. [P2](#p2-setup-starts-a-failed-configuration-again).                                   |
| `restore()`                        | `multi-tab-dashboard`, `openui5`     | Remembering is the task itself where users define configurations. In auto mode it was forced until [P1](#p1-auto-mode-takes-the-remembered-device-in-setup). |
| `configure({ workerUrl })`         | all nine                             | Installation, not a task: the URL is the deployment's decision, and a bundler that emits the script needs no call.                                           |
| `dispose()` on `pagehide`          | `exclusive`, `svelte`                | Optional: the browser lets go of everything when the tab dies; the call only hands the port on sooner.                                                       |
| `isSupported()`                    | `exclusive`, `no-bundler`, `openui5` | Optional: `setup()` rejects with `WEB_SERIAL_UNAVAILABLE` and its remediation anyway.                                                                        |
| `openDiagnostics()`                | `multi-tab-dashboard`                | Operators' tooling behind an entry point of its own, deliberately outside the application API (ADR-0018).                                                    |
| `PROTOCOL_VERSION`                 | `no-bundler`                         | Shown as build information; nothing depends on it.                                                                                                           |

The `SerialBrokerError` fields (`code`, `remediation`, `isRetryable`) are counted as part of
`subscribe` and of every call that rejects, not as a concept of their own.

## Design proposals

Each removes a step that the API forces. None is implemented here; P1 was implemented afterwards.

### P1. Auto mode takes the remembered device in `setup()`

**Status: done, 2026-09-15.** Implemented as proposed, and recorded as an amendment to ADR-0036. An
explicit device, a `resolved` passed to `setup()` and `remember: false` take nothing remembered,
and only a remembered auto-mode resolution is taken. The documentation fixes for U3 are reverted.

**Problem.** U3. A configuration in auto mode forgets its device on every visit that calls `setup()`
without `restore()` first, and overwrites the remembered device with nothing. It hits the path the
Quickstart teaches.

**Proposal.** When `setup()` creates an auto-mode configuration that has not resolved, it reads the
remembered entry of the same name. If that entry is in auto mode and resolved, it seeds `resolved`
from it, as passing `resolved` does. Separately, saving an unresolved auto-mode configuration never
replaces a stored resolution of the same name. `restore()` is then needed only for configurations the
page does not set up itself.

**Cost.** One storage read per `setup()` in auto mode, and a test next to "remembers the resolved
device, so a later visit reconnects without a prompt" that reloads with `setup()` alone. The
documentation fixes for U3 are reverted: the Quickstart, the Simple tier, the README and the
`setup()` TSDoc.

### P2. `setup()` starts a failed configuration again

**Problem.** U9. A `failed` configuration is still set up, so `setup()` with the same options does
nothing, and every "try again" button releases first.

**Proposal.** `setup()` with options equal to those of a configuration whose status is `failed`
releases it and sets it up again, in one call, before it resolves. A configuration in any other
status stays a no-op, as now.

**Cost.** A configuration that failed after a `maxTabs` conflict fails again at once if nothing
changed, which is what release-and-setup does today. The attempt counter starts over, as it does
today. It changes what an equal `setup()` means, which the API guidelines treat as a decision worth
an ADR amendment (ADR-0025 for the withdrawal, and the idempotence principle).

### P3. A new `onStatusChange` listener hears the current status

**Problem.** U4. Every example calls `getStatus()` right after `subscribe()`, because a status change
between `setup()` and `subscribe()` would otherwise go unseen.

**Proposal.** `subscribe(name, 'onStatusChange', listener)` delivers the current status to that
listener once, in a microtask, with `previousStatus` equal to `status`. After that, changes arrive as
now.

**Cost.** It changes when an event fires, which docs/guidelines/api-design.md lists as breaking;
before 1.0 that is a minor bump. A listener that counts transitions sees one more call.
`getStatus()` stays, for code that reads the status without a listener.

### P4. `requestAccess()` from any tab

**Problem.** U7. Every tab shows `awaiting-permission`, so every tab shows the button, but only the
tab holding the port can use the picker. A user who clicks in another tab gets
`PERMISSION_REQUIRED`, and neither the user nor the page can know which tab to use.

**Proposal.** A tab that knows another tab holds the port shows the picker anyway. A permission is
granted to the origin, so the holding tab's `getPorts()` sees the port. After the grant, the tab
tells the holding tab on the bus to look for granted ports again, and for an auto-mode configuration
sends the chosen port's identity. The holding tab resolves the device if it has none, and opens the
port as after a `requestAccess()` of its own. The call resolves `true` once the grant is made, and
`false` when the picker is dismissed. `PERMISSION_REQUIRED` remains for a `queued` tab.

**Cost.** A new bus message: a protocol version bump and an ADR that amends ADR-0036. Two tabs that
choose different ports at once are decided by the tab holding the port, as ADR-0036 already decides
concurrent choices.

## For the examples

Not documentation defects, but found on the way, for whoever maintains the examples:

- **Two READMEs disagree about Vite.** The `multi-tab-dashboard` README says that the library's
  `new URL(…, import.meta.url)` "does not survive bundling"; the `minimal` README says that Vite's
  dependency optimizer rewrites it, and its build emits the script. Not measured here. Both name the
  URL, as Installing now recommends.
- **`svelte` does not need `$state.snapshot()`** for the options (U15). Harmless.
- **`openui5` runs `Reader` with `{ any: true }` next to `Printer` by USB IDs** (U16). With both
  ports granted, `Reader` can open the printer's port. Its smoke test grants one device, so it does
  not show.
