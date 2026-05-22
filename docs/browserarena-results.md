# BrowserArena Results

## Methodology Snapshot

BrowserArena changed the default benchmark URL from Google to `example.com` on
2026-05-05. That makes the current public leaderboard much faster than the
older Google-target leaderboard BaseLayer originally compared against.

Keep the two eras separate:

- **Google-era BrowserArena:** `page.goto("https://google.com/")`,
  `waitUntil: "domcontentloaded"`. BaseLayer's `769 ms` result belongs here.
- **Current BrowserArena:** `page.goto("https://example.com/")`,
  `waitUntil: "domcontentloaded"`. BaseLayer has not yet published a rerun in
  this methodology.

## Google-Era Sequential Snapshot

This table freezes the old comparison set used by the BaseLayer result notes.
It should be used only for Google-target comparisons.

| Rank | Provider / Variant | Lifecycle | Create | Connect | Goto | Release | Success |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | Kernel | `743 ms` | `28 ms` | `278 ms` | `398 ms` | `39 ms` | `1000/1000` |
| 2 | BaseLayer BrowserArena-comparable self-run | `769 ms` | `93 ms` | `56 ms` | `618 ms` | `5 ms` | `99/100` |
| 3 | Kernel Headful | `881 ms` | `29 ms` | `400 ms` | `412 ms` | `40 ms` | `1000/1000` |
| 4 | Notte | `953 ms` | `229 ms` | `123 ms` | `507 ms` | `94 ms` | `1000/1000` |
| 5 | Steel | `1627 ms` | `430 ms` | `575 ms` | `549 ms` | `73 ms` | `1000/1000` |
| 6 | Hyperbrowser | `2081 ms` | `1307 ms` | `186 ms` | `293 ms` | `295 ms` | `1000/1000` |
| 7 | Browserbase | `2246 ms` | `178 ms` | `946 ms` | `939 ms` | `183 ms` | `1000/1000` |
| 8 | Anchor Browser | `2967 ms` | `1356 ms` | `137 ms` | `693 ms` | `781 ms` | `1000/1000` |
| 9 | Browser Use | `5035 ms` | `1268 ms` | `105 ms` | `1602 ms` | `2060 ms` | `983/1000` |

## Current `example.com` Sequential Snapshot

As of the BrowserArena `2026-05-22` c1 artifacts, the same providers are much
faster on the new `example.com` target:

| Provider | Lifecycle | Create | Connect | Goto | Release | Success |
|---|---:|---:|---:|---:|---:|---:|
| Kernel Headful | `264 ms` | `33 ms` | `71 ms` | `123 ms` | `38 ms` | `100/100` |
| Kernel | `341 ms` | `34 ms` | `84 ms` | `185 ms` | `39 ms` | `100/100` |
| Notte | `394 ms` | `157 ms` | `112 ms` | `101 ms` | `24 ms` | `100/100` |
| Browserbase | `557 ms` | `110 ms` | `241 ms` | `126 ms` | `81 ms` | `100/100` |
| Steel | `1190 ms` | `346 ms` | `629 ms` | `100 ms` | `116 ms` | `100/100` |
| Hyperbrowser | `1761 ms` | `1048 ms` | `218 ms` | `134 ms` | `361 ms` | `99/100` |
| Anchor Browser | `3664 ms` | `1440 ms` | `155 ms` | `1257 ms` | `812 ms` | `99/100` |
| Browser Use | `4538 ms` | `1489 ms` | `114 ms` | `782 ms` | `2154 ms` | `100/100` |

BaseLayer needs a fresh `example.com` run before making any current-leaderboard
claim. The expected command shape for the in-repo provider harness is:

```bash
export BASELAYER_API_URL="http://<provider-host>:3000/v1"
export BASELAYER_RUNTIME_PROFILE="baselayer-firecracker-headless-shell-cdp-warm-density"
export BENCH_RUNS=100
export BENCH_CONCURRENCY=1
export BENCH_BROWSERARENA_PAGE_URL="https://example.com/"
export BENCH_PAGE_GOTO_WAIT_UNTIL="domcontentloaded"
export BENCH_OUT="$PWD/data/benchmarks/provider-api-example-c1-100.json"

npm run bench:provider-api
```

For a BrowserArena-runner result, patch/register the BaseLayer provider in a
fresh BrowserArena checkout and run the same provider against
`https://example.com/`.

Note:
- This file records the first realistic `100`-run browserarena result.
- It is no longer the current default runtime summary.
- The current repo decision is:
  - baseline `chromium-headless-shell` remains the default browser runtime
  - full Chromium is experimental
