# Advanced

The cases a real device protocol runs into once several tabs share it.

## Request and response across tabs

Many devices answer each command with one line. With one tab, "the next line is the answer" is
enough. With several, it is not: every tab receives every line, including the answers to the other
tabs' commands, and a simple line protocol carries nothing to match an answer to its question.

The channel below serialises commands across all tabs with a Web Lock of its own, so only the tab
holding that lock is waiting for an answer at any moment:

```{literalinclude} code/advanced/line-channel.ts
:language: ts
```

It splits lines with `onLines` from [Reading lines](all-features.md#reading-lines), which keeps at
most one line's worth of unfinished text and drops it whenever the status leaves `open`.

This lock is the application's and has nothing to do with serial-broker's ownership lock: the tab
holding it need not be the tab holding the port. If the device protocol carries a request
identifier, match answers by identifier instead and drop the lock.

**Which line is the answer.** A device that also sends lines by itself — a scale streaming its
weight, a controller reporting events — needs `isAnswer`, or the next of those lines is taken for
the answer:

```ts
const result = await channel.request('T', { isAnswer: (line) => line === 'OK' || line === 'ERR' });
```

**When the wait starts.** The timeout counts from the moment `send()` has resolved, which is when the
browser has taken the command for the port. Before that, `send()` can wait for a connection for up
to `connection.writeTimeoutMs`; a timeout started earlier could end while the command is still on
its way, and report no answer for a command the device then carries out.

**Why the lock is kept after a timeout.** Let go at once, the lock goes to the next request, from
this tab or another, and an answer to the timed-out command that arrives a moment later is taken as
the answer to that request. Keeping the lock for `lateAnswerGraceMs` more lets such an answer arrive
while no request is waiting. A device that answers later than the timeout and the grace together can
still be mistaken; only an identifier in the protocol rules that out.

The timeout matters more than it seems. When the tab holding the port closes, whatever the device
sends before the next tab has reopened the port is lost — see [Failover](../guarantees.md#failover).
An answer lost that way can only be noticed by waiting for it. A `NoAnswerError` does not say whether
the command reached the device: treat the command as one that may have run.

## Commands that must not run twice

`OWNER_LOST_DURING_WRITE` means a write had begun when the tab holding the port went away, and
nothing can tell whether the device received it. serial-broker does not resend it. What to do
depends on the command:

```{literalinclude} code/advanced/safe-commands.ts
:language: ts
```

- **Idempotent commands** — reading a value, setting an absolute position — can simply be sent
  again.
- **Commands with an observable effect** — a counter, a status register — can be checked before
  deciding. `dispenseOnce` compares the dispenser's counter.
- **Everything else** is undecided, and should be reported as such rather than guessed at.

A write that had not begun when the tab went away never reached the device. serial-broker sends
those again by itself, exactly once.

## Binary frames

A binary protocol usually frames its messages. Frames arrive split across deliveries, several in one
delivery, or with noise in between, and a frame start may never be followed by its end. A parser
has to cope with all of it:

```{literalinclude} code/advanced/frames.ts
:language: ts
```

The parser copies each delivery into a buffer the size of the longest frame. A delivery of up to
64 KiB is neither spread into a function call nor copied again for every frame taken out of it, and
a frame start with no end within that size is discarded and reported instead of growing the buffer.
An unfinished frame is also dropped when the status leaves `open`: what the device sent in the gap
is lost, and the halves from either side would make a frame the device never sent. A tab that has
just joined starts mid-stream as well; the checksum catches most false frame starts there.

Send each frame with one `send()`. The bytes of one call are never interleaved with another tab's
write; the bytes of separate calls can be.

Every tab receives the same bytes, so every tab that parses them sees the same frames. Checksums,
escaping and retransmission belong in this layer; serial-broker delivers bytes and nothing more.

## Several devices

```{literalinclude} code/advanced/several-devices.ts
:language: ts
```

Configurations are independent of each other. Each has its own ownership lock and connection, so
the scale may be held by one tab and the printer by another, and either may reconnect without
affecting the other. The weight read from the scale in one tab can be printed by whichever tab
holds the printer.

Give every configuration a device of its own. serial-broker does not keep configurations apart: a
`{ any: true }` configuration next to this printer matches the printer's port as well, and whichever
of the two opens it first leaves the other unable to.

## One window operates, every window watches

An operator station often shows a machine in several windows — the main screen, a second monitor, a
supervisor's tab — while only one of them may send commands. `maxTabs: 1` does not do this: a window
beyond the limit is `queued` and receives nothing, so it cannot show the machine at all.

Instead, every window sets the configuration up **without** `maxTabs`, so every window receives the
machine's data and status, and a Web Lock of the application's decides which window may send:

```{literalinclude} code/advanced/operator-station.ts
:language: ts
```

**The rule.** A window is in control from the moment its lock callback starts until it gives control
up, or until another window takes the lock with `steal: true`. `giveUp()` marks the window as no
longer in control before it lets go of the lock, so two windows never both believe they are. `steal`
is the exception, and the example does not use it: the browser grants the new window at once and
rejects the old window's request with an `AbortError`, so the old window learns of it only
afterwards. Decide when sending, not when showing the form.

**Close, reload, crash.** The browser lets go of a window's locks when its page goes away, however it
goes: closed, reloaded, navigated away, crashed, or discarded to save memory. No timer is involved.
The window that has waited longest with `request(true)` is granted control at once; with none
waiting, the next window to ask gets it.

**A window that stops running** — paused in a debugger, blocked by a long task, frozen — keeps
control until it runs again or goes away, as the tab holding the port keeps the port. Chromium does
not freeze a tab holding a Web Lock that another tab is waiting for; see
[Frozen tabs](../shared-ports.md#frozen-tabs).

**What control does not cover.** A command sent while in control can still be on its way when control
has moved. Control says nothing about which tab holds the port, and does not need to. And like the
port, control is shared by the windows of one origin in one browser profile on one computer.
