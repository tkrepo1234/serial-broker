# Extreme suite: last run

Written by `npm run test:extreme` (`scripts/test-extreme.mjs`); do not edit by hand. What each
scenario does and what its bounds are is in the scenario files next to this one, and in
docs/guidelines/testing.md, "The extreme suite".

- **Run:** 2026-09-14 21:31:11 UTC, every bound held
- **Machine:** AMD Ryzen 7 7840HS w/ Radeon 780M Graphics, 15 GiB, Windows_NT Windows 11 Home
- **Runtime:** Node v24.21.0, one Vitest worker, `--expose-gc`
- **Scenarios:** 22, 36 s of measured load in total

## Load and cost

Messages are counted at the transport of every tab: sent is what tabs handed to the bus,
delivered is what the bus handed to tabs - each delivery a structured clone in a browser.
Each is shown with its budget, the most the scenario allows for its load.

| Scenario | Transport | Load | Wall | Messages sent (budget) | Messages delivered (budget) |
| --- | --- | --- | ---: | ---: | ---: |
| tabs freezing under load | sharedworker | tabs 10, frozen 5, chunks 5,000, frozenSeconds 50 | 0.2 s | 5,020 (5,100) | 45,060 (51,000) |
| tabs freezing under load | broadcastchannel | tabs 10, frozen 5, chunks 5,000, frozenSeconds 50 | 0.2 s | 5,020 (5,100) | 45,180 (51,000) |
| largest payloads back to back | sharedworker | tabs 4, payloads 12, payloadMiB 16, queuedAtOnce 4 | 1.5 s | 48 (60) | 72 (240) |
| largest payloads back to back | broadcastchannel | tabs 4, payloads 12, payloadMiB 16, queuedAtOnce 4 | 1.5 s | 48 (60) | 144 (240) |
| a long-lived owner accepting writes | sharedworker | tabs 10, writes 50,000, burst 50 | 2.7 s | 185,000 (250,000) | 585,000 (2,500,000) |
| a long-lived owner accepting writes | broadcastchannel | tabs 10, writes 50,000, burst 50 | 4.3 s | 185,000 (250,000) | 1,665,000 (2,500,000) |
| 100 tabs, one configuration | sharedworker | tabs 100, chunks 200, writes 50 | 0.1 s | 397 (450) | 24,897 (45,000) |
| 100 tabs, the holder closed 10 times | sharedworker | tabs 100, closes 10 | 0.1 s | 110 (200) | 5,930 (20,000) |
| 20 configurations x 10 tabs | sharedworker | configurations 20, tabsPerConfiguration 10, chunks 2,000, writes 20 | 0.1 s | 2,074 (2,100) | 18,234 (21,000) |
| 100 tabs, one configuration | broadcastchannel | tabs 100, chunks 200, writes 50 | 0.1 s | 397 (450) | 39,303 (45,000) |
| 100 tabs, the holder closed 10 times | broadcastchannel | tabs 100, closes 10 | 0.1 s | 110 (200) | 10,880 (20,000) |
| 20 configurations x 10 tabs | broadcastchannel | configurations 20, tabsPerConfiguration 10, chunks 2,000, writes 20 | 0.1 s | 2,074 (2,100) | 18,666 (21,000) |
| diagnostics observer under load | sharedworker | tabs 10, watchers 1,000, chunks 2,000, writes 200 | 0.2 s | 2,813 (3,050) | 22,629 (33,550) |
| diagnostics observer under load | broadcastchannel | tabs 10, watchers 1,000, chunks 2,000, writes 200 | 0.2 s | 2,813 (3,050) | 28,130 (33,550) |
| setup and release churn | sharedworker | cycles 1,000, tabs 2 | 0.5 s | 13,000 (16,000) | 3,500 (16,000) |
| setup and release churn | broadcastchannel | cycles 1,000, tabs 2 | 0.5 s | 13,000 (16,000) | 13,000 (16,000) |
| a simulated week | sharedworker | tabs 10, days 7, heartbeatsPerTab 40,320 | 7.6 s | 403,989 (404,208) | 406,677 (413,280) |
| a simulated week | broadcastchannel | tabs 10, days 7, heartbeatsPerTab 40,320 | 0.2 s | 789 (404,208) | 7,101 (413,280) |
| sustained device traffic | sharedworker | tabs 10, simulatedMinutes 60, baud 115,200, chunks 162,000, megabytes 41.3 | 5.5 s | 162,000 (162,010) | 1,458,000 (1,458,100) |
| sustained device traffic | broadcastchannel | tabs 10, simulatedMinutes 60, baud 115,200, chunks 162,000, megabytes 41.3 | 4.5 s | 162,000 (162,010) | 1,458,000 (1,458,100) |
| writes under owner crashes | sharedworker | writes 10,000, writers 20, writesPerCrash 100 | 1.4 s | 56,080 (80,000) | 233,880 (1,600,000) |
| writes under owner crashes | broadcastchannel | writes 10,000, writers 20, writesPerCrash 100 | 4.4 s | 65,500 (80,000) | 1,244,900 (1,600,000) |