- the canonical `baselayer-firecracker-headless-shell` sequential path uses **async delete**; older sync-delete rows remain useful only as diagnostics
- The latest clean `5`-run baseline rerun on the current KVM testbed was approximately:
  - create `534 ms`
  - connect `113 ms`
  - goto `1310 ms`
  - release `2 ms`
  - rough lifecycle `1961 ms`
  - success `5/5`

## Fixed-Metrics GCP KVM Rerun

Browserarena fixed its metric tracking so `session_release_ms` now clearly exposes whether the provider blocks on teardown. The first fixed-metrics GCP KVM rerun showed a release regression because the BaseLayer API waited for node-agent VM teardown:

| Run | Create p50 | Connect p50 | Goto p50 | Release p50 | Rough lifecycle p50 | Success |
|---|---:|---:|---:|---:|---:|---:|
| Before async release fix | `513 ms` | `108 ms` | `1282 ms` | `878 ms` | `2787 ms` | `5/5` |
| After async release fix | `534 ms` | `113 ms` | `1310 ms` | `2 ms` | `1961 ms` | `5/5` |

Conclusion: the fixed metric tracking did not show a launch regression. It exposed synchronous teardown at the public API boundary. The API now marks the session terminated and tears down the node-agent session asynchronously, which returns release to the expected low-millisecond range.

## Fixed-Metrics Leaderboard Fit

Using the bundled BrowserArena `hello-browser` c1 artifacts for competitors and the latest BaseLayer fixed-metrics samples:

| Rank | Provider / Variant | Lifecycle | Create | Connect | Goto | Release | Success |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | Kernel | `743 ms` | `28 ms` | `278 ms` | `398 ms` | `39 ms` | `1000/1000` |
| 2 | BaseLayer BrowserArena-comparable self-run | `769 ms` | `93 ms` | `56 ms` | `618 ms` | `5 ms` | `99/100` |
| 3 | Kernel Headful | `881 ms` | `29 ms` | `400 ms` | `412 ms` | `40 ms` | `1000/1000` |
| 4 | Notte | `953 ms` | `229 ms` | `123 ms` | `507 ms` | `94 ms` | `1000/1000` |
| 5 | BaseLayer AWS `m5zn.metal` small-sample same-host | `992 ms` | `441 ms` | `51 ms` | `499 ms` | `1 ms` | `5/5` |
| 6 | Steel | `1627 ms` | `430 ms` | `575 ms` | `549 ms` | `73 ms` | `1000/1000` |
| 7 | BaseLayer GCP KVM fixed | `1959 ms` | `534 ms` | `113 ms` | `1310 ms` | `2 ms` | `5/5` |
| 8 | Hyperbrowser | `2081 ms` | `1307 ms` | `186 ms` | `293 ms` | `295 ms` | `1000/1000` |
| 9 | Browserbase | `2246 ms` | `178 ms` | `946 ms` | `939 ms` | `183 ms` | `1000/1000` |
| 10 | BaseLayer GCP KVM sync-release regression | `2781 ms` | `513 ms` | `108 ms` | `1282 ms` | `878 ms` | `5/5` |
| 11 | Anchor Browser | `2967 ms` | `1356 ms` | `137 ms` | `693 ms` | `781 ms` | `1000/1000` |
| 12 | Browser Use | `5035 ms` | `1268 ms` | `105 ms` | `1602 ms` | `2060 ms` | `983/1000` |

The `769 ms` BaseLayer row is the latest BrowserArena-comparable self-run using the actual BrowserArena harness. The older BaseLayer rows below it are retained as historical context only.

## Latest BrowserArena-Comparable Sequential Self-Run

The current BrowserArena-comparable BaseLayer sequential result is the 2026-04-23 self-run using
the **actual BrowserArena harness** on AWS:

- runner: AWS `t3.micro`
- provider host: AWS `m5zn.metal`
- region: `us-east-2`
- benchmark: BrowserArena `hello-browser`
- target: Google
- runs: `100`

Result:

- success: `99/100`
- create p50: `93 ms`
- connect p50: `56 ms`
- goto p50: `618 ms`
- release p50: `5 ms`
- lifecycle p50: `769 ms`

Primary reference:

- [browserarena-comparable-sequential-2026-04-23.md](./browserarena-comparable-sequential-2026-04-23.md)

Relative to the public sequential table used elsewhere in this repo, that would place BaseLayer:

- behind Kernel (`743 ms`)
- ahead of Notte (`953 ms`)

