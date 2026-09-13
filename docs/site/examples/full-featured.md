# Full-featured

A panel for a scale that can be open in any number of windows at once. Each window shows the
connection, lets the user send commands, logs every line the scale sends and every command any
window sent, and can disconnect without affecting the others. The baud rate can be changed in
any window, and every window follows.

## The page

```{literalinclude} code/full-featured/index.html
:language: html
```

## The panel

```{literalinclude} code/full-featured/scale-panel.ts
:language: ts
```

## Starting it

```{literalinclude} code/full-featured/main.ts
:language: ts
```

## How it fits together

**Every window runs the same code.** Each sets the configuration up and subscribes to it.
serial-broker picks the window that holds the port and moves the port when that window closes.
The panel never asks which window it is.

**Traffic from every window appears in every window.** `onReceive` delivers each chunk everywhere,
and `onSend` reports every command that reached the scale, with `origin` telling this window's
commands from the others'.

**Line settings are the application's to keep consistent.** The window that holds the port opens
it with its own settings, and serial-broker does not compare settings between windows. The panel
keeps the baud rate in `localStorage` and listens for the `storage` event, which fires in every
other window when one of them changes it. Each window then releases the configuration and sets it
up again with the new rate; the window that made the change does so directly, since the event never
reaches the window that wrote the value. Reconnects run one after another, so a quick series of
changes cannot leave a window subscribed twice, and a window the user disconnected stays
disconnected.

**Errors are shown with the sentence that says what to do.** Every `SerialBrokerError` carries a
`remediation`. The panel shows it as it is, except for `OWNER_LOST_DURING_WRITE`, where the scale
may or may not have received the command and the user has to check.

**Failures serial-broker is recovering from are not shown as problems.** An unplugged scale
produces an error with `isRetryable: true`; the status line already says _Reconnecting…_, which is
all the user needs to know.

**Disconnecting one window leaves the others working.** `release()` affects only the window that
calls it. If that window held the port, another window takes it over.
