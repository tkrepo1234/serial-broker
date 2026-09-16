# API reference

Everything an application imports from `serial-broker`, generated from the documentation comments
in the source, so it always matches the version it was built from.

The one page most applications need is the
**[Application API](reference/index/interfaces/SerialBrokerApi.md)**: `setup()`, `subscribe()`,
`send()`, `requestAccess()`, `release()` and the rest of `SerialBroker`, each with its parameters,
what it returns and what it throws. It stands in the navigation beside this page. The options it
takes are explained with their reasoning in [Configuration](../configuration.md), and every error
code in [Errors](../errors.md).

The read-only view for operators, `serial-broker/diagnostics`, has a
[reference of its own](diagnostics.md). Application code does not need it.

- **[All exports of `serial-broker`](reference/index/index.md)**

```{toctree}
:hidden:
:glob:

reference/index/index
reference/index/*/*
```
