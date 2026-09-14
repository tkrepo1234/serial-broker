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

This lock is the application's and has nothing to do with serial-broker's ownership lock: the tab
holding it need not be the tab holding the port. If the device protocol carries a request
identifier, match answers by identifier instead and drop the lock.

The timeout matters more than it seems. When the tab holding the port closes, whatever the device
sends before the next tab has reopened the port is lost — see
[When the tab holding the port goes away](../shared-ports.md#when-the-tab-holding-the-port-goes-away).
An answer lost that way can only be noticed by waiting for it.

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

A binary protocol usually frames its messages. Frames arrive split across chunks, several in one
chunk, or with noise in between, and a parser has to cope with all three:

```{literalinclude} code/advanced/frames.ts
:language: ts
```

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
