# Benchmarks

What the library costs, measured against expectations that were written down first (ADR-0036).
The results are in the documentation's Performance chapter (`docs/site/performance.md`).

| Path              | What                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `expectations.ts` | The expected value of every metric, one set for the harness and one for the browser, with the reasoning next to each. Never adjusted to a result. |
| `report.ts`       | The shape of a run, the judgement of a result against its expectation, and the table and Markdown both benchmarks write.                          |
| `harness/`        | The scenarios on the simulated browser of `test/harness/`, and the runner. `npm run bench`, about a second.                                       |
| `run.mjs`         | Bundles the harness benchmark with esbuild and runs it with `--expose-gc`.                                                                        |
| `browser/`        | The same scenarios in a real Chromium with the Web Serial stand-in, through Playwright. `SERIAL_BROKER_BENCH_BROWSER=1 npm run bench:browser`.    |
| `results/`        | The last run of each, as JSON. Committed, with the commit and the machine inside.                                                                 |

Both commands build the package first. They write `results/` and the fragments under
`docs/site/_generated/` that the chapter includes; commit what they wrote. A result more than ten
times worse than its expectation is printed at the end and has to become a fix in `src/` with a
test, or a limit recorded in the chapter.

The benchmarks answer to the test suite's rules where they apply - the harness scenarios choose
interleavings the same way the integration tests do, and every scenario checks that it did what it
measures before it reports - and depart from them where a benchmark must: they read the wall clock,
and the browser benchmark paces itself with real timers.
