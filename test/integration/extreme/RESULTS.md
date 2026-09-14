# Extreme suite: last run

Written by `npm run test:extreme` (`scripts/test-extreme.mjs`); do not edit by hand. What each
scenario does and what its bounds are is in the scenario files next to this one, and in
docs/guidelines/testing.md, "The extreme suite".

- **Run:** 2026-09-14 21:22:50 UTC, every bound held
- **Machine:** AMD Ryzen 7 7840HS w/ Radeon 780M Graphics, 15 GiB, Windows_NT Windows 11 Home
- **Runtime:** Node v24.21.0, one Vitest worker, `--expose-gc`
- **Scenarios:** 22, 34 s of measured load in total

## Load and cost

Messages are counted at the transport of every tab: sent is what tabs handed to the bus,
delivered is what the bus handed to tabs - each delivery a structured clone in a browser.
Each is shown with its budget, the most the scenario allows for its load.

| Scenario | Transport | Load | Wall | Messages sent (budget) | Messages delivered (budget) |
| --- | --- | --- | ---: | ---: | ---: |
| tabs freezing under load | sharedworker | tabs 10, frozen 5, chunks 5,000, frozenSeconds 50 | 0.2 s | 5,020 (5,100) | 45,060 (51,000) |
| tabs freezing under load | broadcastchannel | tabs 10, frozen 5, chunks 5,000, frozenSeconds 50 | 0.2 s | 5,020 (5,100) | 45,180 (51,000) |
| largest payloads back to back | sharedworker | tabs 4, payloads 12, payloadMiB 16, queuedAtOnce 4 | 1.4 s | 48 (60) | 72 (240) |
| largest payloads back to back | broadcastchannel | tabs 4, payloads 12, payloadMiB 16, queuedAtOnce 4 | 1.4 s | 48 (60) | 144 (240) |
| a long-lived owner accepting writes | sharedworker | tabs 10, writes 50,000, burst 50 | 2.7 s | 185,000 (250,000) | 585,000 (2,500,000) |
| a long-lived owner accepting writes | broadcastchannel | tabs 10, writes 50,000, burst 50 | 4.8 s | 185,000 (250,000) | 1,665,000 (2,500,000) |
| 100 tabs, one configuration | sharedworker | tabs 100, chunks 200, writes 50 | 0.1 s | 397 (450) | 24,897 (45,000) |
| 100 tabs, the holder closed 10 times | sharedworker | tabs 100, closes 10 | 0.1 s | 110 (200) | 5,930 (20,000) |
| 20 configurations x 10 tabs | sharedworker | configurations 20, tabsPerConfiguration 10, chunks 2,000, writes 20 | 0.1 s | 2,074 (2,100) | 18,234 (21,000) |
| 100 tabs, one configuration | broadcastchannel | tabs 100, chunks 200, writes 50 | 0.1 s | 397 (450) | 39,303 (45,000) |
| 100 tabs, the holder closed 10 times | broadcastchannel | tabs 100, closes 10 | 0.1 s | 110 (200) | 10,880 (20,000) |
| 20 configurations x 10 tabs | broadcastchannel | configurations 20, tabsPerConfiguration 10, chunks 2,000, writes 20 | 0.1 s | 2,074 (2,100) | 18,666 (21,000) |
| diagnostics observer under load | sharedworker | tabs 10, watchers 1,000, chunks 2,000, writes 200 | 0.2 s | 2,813 (3,050) | 22,629 (33,550) |
| diagnostics observer under load | broadcastchannel | tabs 10, watchers 1,000, chunks 2,000, writes 200 | 0.2 s | 2,813 (3,050) | 28,130 (33,550) |
| setup and release churn | sharedworker | cycles 1,000, tabs 2 | 0.5 s | 13,000 (16,000) | 3,500 (16,000) |
| setup and release churn | broadcastchannel | cycles 1,000, tabs 2 | 0.4 s | 13,000 (16,000) | 13,000 (16,000) |
| a simulated week | sharedworker | tabs 10, days 7, heartbeatsPerTab 40,320 | 5.4 s | 403,989 (404,208) | 406,677 (413,280) |
| a simulated week | broadcastchannel | tabs 10, days 7, heartbeatsPerTab 40,320 | 0.2 s | 789 (404,208) | 7,101 (413,280) |
| sustained device traffic | sharedworker | tabs 10, simulatedMinutes 60, baud 115,200, chunks 162,000, megabytes 41.3 | 5.3 s | 162,000 (162,010) | 1,458,000 (1,458,100) |
| sustained device traffic | broadcastchannel | tabs 10, simulatedMinutes 60, baud 115,200, chunks 162,000, megabytes 41.3 | 4.6 s | 162,000 (162,010) | 1,458,000 (1,458,100) |
| writes under owner crashes | sharedworker | writes 10,000, writers 20, writesPerCrash 100 | 1.5 s | 56,080 (80,000) | 233,880 (1,600,000) |
| writes under owner crashes | broadcastchannel | writes 10,000, writers 20, writesPerCrash 100 | 4.5 s | 65,500 (80,000) | 1,244,900 (1,600,000) |

