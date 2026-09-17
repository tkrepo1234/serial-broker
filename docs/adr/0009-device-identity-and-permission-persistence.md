# ADR-0009: Identify devices by USB IDs, persist configuration, rely on browser permission

- **Status:** Superseded by [ADR-0036](./0036-take-the-device-identity-from-the-chosen-port.md) (2026-09-15)
- **Date:** 2026-09-12

**Decision, as first recorded:** Match granted ports by USB vendor and product ID, remember
configurations in `localStorage`, and leave the permission to the browser: `awaiting-permission`,
then `requestAccess()` from a gesture.
