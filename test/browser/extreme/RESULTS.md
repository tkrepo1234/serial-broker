# Extreme browser run: last run

Written by `test/browser/extreme/sustained-load.spec.ts`; do not edit by hand. Each cell is
**heap MiB / DOM nodes / event listeners**, read over CDP after a garbage collection.

- **Run:** 2026-09-14 21:17:04 UTC on chromium (channel msedge), AMD Ryzen 7 7840HS w/ Radeon 780M Graphics
- **Load:** 20 pages, 5 minutes, a line every 500 ms from every page, the page holding the port closed every 30 s (8 times) and replaced
- **Bounds:** heap +4 MiB, nodes +10, listeners +10 from the first reading of a page to its last
- **Sends refused:** none

| Page | Start | Middle | End |
| --- | --- | --- | --- |
| 9 | 1.74 / 41 / 22 | 1.82 / 41 / 22 | 2.15 / 41 / 22 |
| 10 | 1.74 / 41 / 22 | 1.82 / 41 / 22 | 1.85 / 41 / 22 |
| 11 | 1.74 / 41 / 22 | 1.76 / 41 / 22 | 1.89 / 41 / 22 |
| 12 | 1.74 / 41 / 22 | 1.82 / 41 / 22 | 1.89 / 41 / 22 |
| 13 | 1.73 / 41 / 22 | 1.82 / 41 / 22 | 1.85 / 41 / 22 |
| 14 | 1.72 / 41 / 22 | 1.82 / 41 / 22 | 1.89 / 41 / 22 |
| 15 | 1.73 / 41 / 22 | 1.82 / 41 / 22 | 1.89 / 41 / 22 |
| 16 | 1.72 / 41 / 22 | 1.82 / 41 / 22 | 1.89 / 41 / 22 |
| 17 | 1.72 / 41 / 22 | 1.82 / 41 / 22 | 1.89 / 41 / 22 |
| 18 | 1.72 / 41 / 22 | 1.82 / 41 / 22 | 1.89 / 41 / 22 |
| 19 | 1.73 / 41 / 22 | 1.81 / 41 / 22 | 1.89 / 41 / 22 |
| 20 | 1.73 / 41 / 22 | 1.81 / 41 / 22 | 1.85 / 41 / 22 |
| 21 | n/a | 1.74 / 41 / 22 | 1.84 / 41 / 22 |
| 22 | n/a | 1.73 / 41 / 22 | 1.84 / 41 / 22 |
| 23 | n/a | 1.72 / 41 / 22 | 1.83 / 41 / 22 |
| 24 | n/a | n/a | 1.82 / 41 / 22 |
| 25 | n/a | n/a | 1.81 / 41 / 22 |
| 26 | n/a | n/a | 1.74 / 41 / 22 |
| 27 | n/a | n/a | 1.73 / 41 / 22 |
| 28 | n/a | n/a | 1.72 / 41 / 22 |
| SharedWorker | 0.43 / - / - | 0.46 / - / - | 0.46 / - / - |

A page numbered above the page count replaced one that was closed while holding the port; a
page without a start reading was opened after the first reading was taken. The SharedWorker
has heap only: it has no DOM, and CDP reports no listener count for a worker.
