# ADR-0016: Support ports that are not USB devices

- **Status:** Superseded by [ADR-0036](./0036-take-the-device-identity-from-the-chosen-port.md) (2026-09-15)
- **Date:** 2026-09-12

**Decision, as first recorded:** Make the device filter a union, adding `{ any: true }` for ports
that report no USB identity.