## Footprint before and after the load

Heap and buffers are MiB after a full garbage collection. Every other column is a count, and
must be the same before and after: what the load left behind is the difference.

| Scenario | Transport | Heap | Buffers | Timers | Bus timers | Device listeners | Listeners | Locks held | Locks pending | Pending writes | Queued at port | Worker clients |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tabs freezing under load | sharedworker | 14.48 → 14.9 | 0.13 | 0 | 11 | 20 | 30 | 12 | 18 | 0 | 0 | 10 |
| tabs freezing under load | broadcastchannel | 14.9 → 15.08 | 0.13 | 0 | 1 | 20 | 30 | 12 | 18 | 0 | 0 | 0 |
| largest payloads back to back | sharedworker | 14.11 → 13.16 | 0.13 | 0 | 5 | 8 | 12 | 6 | 6 | 0 | 0 | 4 |
| largest payloads back to back | broadcastchannel | 13.32 → 13.25 | 0.13 | 0 | 1 | 8 | 12 | 6 | 6 | 0 | 0 | 0 |
| a long-lived owner accepting writes | sharedworker | 15.11 → 14.04 | 0.13 | 0 | 11 | 20 | 30 | 12 | 18 | 0 | 0 | 10 |
| a long-lived owner accepting writes | broadcastchannel | 14.1 → 14.08 | 0.13 | 0 | 1 | 20 | 30 | 12 | 18 | 0 | 0 | 0 |
| 100 tabs, one configuration | sharedworker | 16.71 → 17.02 | 0.13 | 0 | 101 | 200 | 300 | 102 | 198 | 0 | 0 | 100 |
| 100 tabs, the holder closed 10 times | sharedworker | 17.06 → 19.25 | 0.13 | 0 | 101 | 200 | 0 | 102 | 198 | 0 | 0 | 100 |
| 20 configurations x 10 tabs | sharedworker | 18.79 → 18.97 | 0.13 | 0 | 11 | 20 | 600 | 240 | 360 | 0 | 0 | 10 |
| 100 tabs, one configuration | broadcastchannel | 18.17 → 18.22 | 0.13 | 0 | 1 | 200 | 300 | 102 | 198 | 0 | 0 | 0 |
| 100 tabs, the holder closed 10 times | broadcastchannel | 18.27 → 19.54 | 0.13 | 0 | 1 | 200 | 0 | 102 | 198 | 0 | 0 | 0 |
| 20 configurations x 10 tabs | broadcastchannel | 19.21 → 19.27 | 0.13 | 0 | 1 | 20 | 600 | 240 | 360 | 0 | 0 | 0 |
| diagnostics observer under load | sharedworker | 14.74 → 15.39 | 0.13 | 0 | 12 | 20 | 0 | 12 | 18 | 0 | 0 | 11 |
| diagnostics observer under load | broadcastchannel | 15.33 → 15.49 | 0.13 | 0 | 1 | 20 | 0 | 12 | 18 | 0 | 0 | 0 |
| setup and release churn | sharedworker | 14.43 → 15.77 | 0.13 | 0 | 3 | 4 | 0 | 0 | 0 | 0 | 0 | 2 |
| setup and release churn | broadcastchannel | 15.52 → 15.88 | 0.13 | 0 | 1 | 4 | 0 | 0 | 0 | 0 | 0 | 0 |
| a simulated week | sharedworker | 14.44 → 13.84 | 0.13 | 0 | 11 | 20 | 30 | 12 | 18 | 0 | 0 | 10 |
| a simulated week | broadcastchannel | 13.8 → 13.94 | 0.13 | 0 | 1 | 20 | 30 | 12 | 18 | 0 | 0 | 0 |
| sustained device traffic | sharedworker | 14.48 → 14.9 | 0.14 | 0 | 11 | 20 | 20 | 12 | 18 | 0 | 0 | 10 |
| sustained device traffic | broadcastchannel | 14.88 → 15.02 | 0.14 | 0 | 1 | 20 | 20 | 12 | 18 | 0 | 0 | 0 |
| writes under owner crashes | sharedworker | 14.73 → 17 | 0.15 | 0 | 21 | 40 | 0 | 22 | 38 | 0 | 0 | 20 |
| writes under owner crashes | broadcastchannel | 16.52 → 16.16 | 0.15 | 0 | 1 | 40 | 0 | 22 | 38 | 0 | 0 | 0 |
