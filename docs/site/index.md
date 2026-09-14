# serial-broker

**One serial port, every tab.** serial-broker lets every tab of a web application use the same
serial device through the [Web Serial API][web-serial]: one tab holds the port, every tab reads
from it and writes to it, another tab takes over when that one closes, and the connection comes
back on its own when the device does.

This is the developer documentation. It explains how to use the library, how it behaves when
tabs and devices come and go, and every part of its API.

```ts
import { SerialBroker } from 'serial-broker';

await SerialBroker.setup('CardReader', {
  device: { vendorId: 0x1a86, productId: 0x7523 },
  serial: { baudRate: 9600 },
  encoding: { decodeText: true },
});

SerialBroker.subscribe('CardReader', 'onReceive', (event) => console.log(event.text));
await SerialBroker.send('CardReader', 'STATUS?\r\n');
```

```{toctree}
:maxdepth: 2
:caption: Getting started

introduction
installing
quickstart
```

```{toctree}
:maxdepth: 2
:caption: Using serial-broker

shared-ports
examples/index
configuration
errors
```

```{toctree}
:maxdepth: 2
:caption: Reference

api/index
```

```{toctree}
:maxdepth: 2
:caption: Operating and diagnosing

diagnostics
api/diagnostics
```

```{toctree}
:maxdepth: 2
:caption: Working on serial-broker

internals
performance
```

[web-serial]: https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API
