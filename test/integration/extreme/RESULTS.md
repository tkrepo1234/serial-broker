# Extreme suite: last run

Written by `npm run test:extreme` (`scripts/test-extreme.mjs`); do not edit by hand. What each
scenario does and what its bounds are is in the scenario files next to this one, and in
docs/guidelines/testing.md, "The extreme suite".

- **Run:** 2026-09-17 21:55:18 UTC, every bound held
- **Machine:** AMD Ryzen 7 7840HS w/ Radeon 780M Graphics, 15 GiB, Windows_NT Windows 11 Home
- **Runtime:** Node v24.21.0, one Vitest worker, `--expose-gc`
- **Scenarios:** 22, 33 s of measured load in total

## Load and cost

Messages are counted at the transport of every tab: sent is what tabs handed to the bus,
delivered is what the bus handed to tabs - each delivery a structured clone in a browser.
Each is shown with its budget, the most the scenario allows for its load.

| Scenario | Transport | Load | Wall | Messages sent (budget) | Messages delivered (budget) |
| --- | --- | --- | ---: | ---: | ---: |
| tabs freezing under load | sharedworker | tabs 10, frozen 5, chunks 5,000, frozenSeconds 50 | 0.2 s | 5,025 (5,100) | 45,105 (51,000) |
| tabs freezing under load | broadcastchannel | tabs 10, frozen 5, chunks 5,000, frozenSeconds 50 | 0.2 s | 5,025 (5,100) | 45,225 (51,000) |
| largest payloads back to back | sharedworker | tabs 4, payloads 12, payloadMiB 16, queuedAtOnce 4 | 1.6 s | 60 (60) | 108 (240) |
| largest payloads back to back | broadcastchannel | tabs 4, payloads 12, payloadMiB 16, queuedAtOnce 4 | 1.5 s | 60 (60) | 180 (240) |
| a long-lived owner accepting writes | sharedworker | tabs 10, writes 50,000, burst 50 | 3.8 s | 230,000 (250,000) | 990,000 (2,500,000) |
| a long-lived owner accepting writes | broadcastchannel | tabs 10, writes 50,000, burst 50 | 5.2 s | 230,000 (250,000) | 2,070,000 (2,500,000) |
| 100 tabs, one configuration | sharedworker | tabs 100, chunks 200, writes 50 | 0.1 s | 446 (450) | 29,748 (45,000) |
| 100 tabs, the holder closed 10 times | sharedworker | tabs 100, closes 10 | 0.1 s | 90 (200) | 6,940 (20,000) |
| 20 configurations x 10 tabs | sharedworker | configurations 20, tabsPerConfiguration 10, chunks 2,000, writes 20 | 0.1 s | 2,092 (2,100) | 18,396 (21,000) |
| 100 tabs, one configuration | broadcastchannel | tabs 100, chunks 200, writes 50 | 0.1 s | 446 (450) | 44,154 (45,000) |
| 100 tabs, the holder closed 10 times | broadcastchannel | tabs 100, closes 10 | 0.1 s | 70 (200) | 6,930 (20,000) |
| 20 configurations x 10 tabs | broadcastchannel | configurations 20, tabsPerConfiguration 10, chunks 2,000, writes 20 | 0.1 s | 2,092 (2,100) | 18,828 (21,000) |
| diagnostics observer under load | sharedworker | tabs 10, watchers 1,000, chunks 2,000, writes 200 | 0.2 s | 3,013 (3,050) | 24,630 (33,550) |
| diagnostics observer under load | broadcastchannel | tabs 10, watchers 1,000, chunks 2,000, writes 200 | 0.2 s | 3,012 (3,050) | 30,120 (33,550) |
| setup and release churn | sharedworker | cycles 1,000, tabs 2 | 0.5 s | 13,000 (16,000) | 8,500 (16,000) |
| setup and release churn | broadcastchannel | cycles 1,000, tabs 2 | 0.4 s | 9,000 (16,000) | 9,000 (16,000) |
| a simulated week | sharedworker | tabs 10, days 7 | 0.0 s | 940 (1,008) | 4,836 (10,080) |
| a simulated week | broadcastchannel | tabs 10, days 7 | 0.0 s | 940 (1,008) | 8,460 (10,080) |
| sustained device traffic | sharedworker | tabs 10, simulatedMinutes 60, baud 115,200, chunks 162,000, megabytes 41.3 | 6.3 s | 162,000 (162,010) | 1,458,000 (1,458,100) |
| sustained device traffic | broadcastchannel | tabs 10, simulatedMinutes 60, baud 115,200, chunks 162,000, megabytes 41.3 | 5.1 s | 162,000 (162,010) | 1,458,000 (1,458,100) |
| writes under owner crashes | sharedworker | writes 10,000, writers 20, writesPerCrash 100 | 2.9 s | 64,800 (80,000) | 730,500 (1,600,000) |
| writes under owner crashes | broadcastchannel | writes 10,000, writers 20, writesPerCrash 100 | 4.5 s | 74,400 (80,000) | 1,414,000 (1,600,000) |

