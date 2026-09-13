# API reference

Everything an application imports from `serial-broker`, generated from the documentation comments
in the source, so it always matches the version it was built from.

Start with **[`SerialBrokerApi`](reference/index/interfaces/SerialBrokerApi.md)**: every method of
`SerialBroker`, with its parameters, what it returns, and what it throws. The options it takes are
explained with their reasoning in [Configuration](../configuration.md), and every error code in
[Errors](../errors.md).

The read-only view for operators, `serial-broker/diagnostics`, has a
[reference of its own](diagnostics.md). Application code does not need it.

- **[All exports of `serial-broker`](reference/index/index.md)**

```{toctree}
:hidden:
:glob:

reference/index/index
reference/index/*/*
```