## Footprint before and after the load

Heap and buffers are MiB after a full garbage collection. Every other column is a count, and
must be the same before and after: what the load left behind is the difference.

| Scenario | Transport | Heap | Buffers | Timers | Bus timers | Device listeners | Listeners | Locks held | Locks pending | Pending writes | Queued at port | Worker clients |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tabs freezing under load | sharedworker | 14.37 → 14.8 | 0.13 | 0 | 11 | 20 | 30 | 12 | 18 | 0 | 0 | 10 |
| tabs freezing under load | broadcastchannel | 14.79 → 14.97 | 0.13 | 0 | 1 | 20 | 30 | 12 | 18 | 0 | 0 | 0 |
| largest payloads back to back | sharedworker | 14.02 → 13.07 | 0.13 | 0 | 5 | 8 | 12 | 6 | 6 | 0 | 0 | 4 |
| largest payloads back to back | broadcastchannel | 13.23 → 13.15 | 0.13 | 0 | 1 | 8 | 12 | 6 | 6 | 0 | 0 | 0 |
| a long-lived owner accepting writes | sharedworker | 15.01 → 13.94 | 0.13 | 0 | 11 | 20 | 30 | 12 | 18 | 0 | 0 | 10 |
| a long-lived owner accepting writes | broadcastchannel | 14.03 → 14.01 | 0.13 | 0 | 1 | 20 | 30 | 12 | 18 | 0 | 0 | 0 |
| 100 tabs, one configuration | sharedworker | 16.58 → 16.9 | 0.13 | 0 | 101 | 200 | 300 | 102 | 198 | 0 | 0 | 100 |
| 100 tabs, the holder closed 10 times | sharedworker | 16.93 → 19.11 | 0.13 | 0 | 101 | 200 | 0 | 102 | 198 | 0 | 0 | 100 |
| 20 configurations x 10 tabs | sharedworker | 18.6 → 18.76 | 0.13 | 0 | 11 | 20 | 600 | 240 | 360 | 0 | 0 | 10 |
| 100 tabs, one configuration | broadcastchannel | 18.02 → 18.07 | 0.13 | 0 | 1 | 200 | 300 | 102 | 198 | 0 | 0 | 0 |
| 100 tabs, the holder closed 10 times | broadcastchannel | 18.12 → 19.4 | 0.13 | 0 | 1 | 200 | 0 | 102 | 198 | 0 | 0 | 0 |
| 20 configurations x 10 tabs | broadcastchannel | 19 → 19.03 | 0.13 | 0 | 1 | 20 | 600 | 240 | 360 | 0 | 0 | 0 |
| diagnostics observer under load | sharedworker | 14.64 → 15.29 | 0.13 | 0 | 12 | 20 | 0 | 12 | 18 | 0 | 0 | 11 |
| diagnostics observer under load | broadcastchannel | 15.23 → 15.38 | 0.13 | 0 | 1 | 20 | 0 | 12 | 18 | 0 | 0 | 0 |
| setup and release churn | sharedworker | 14.36 → 15.68 | 0.13 | 0 | 3 | 4 | 0 | 0 | 0 | 0 | 0 | 2 |
| setup and release churn | broadcastchannel | 15.43 → 15.78 | 0.13 | 0 | 1 | 4 | 0 | 0 | 0 | 0 | 0 | 0 |
| a simulated week | sharedworker | 14.34 → 13.74 | 0.13 | 0 | 11 | 20 | 30 | 12 | 18 | 0 | 0 | 10 |
| a simulated week | broadcastchannel | 13.69 → 13.85 | 0.13 | 0 | 1 | 20 | 30 | 12 | 18 | 0 | 0 | 0 |
| sustained device traffic | sharedworker | 14.38 → 14.82 | 0.14 | 0 | 11 | 20 | 20 | 12 | 18 | 0 | 0 | 10 |
| sustained device traffic | broadcastchannel | 14.79 → 14.92 | 0.14 | 0 | 1 | 20 | 20 | 12 | 18 | 0 | 0 | 0 |
| writes under owner crashes | sharedworker | 14.63 → 16.9 | 0.15 | 0 | 21 | 40 | 0 | 22 | 38 | 0 | 0 | 20 |
| writes under owner crashes | broadcastchannel | 16.42 → 16.12 | 0.15 | 0 | 1 | 40 | 0 | 22 | 38 | 0 | 0 | 0 |