## Footprint before and after the load

Heap and buffers are MiB after a full garbage collection. Every other column is a count, and
must be the same before and after: what the load left behind is the difference.

| Scenario | Transport | Heap | Buffers | Timers | Bus timers | Device listeners | Listeners | Locks held | Locks pending | Pending writes | Queued at port | Worker clients |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tabs freezing under load | sharedworker | 14.79 → 15.26 | 0.13 | 0 | 0 | 20 | 30 | 23 | 38 | 0 | 0 | 10 |
| tabs freezing under load | broadcastchannel | 15.16 → 15.34 | 0.13 | 0 | 0 | 20 | 30 | 13 | 18 | 0 | 0 | 0 |
| largest payloads back to back | sharedworker | 14.37 → 13.41 | 0.13 | 0 | 0 | 8 | 12 | 11 | 14 | 0 | 0 | 4 |
| largest payloads back to back | broadcastchannel | 13.54 → 13.48 | 0.13 | 0 | 0 | 8 | 12 | 7 | 6 | 0 | 0 | 0 |
| a long-lived owner accepting writes | sharedworker | 15.44 → 14.37 | 0.13 | 0 | 0 | 20 | 30 | 23 | 38 | 0 | 0 | 10 |
| a long-lived owner accepting writes | broadcastchannel | 14.37 → 14.35 | 0.13 | 0 | 0 | 20 | 30 | 13 | 18 | 0 | 0 | 0 |
| 100 tabs, one configuration | sharedworker | 18.03 → 18.38 | 0.13 | 0 | 0 | 200 | 300 | 203 | 398 | 0 | 0 | 100 |
| 100 tabs, the holder closed 10 times | sharedworker | 18.47 → 20.76 | 0.13 | 0 | 0 | 200 | 0 | 203 | 398 | 0 | 0 | 100 |
| 20 configurations x 10 tabs | sharedworker | 19.71 → 19.87 | 0.13 | 0 | 0 | 20 | 600 | 251 | 380 | 0 | 0 | 10 |
| 100 tabs, one configuration | broadcastchannel | 18.79 → 18.83 | 0.13 | 0 | 0 | 200 | 300 | 103 | 198 | 0 | 0 | 0 |
| 100 tabs, the holder closed 10 times | broadcastchannel | 18.86 → 20.13 | 0.13 | 0 | 0 | 200 | 0 | 103 | 198 | 0 | 0 | 0 |
| 20 configurations x 10 tabs | broadcastchannel | 20 → 20.02 | 0.13 | 0 | 0 | 20 | 600 | 241 | 360 | 0 | 0 | 0 |
| diagnostics observer under load | sharedworker | 15.06 → 15.72 | 0.13 | 0 | 0 | 20 | 0 | 24 | 40 | 0 | 0 | 11 |
| diagnostics observer under load | broadcastchannel | 15.58 → 15.72 | 0.13 | 0 | 0 | 20 | 0 | 13 | 18 | 0 | 0 | 0 |
| setup and release churn | sharedworker | 14.81 → 16.18 | 0.13 | 0 | 0 | 4 | 0 | 3 | 4 | 0 | 0 | 2 |
| setup and release churn | broadcastchannel | 15.88 → 16.21 | 0.13 | 0 | 0 | 4 | 0 | 1 | 0 | 0 | 0 | 0 |
| a simulated week | sharedworker | 14.75 → 15.22 | 0.13 | 0 | 0 | 20 | 30 | 23 | 38 | 0 | 0 | 10 |
| a simulated week | broadcastchannel | 15.14 → 15.26 | 0.13 | 0 | 0 | 20 | 30 | 13 | 18 | 0 | 0 | 0 |
| sustained device traffic | sharedworker | 14.8 → 15.26 | 0.14 | 0 | 0 | 20 | 20 | 23 | 38 | 0 | 0 | 10 |
| sustained device traffic | broadcastchannel | 15.14 → 15.29 | 0.14 | 0 | 0 | 20 | 20 | 13 | 18 | 0 | 0 | 0 |
| writes under owner crashes | sharedworker | 15.15 → 16.47 | 0.15 | 0 | 0 | 40 | 0 | 43 | 78 | 0 | 0 | 20 |
| writes under owner crashes | broadcastchannel | 15.74 → 16.51 | 0.15 | 0 | 0 | 40 | 0 | 23 | 38 | 0 | 0 | 0 |
