# serial-broker

**One serial port, every tab.** serial-broker lets every tab of a web application use the same
serial device through the [Web Serial API][web-serial]: one tab holds the port, every tab reads from
it and writes to it, another tab takes over when that one goes away, and the connection comes back
when the device does.

This is the developer documentation: how to install and use the library, what it promises when tabs
and devices come and go, every option and error code, and the generated API reference.

```{include} ../../README.md
:start-after: <!-- landing-snippet:start -->
:end-before: <!-- landing-snippet:end -->
```

```{toctree}
:maxdepth: 2
:caption: Getting started

introduction
installing
first-connection
```

```{toctree}
:maxdepth: 2
:caption: Behaviour

guarantees
shared-ports
```

```{toctree}
:maxdepth: 2
:caption: Reference

configuration
errors
api/index
```

```{toctree}
:maxdepth: 2
:caption: Operating and diagnosing

diagnostics
known-limits
api/diagnostics
```

```{toctree}
:maxdepth: 2
:caption: Examples

examples/index
tasks
```

```{toctree}
:maxdepth: 2
:caption: Working on serial-broker

internals
performance
```

[web-serial]: https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API
