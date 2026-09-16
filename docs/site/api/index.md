# API reference

Everything an application imports from `serial-broker`, generated from the documentation comments
in the source, so it always matches the version it was built from.

The one page most applications need is the
**[Application API](reference/index/interfaces/SerialBrokerApi.md)** - every method of
`SerialBroker`, each with its parameters, what it returns and what it throws. Jump straight to what
you need:

| Connecting                                                                       | Sending and receiving                                                        | Asking what is going on                                                      | Giving the device up                                                       |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [`setup()`](reference/index/interfaces/SerialBrokerApi.md#setup)                 | [`send()`](reference/index/interfaces/SerialBrokerApi.md#send)               | [`getStatus()`](reference/index/interfaces/SerialBrokerApi.md#getstatus)     | [`release()`](reference/index/interfaces/SerialBrokerApi.md#release)       |
| [`requestAccess()`](reference/index/interfaces/SerialBrokerApi.md#requestaccess) | [`subscribe()`](reference/index/interfaces/SerialBrokerApi.md#subscribe)     | [`exists()`](reference/index/interfaces/SerialBrokerApi.md#exists)           | [`releaseAll()`](reference/index/interfaces/SerialBrokerApi.md#releaseall) |
| [`restore()`](reference/index/interfaces/SerialBrokerApi.md#restore)             | [`unsubscribe()`](reference/index/interfaces/SerialBrokerApi.md#unsubscribe) | [`isSupported()`](reference/index/interfaces/SerialBrokerApi.md#issupported) | [`dispose()`](reference/index/interfaces/SerialBrokerApi.md#dispose)       |

`configure()` comes before all of them; its options are explained with their reasoning in
[Configuration](../configuration.md), and every error code in [Errors](../errors.md).

The read-only view for operators, `serial-broker/diagnostics`, has a
[reference of its own](diagnostics.md). Application code does not need it.

- **[All exports of `serial-broker`](reference/index/index.md)**

```{toctree}
:hidden:
:glob:

reference/index/index
reference/index/*/*
```
