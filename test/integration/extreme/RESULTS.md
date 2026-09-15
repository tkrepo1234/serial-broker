# Extreme suite: last run

Written by `npm run test:extreme` (`scripts/test-extreme.mjs`); do not edit by hand. What each
scenario does and what its bounds are is in the scenario files next to this one, and in
docs/guidelines/testing.md, "The extreme suite".

- **Run:** 2026-09-15 06:14:39 UTC, every bound held
- **Machine:** AMD Ryzen 7 7840HS w/ Radeon 780M Graphics, 15 GiB, Windows_NT Windows 11 Home
- **Runtime:** Node v24.21.0, one Vitest worker, `--expose-gc`
- **Scenarios:** 22, 40 s of measured load in total

## Load and cost

Messages are counted at the transport of every tab: sent is what tabs handed to the bus,
delivered is what the bus handed to tabs - each delivery a structured clone in a browser.
Each is shown with its budget, the most the scenario allows for its load.

| Scenario | Transport | Load | Wall | Messages sent (budget) | Messages delivered (budget) |
| --- | --- | --- | ---: | ---: | ---: |
| tabs freezing under load | sharedworker | tabs 10, frozen 5, chunks 5,000, frozenSeconds 50 | 0.2 s | 5,020 (5,100) | 45,100 (51,000) |
| tabs freezing under load | broadcastchannel | tabs 10, frozen 5, chunks 5,000, frozenSeconds 50 | 0.2 s | 5,020 (5,100) | 45,180 (51,000) |
| largest payloads back to back | sharedworker | tabs 4, payloads 12, payloadMiB 16, queuedAtOnce 4 | 1.7 s | 48 (60) | 96 (240) |
| largest payloads back to back | broadcastchannel | tabs 4, payloads 12, payloadMiB 16, queuedAtOnce 4 | 1.2 s | 48 (60) | 144 (240) |
| a long-lived owner accepting writes | sharedworker | tabs 10, writes 50,000, burst 50 | 3.6 s | 185,000 (250,000) | 945,000 (2,500,000) |
| a long-lived owner accepting writes | broadcastchannel | tabs 10, writes 50,000, burst 50 | 7.8 s | 185,000 (250,000) | 1,665,000 (2,500,000) |
| 100 tabs, one configuration | sharedworker | tabs 100, chunks 200, writes 50 | 0.1 s | 397 (450) | 29,699 (45,000) |
| 100 tabs, the holder closed 10 times | sharedworker | tabs 100, closes 10 | 0.1 s | 90 (200) | 6,940 (20,000) |
| 20 configurations x 10 tabs | sharedworker | configurations 20, tabsPerConfiguration 10, chunks 2,000, writes 20 | 0.1 s | 2,074 (2,100) | 18,378 (21,000) |
| 100 tabs, one configuration | broadcastchannel | tabs 100, chunks 200, writes 50 | 0.1 s | 397 (450) | 39,303 (45,000) |
| 100 tabs, the holder closed 10 times | broadcastchannel | tabs 100, closes 10 | 0.0 s | 70 (200) | 6,930 (20,000) |
| 20 configurations x 10 tabs | broadcastchannel | configurations 20, tabsPerConfiguration 10, chunks 2,000, writes 20 | 0.1 s | 2,074 (2,100) | 18,666 (21,000) |
| diagnostics observer under load | sharedworker | tabs 10, watchers 1,000, chunks 2,000, writes 200 | 0.2 s | 2,813 (3,050) | 24,430 (33,550) |
| diagnostics observer under load | broadcastchannel | tabs 10, watchers 1,000, chunks 2,000, writes 200 | 0.1 s | 2,812 (3,050) | 28,120 (33,550) |
| setup and release churn | sharedworker | cycles 1,000, tabs 2 | 0.4 s | 13,000 (16,000) | 8,500 (16,000) |
| setup and release churn | broadcastchannel | cycles 1,000, tabs 2 | 0.3 s | 9,000 (16,000) | 9,000 (16,000) |
| a simulated week | sharedworker | tabs 10, days 7 | 0.0 s | 789 (1,008) | 4,685 (10,080) |
| a simulated week | broadcastchannel | tabs 10, days 7 | 0.0 s | 789 (1,008) | 7,101 (10,080) |
| sustained device traffic | sharedworker | tabs 10, simulatedMinutes 60, baud 115,200, chunks 162,000, megabytes 41.3 | 6.0 s | 162,000 (162,010) | 1,458,000 (1,458,100) |
| sustained device traffic | broadcastchannel | tabs 10, simulatedMinutes 60, baud 115,200, chunks 162,000, megabytes 41.3 | 7.8 s | 162,000 (162,010) | 1,458,000 (1,458,100) |
| writes under owner crashes | sharedworker | writes 10,000, writers 20, writesPerCrash 100 | 2.5 s | 55,700 (80,000) | 721,400 (1,600,000) |
| writes under owner crashes | broadcastchannel | writes 10,000, writers 20, writesPerCrash 100 | 7.6 s | 65,300 (80,000) | 1,241,100 (1,600,000) |

