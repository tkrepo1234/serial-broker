# Compared with Web Serial

What seven common tasks take with serial-broker, next to the same tasks with the Web Serial API
alone. Each task has its code both ways; both are type-checked with the rest of the documentation's
examples.

The counts are of what an application writes:

- **Calls:** functions and methods of the library or the platform that the code calls.
- **Options:** settings the code passes, with a device's USB IDs counted as one. Options left at
  their defaults are not counted.
- **Concepts:** what a developer has to understand to get the task right. They are named under each
  task.

The Web Serial code runs in one tab. Web Serial cannot share a port between tabs: a second tab's
`open()` rejects with `InvalidStateError`. The last column says what several tabs would take by
hand. The serial-broker code imports `SerialBroker` from `serial-broker`.

| Task                                                                            | serial-broker | Web Serial, one tab | Web Serial, several tabs                                     |
| ------------------------------------------------------------------------------- | ------------- | ------------------- | ------------------------------------------------------------ |
| [Connect and print received text](#connect-and-print-received-text)             | 2 / 3 / 3     | 7 / 2 / 5           | Not possible; by hand, an election and a channel             |
| [Send a command and await it](#send-a-command-and-await-it)                     | 1 / 0 / 3     | 4 / 0 / 3           | Every write sent to the tab holding the port, and its result |
| [Show the status](#show-the-status)                                             | 1 / 0 / 2     | 2 / 0 / 3           | Every change sent to every tab, and asked for on joining     |
| [Ask for permission](#ask-for-permission)                                       | 2 / 0 / 3     | 1 / 1 / 3           | The tab holding the port told to look again                  |
| [Release](#release)                                                             | 1 / 2 / 2     | 3 / 0 / 2           | The port closed before the lock is let go                    |
| [Remember and restore](#remember-and-restore)                                   | 2 / 1 / 2     | 4 / 1 / 3           | A stored entry kept while any tab still runs it              |
| [Use the device from one tab at a time](#use-the-device-from-one-tab-at-a-time) | 1 / 3 / 2     | 3 / 1 / 2           | A Web Lock around the port                                   |

Each cell reads _calls / options / concepts_.

Every task uses only `setup()`, `subscribe()`, `requestAccess()`, `send()` and `release()`, with one
exception: `restore()` brings back the configurations a page does not set up itself.

## Connect and print received text

```{literalinclude} examples/code/tasks/with-serial-broker.ts
:language: ts
:start-after: // [connect]
:end-before: // [/connect]
```

**Concepts:** a configuration is a name with its options; `onReceive` delivers what the device sent,
collected until the line is quiet, in every tab; a delivery is not a line.

With Web Serial alone:

```{literalinclude} examples/code/tasks/with-web-serial.ts
:language: ts
:start-after: // [connect]
:end-before: // [/connect]
```

**Concepts:** granted ports are matched by their USB IDs; a stream is read through a reader that
locks it; the end of the read loop is a lost connection, and reconnecting is the application's; a
character can be split across chunks; a chunk is not a line.

**Several tabs:** one tab is elected with a Web Lock and opens the port. It forwards every chunk to
the others over a `BroadcastChannel`, and the next tab in the lock's queue opens the port when that
tab goes away. [How shared ports behave](shared-ports.md) is what that takes to get right.

## Send a command and await it

```{literalinclude} examples/code/tasks/with-serial-broker.ts
:language: ts
:start-after: // [send]
:end-before: // [/send]
```

**Concepts:** nothing is appended; the promise resolves once the browser has taken the bytes for the port,
and waits for a connection up to `connection.writeTimeoutMs`; a write that had begun when the tab
holding the port went away rejects with `OWNER_LOST_DURING_WRITE` and is not sent again.

With Web Serial alone:

```{literalinclude} examples/code/tasks/with-web-serial.ts
:language: ts
:start-after: // [send]
:end-before: // [/send]
```

**Concepts:** the port has to be open; one writer at a time, so concurrent writes need a queue; a
write has no deadline, and one that the device never accepts waits forever.

**Several tabs:** every write is sent to the tab holding the port with an identifier, and its result
sent back. When that tab dies during a write, nobody can tell whether the device received it.

Awaiting the device's _answer_ is the same work either way: the answer arrives as chunks, and with
several tabs every tab receives it. [Request and response across tabs](examples/advanced.md#request-and-response-across-tabs)
shows a channel that serialises commands.

## Show the status

```{literalinclude} examples/code/tasks/with-serial-broker.ts
:language: ts
:start-after: // [status]
:end-before: // [/status]
```

**Concepts:** eight statuses, listed in [Interface](api/index.md); the list may grow, so an
unknown value is shown, not thrown on. A new listener is told the current status once, so nothing
has to read it separately.

With Web Serial alone:

```{literalinclude} examples/code/tasks/with-web-serial.ts
:language: ts
:start-after: // [status]
:end-before: // [/status]
```

**Concepts:** there is no status, only what `open()`, the read loop and these events report; the
events report USB devices being plugged in and out, not a device switched off behind its adapter;
reconnecting, with a delay between attempts, is the application's.

**Several tabs:** the tab holding the port sends every change to the others, and a tab that joins
asks for the current one.

## Ask for permission

```{literalinclude} examples/code/tasks/with-serial-broker.ts
:language: ts
:start-after: // [permission]
:end-before: // [/permission]
```

**Concepts:** the browser shows its picker only during a click, so `requestAccess()` comes first in
the handler; the status is `awaiting-permission` while nobody has chosen; any tab can ask, and the tab
holding the port opens the port the user chose.

With Web Serial alone:

```{literalinclude} examples/code/tasks/with-web-serial.ts
:language: ts
:start-after: // [permission]
:end-before: // [/permission]
```

**Concepts:** the same user gesture; a closed picker is a `NotFoundError`; on later visits
`getPorts()` returns the port without asking.

**Several tabs:** a permission belongs to the origin, so every tab's `getPorts()` sees it. The tab
holding the port has to be told to look again.

## Release

```{literalinclude} examples/code/tasks/with-serial-broker.ts
:language: ts
:start-after: // [release]
:end-before: // [/release]
```

**Concepts:** a release is for this tab only, and the other tabs keep the device; it removes this
tab's listeners for the name, so subscribe again after the next `setup()`. It forgets nothing: the
configuration stays remembered and the permission stays granted, so setting it up again needs no
prompt. `forget: true` also removes the remembered configuration, and `forgetDevice: true` also
revokes the browser's permission, for every tab.

In one tab, a name is one configuration, whichever code set it up. Release it when the tab no longer
needs the device, not when one view that shows it closes, if other code of the tab uses the same
name.

With Web Serial alone:

```{literalinclude} examples/code/tasks/with-web-serial.ts
:language: ts
:start-after: // [release]
:end-before: // [/release]
```

**Concepts:** streams have to be unlocked before `close()`; a write still in flight fails.

**Several tabs:** the tab holding the port closes it before it lets go of its lock, or the next
tab's `open()` fails, and hands over the writes it has not begun.

## Remember and restore

```{literalinclude} examples/code/tasks/with-serial-broker.ts
:language: ts
:start-after: // [restore]
:end-before: // [/restore]
```

**Concepts:** the browser keeps the permission and serial-broker keeps the configuration; a device
the user chose in the picker is kept with the remembered configuration, and `setup()` takes it from
there. A page that sets its configurations up on every load needs no `restore()`: `setup()` finds
the granted port, whether the device was named by USB IDs or chosen. `restore()` brings back the
configurations the page does not set up itself, such as those its users defined.

With Web Serial alone:

```{literalinclude} examples/code/tasks/with-web-serial.ts
:language: ts
:start-after: // [restore]
:end-before: // [/restore]
```

**Concepts:** the browser keeps the permission, the application keeps the settings; a port is found
again by its USB IDs, and two identical adapters cannot be told apart.

**Several tabs:** `localStorage` is shared by the origin. A release forgets nothing by itself, and a
tab asked to forget an entry must not remove one another tab still runs.

## Use the device from one tab at a time

```{literalinclude} examples/code/tasks/with-serial-broker.ts
:language: ts
:start-after: // [exclusive]
:end-before: // [/exclusive]
```

**Concepts:** tabs beyond the limit show `queued`, receive nothing and take over in order; every tab
passes the same `maxTabs`.

With Web Serial alone:

```{literalinclude} examples/code/tasks/with-web-serial.ts
:language: ts
:start-after: // [exclusive]
:end-before: // [/exclusive]
```

**Concepts:** a Web Lock queues the tabs, and the browser lets go of it when a tab closes or
crashes; the port is closed before the callback returns.

**Several tabs:** this is the one task Web Serial and a Web Lock do almost as briefly. What they do
not give the waiting tabs is a status to show, or the device's traffic once they may use it.

Neither way lets a waiting tab show the device while it waits. Where every window shows the machine
and one of them operates it, set the configuration up without `maxTabs` and decide who may send with
a Web Lock of the application's, as
[One window operates, every window watches](examples/advanced.md#one-window-operates-every-window-watches)
does.
