# ADR-0009: Identify devices by USB IDs, persist configuration, rely on browser permission

- **Status:** Superseded by [ADR-0036](./0036-take-the-device-identity-from-the-chosen-port.md) (2026-09-15)
- **Date:** 2026-09-12

**Decision, as first recorded:** Match granted ports by USB vendor and product ID, remember
configurations in `localStorage`, and leave the permission to the browser: `awaiting-permission`,
then `requestAccess()` from a gesture.

**Trail:** Amended by ADR-0016, 0022, 0027, 0033 and 0036; device identity and permission folded
into ADR-0036, remembered configurations into
[ADR-0033](./0033-one-storage-key-per-configuration.md), on 2026-09-15.