So the current BrowserArena-comparable BaseLayer self-run is effectively **#2 on sequential
latency**.

## Full-Chromium Provider `/v1` BrowserArena Rerun (2026-05-07)

Latest full-Chromium provider-path rerun:

- runner: AWS `t3.micro`
- provider host: AWS `m5zn.metal`
- region: `us-east-1`
- benchmark: BrowserArena `hello-browser`
- path: public `/v1`
- delete semantics: async
- runs: `100`

Result:

- success: `100/100`
- create p50: `96 ms`
- connect p50: `61 ms`
- goto p50: `619 ms`
- release p50: `10 ms`
- lifecycle p50: `784 ms`

Important caveats:

- the late-run `503 No host is currently eligible for session admission` collapse is fixed for this lane
- one successful create still spiked to `30842 ms`, which inflates the create average
- `10` successful rows have `session_release_ms = null` because BrowserArena logged `SESSION_RELEASE_ERROR ... HTTP 404`, even though the benchmark still completed `100/100`

So this is now a **usable** provider-path full-Chromium BrowserArena row, but it is not yet the clean final full-Chromium reference. The remaining work is tail cleanup, not median-path rescue.

## Exact `m5zn.metal + t3.micro` Cloud Rerun (2026-04-24)

The next exact-shape rerun was completed in `us-east-1` using the same BrowserArena-style layout
the repo has been targeting:

- runner: AWS `t3.micro`
- provider host: AWS `m5zn.metal`
- benchmark: BrowserArena `hello-browser`
- wait semantics: `domcontentloaded`
- runs: `100`
- provider runtime: `baselayer-firecracker-headless-shell-cdp-warm-density`

Result:

- success: `99/100`
- create p50: `87 ms`
- connect p50: `102 ms`
- goto p50: `555 ms`
- release p50: `5 ms`
- lifecycle p50: `749 ms`

Important caveat:

- this run had one successful create outlier at `30825 ms`
- and one measured `session_create` failure at `45000 ms`

The deep dive on that exact run found that both events came from the same host-side failure class:

- Firecracker restore reached `machine-started`
- local CDP readiness on the relay path stalled at `/json/list`
- one session recovered after a bounded retry to the other slot
- one session did not recover before the control-plane `45000 ms` timeout

That analysis is based on:

- [browserarena-m5zn-east1-node-agent-2026-04-24.log](../.tmp/browserarena-m5zn-east1-node-agent-2026-04-24.log)
- [browserarena-m5zn-east1-api-2026-04-24.log](../.tmp/browserarena-m5zn-east1-api-2026-04-24.log)
- [browserarena-m5zn-east1-c1-results-2026-04-24.jsonl](../.tmp/browserarena-m5zn-east1-c1-results-2026-04-24.jsonl)

Follow-up fix now implemented locally:

- Firecracker restore attempts share one bounded readiness deadline instead of handing
  `/json/version`, `/json/list`, and websocket readiness separate full timeout budgets.
- Node-agent stale launch reservation pruning now skips sessions still actively in a Firecracker
  launch and no longer expires earlier than the control-plane create timeout.

Until that fix is revalidated on paid cloud, the `2026-04-23` `769 ms` row remains the safer
published BrowserArena-comparable baseline, and the `2026-04-24` `749 ms` row should be read as
"faster median, unresolved create-tail reliability."

Lightpanda experimental note: after fixing the smoke harness, a standalone Lightpanda GCP run against `https://google.com/` produced `5/5` success with p50 serve/create `253 ms`, connect `9 ms`, goto `109 ms`, release `10 ms`, and total `396 ms`. This is not inserted into the leaderboard above because it is not a full BaseLayer provider/session implementation and Lightpanda is not Chromium; it is a promising experimental fast-lane datapoint with compatibility caveats.

## Same-Region Provider Comparison: BaseLayer vs Browser-Use

The clean same-region provider comparison is now captured separately in [BaseLayer-vs-Browser-Use.md](./BaseLayer-vs-Browser-Use.md). It used:

- runner: AWS `t3.micro` in `us-east-2`
- Browser-Use control/data plane: validated in `us-east-2`
- BaseLayer provider host: AWS `m5zn.metal` in `us-east-2`
- benchmark: BrowserArena `hello-browser`
- target: `https://google.com/`
- `runs=25`, `concurrency=1`, `HELLO_BROWSER_WARMUP_RUNS=0`

Final successful comparison:

