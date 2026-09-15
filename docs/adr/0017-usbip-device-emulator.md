# ADR-0017: Emulate a USB serial device over USB/IP for testing without hardware

- **Status:** Superseded by [ADR-0035](./0035-browser-tests-with-playwright.md) (2026-09-15)
- **Date:** 2026-09-13

**Decision, as first recorded:** Ship a USB/IP server in `emulator/` that exports an emulated USB
CDC ACM device, so the real serial stack can be tested without hardware under usbip-win2.

**Trail:** First run against usbip-win2 0.9.8.0 on 2026-09-15; folded into ADR-0035 as one of its
test layers on 2026-09-15.