## Footprint before and after the load

Heap and buffers are MiB after a full garbage collection. Every other column is a count, and
must be the same before and after: what the load left behind is the difference.

| Scenario | Transport | Heap | Buffers | Timers | Bus timers | Device listeners | Listeners | Locks held | Locks pending | Pending writes | Queued at port | Worker clients |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tabs freezing under load | sharedworker | 14.39 → 14.84 | 0.13 | 0 | 0 | 20 | 30 | 23 | 38 | 0 | 0 | 10 |
| tabs freezing under load | broadcastchannel | 14.75 → 14.92 | 0.13 | 0 | 0 | 20 | 30 | 13 | 18 | 0 | 0 | 0 |
| largest payloads back to back | sharedworker | 13.98 → 13.02 | 0.13 | 0 | 0 | 8 | 12 | 11 | 14 | 0 | 0 | 4 |
| largest payloads back to back | broadcastchannel | 13.15 → 13.07 | 0.13 | 0 | 0 | 8 | 12 | 7 | 6 | 0 | 0 | 0 |
| a long-lived owner accepting writes | sharedworker | 15.03 → 13.98 | 0.13 | 0 | 0 | 20 | 30 | 23 | 38 | 0 | 0 | 10 |
| a long-lived owner accepting writes | broadcastchannel | 13.97 → 13.93 | 0.13 | 0 | 0 | 20 | 30 | 13 | 18 | 0 | 0 | 0 |
| 100 tabs, one configuration | sharedworker | 17.66 → 18 | 0.13 | 0 | 0 | 200 | 300 | 203 | 398 | 0 | 0 | 100 |
| 100 tabs, the holder closed 10 times | sharedworker | 18.07 → 20.26 | 0.13 | 0 | 0 | 200 | 0 | 203 | 398 | 0 | 0 | 100 |
| 20 configurations x 10 tabs | sharedworker | 19.19 → 19.35 | 0.13 | 0 | 0 | 20 | 600 | 251 | 380 | 0 | 0 | 10 |
| 100 tabs, one configuration | broadcastchannel | 18.27 → 18.3 | 0.13 | 0 | 0 | 200 | 300 | 103 | 198 | 0 | 0 | 0 |
| 100 tabs, the holder closed 10 times | broadcastchannel | 18.33 → 19.61 | 0.13 | 0 | 0 | 200 | 0 | 103 | 198 | 0 | 0 | 0 |
| 20 configurations x 10 tabs | broadcastchannel | 19.49 → 19.51 | 0.13 | 0 | 0 | 20 | 600 | 241 | 360 | 0 | 0 | 0 |
| diagnostics observer under load | sharedworker | 14.66 → 15.33 | 0.13 | 0 | 0 | 20 | 0 | 24 | 40 | 0 | 0 | 11 |
| diagnostics observer under load | broadcastchannel | 15.17 → 15.32 | 0.13 | 0 | 0 | 20 | 0 | 13 | 18 | 0 | 0 | 0 |
| setup and release churn | sharedworker | 14.34 → 15.69 | 0.13 | 0 | 0 | 4 | 0 | 3 | 4 | 0 | 0 | 2 |
| setup and release churn | broadcastchannel | 15.45 → 15.79 | 0.13 | 0 | 0 | 4 | 0 | 1 | 0 | 0 | 0 | 0 |
| a simulated week | sharedworker | 14.35 → 14.8 | 0.13 | 0 | 0 | 20 | 30 | 23 | 38 | 0 | 0 | 10 |
| a simulated week | broadcastchannel | 14.73 → 14.84 | 0.13 | 0 | 0 | 20 | 30 | 13 | 18 | 0 | 0 | 0 |
| sustained device traffic | sharedworker | 14.4 → 14.86 | 0.14 | 0 | 0 | 20 | 20 | 23 | 38 | 0 | 0 | 10 |
| sustained device traffic | broadcastchannel | 14.73 → 14.87 | 0.14 | 0 | 0 | 20 | 20 | 13 | 18 | 0 | 0 | 0 |
| writes under owner crashes | sharedworker | 14.76 → 15.96 | 0.15 | 0 | 0 | 40 | 0 | 43 | 78 | 0 | 0 | 20 |
| writes under owner crashes | broadcastchannel | 15.24 → 16.01 | 0.15 | 0 | 0 | 40 | 0 | 23 | 38 | 0 | 0 | 0 |