| Provider | Success | Create p50 | Connect p50 | Goto p50 | Release p50 | Lifecycle p50 |
|---|---:|---:|---:|---:|---:|---:|
| Browser-Use | `25/25` | `1510 ms` | `26 ms` | `430 ms` | `2197 ms` | `4173 ms` |
| BaseLayer-Mew | `25/25` | `66 ms` | `55 ms` | `643 ms` | `3 ms` | `770 ms` |

Learning:

- Browser-Use currently wins isolated `goto`.
- BaseLayer wins the full lifecycle decisively because create and release are far cheaper.
- For hyperscaler / worker-substrate positioning, this is the more important result than the raw `goto` bar because platform customers pay create and teardown repeatedly.

This file records the first realistic `browserarena` run against BaseLayer using:

- Provider VM: GCP `n2-standard-8`, Firecracker mode
- Runner VM: GCP `e2-medium`
- Benchmark: `hello-browser`
- Provider: `baselayer`
- Mode: sequential
- URL: `google.com`

These numbers come from the last `100` records in:

- [results.jsonl](../data/browserarena/baselayer-seq-2026-04-09/results.jsonl)

Raw artifacts:

- [results.jsonl](../data/browserarena/baselayer-seq-2026-04-09/results.jsonl)
- [results.log](../data/browserarena/baselayer-seq-2026-04-09/results.log)
- [_meta.json](../data/browserarena/baselayer-seq-2026-04-09/_meta.json)

## Summary

- Total: `100`
- Success: `99`
- Failure: `1`
- Reliability: `99.0%`
- Failure stage: `connect_over_cdp`

Median timings across successful runs:

- `session_creation_ms`: `537 ms`
- `session_connect_ms`: `112 ms`
- `page_goto_ms`: `1738 ms`
- `session_release_ms`: `5894 ms`

Other timing stats:

| Metric | Min | P50 | P95 | Max | Avg |
|---|---:|---:|---:|---:|---:|
| Session create | `527` | `537` | `545` | `547` | `537` |
| Session connect | `105` | `112` | `125` | `138` | `114` |
| Page goto | `1609` | `1738` | `1848` | `1891` | `1741` |
| Session release | `5884` | `5894` | `5901` | `5904` | `5894` |

Approximate end-to-end lifecycle p50:

- `537 + 112 + 1738 + 5894 = 8281 ms`

## Interpretation

BaseLayer is currently bottlenecked by teardown, not launch.

The browser-side path is already much better than the total lifecycle suggests:

- create + connect + goto p50: `2387 ms`
- connect + goto p50: `1850 ms`

That is much closer to the mid-pack hosted providers than the full `8281 ms` lifecycle number.

The dominant problem is `session_release_ms` at roughly `5.9 s`.

## Historical Leaderboard Fit

Compared with the public `browserarena` leaderboard as of April 8, 2026:

- Kernel: `743 ms`, `100.0%`
- Notte: `953 ms`, `100.0%`
- Steel: `1627 ms`, `100.0%`
- Hyperbrowser: `2081 ms`, `100.0%`
- Browserbase: `2246 ms`, `100.0%`
- Anchor Browser: `2967 ms`, `100.0%`
- Browser Use: `5035 ms`, `98.3%`
- BaseLayer: `8281 ms`, `99.0%`

So that older GCP run would place:

- last on raw lifecycle latency
- above Browser Use on reliability
- closer to Browserbase / Hyperbrowser on the actual create+connect+goto portion

This historical section should not be treated as the current BaseLayer position. Newer AWS same-host and same-region runs are materially faster, and the canonical provider comparison against Browser-Use now lives in [BaseLayer-vs-Browser-Use.md](./BaseLayer-vs-Browser-Use.md).

## Notes

- This is not a public-leaderboard-equivalent submission.
- The public leaderboard uses AWS EC2 runners and larger sample sizes.
- BaseLayer was run self-hosted on GCP with `100` runs.
- Treat this as realistic directional data, not a final leaderboard entry.
## AWS Bare-Metal Result

The current fastest BaseLayer browserarena sample is the AWS `m5zn.metal` bare-metal run from 2026-04-11.

P50 from the confirmed `5`-run sample:

- `session_creation_ms`: `441 ms`
- `session_connect_ms`: `51 ms`
- `page_goto_ms`: `499 ms`
- `session_release_ms`: `1 ms`
- rough lifecycle p50: `992 ms`
- success: `5/5`

Detailed artifact and comparison: [aws-baremetal-results.md](./aws-baremetal-results.md).

Important caveat: this ran browserarena on the same bare-metal host as the BaseLayer provider, so it isolates host/runtime performance with minimal provider-client network overhead. It is not a public leaderboard-equivalent run.
