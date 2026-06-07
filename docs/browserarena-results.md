# BrowserArena Results

These are self-hosted BaseLayer runs using BrowserArena-style lifecycle stages:

```text
session create + CDP connect + page.goto + session release
```

## Latest Sequential Replication

Run shape:

- run date: 2026-06-01
- benchmark runner: AWS `t3.micro`, `us-east-2`
- provider host: AWS `m5zn.metal`, `us-east-2`
- target: `http://example.com/`
- wait condition: `domcontentloaded`
- runs: `100`, repeated five times
- concurrency: `1`
- runtime: Firecracker + `chromium-headless-shell`
- delete path: async API release with delayed node-agent teardown
- connection path: WebSocket-first CDP connect with HTTP CDP fallback

| Run | Run date | Success | Create p50 | Connect p50 | Goto p50 | Release p50 | Lifecycle p50 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `baselayer-browserarena-live-1780317402874` | 2026-06-01 | `98/100` | `74.2 ms` | `22.8 ms` | `82.8 ms` | `10.9 ms` | `190.8 ms` |
| `baselayer-browserarena-live-1780317475105` | 2026-06-01 | `100/100` | `74.7 ms` | `31.8 ms` | `82.6 ms` | `11.3 ms` | `200.4 ms` |
| `baselayer-browserarena-live-1780317525945` | 2026-06-01 | `100/100` | `75.1 ms` | `21.3 ms` | `83.2 ms` | `11.8 ms` | `191.4 ms` |
| `baselayer-browserarena-live-1780317577522` | 2026-06-01 | `100/100` | `74.9 ms` | `54.4 ms` | `82.1 ms` | `11.8 ms` | `223.3 ms` |
| `baselayer-browserarena-live-1780317628739` | 2026-06-01 | `100/100` | `74.8 ms` | `54.4 ms` | `82.6 ms` | `11.8 ms` | `223.6 ms` |
| **Conservative headline run** | 2026-06-01 | **`100/100`** | **`74.8 ms`** | **`54.4 ms`** | **`82.6 ms`** | **`11.8 ms`** | **`223.6 ms`** |
| **Pooled successful iterations** | 2026-06-01 | **`498/500`** | **`74.8 ms`** | **`47.6 ms`** | **`82.6 ms`** | **`11.3 ms`** | **`216.3 ms`** |

For leaderboard-style comparisons, BaseLayer pools all successful iterations,
computes the p50 of each lifecycle stage, then sums those stage p50s. The raw
pooled per-iteration `total_ms.p50` for these same runs is `195.5 ms`; it is
retained in the artifacts for auditing but is not the headline comparison
number.

The public headline uses the slowest clean `100/100` run from this five-run
batch: `223.6 ms`, rounded to `224 ms`. The pooled stage-sum result across all
successful iterations is `216.3 ms` across `498/500` successes. Raw artifacts
and the summary are in
[`docs/benchmarks/browserarena-c1-final-2026-06-01/`](./benchmarks/browserarena-c1-final-2026-06-01/).

Against the BrowserArena c1 leaderboard snapshot checked on 2026-06-01, this
positions BaseLayer above the top listed provider by p50 lifecycle latency:

| Rank | Provider / variant | Lifecycle | Create | Connect | Goto | Release | Success |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | BaseLayer | `224 ms` | `75 ms` | `54 ms` | `83 ms` | `12 ms` | `100/100` |
| 2 | Notte | `358 ms` | `107 ms` | `117 ms` | `107 ms` | `27 ms` | `100/100` |
| 3 | Kernel | `365 ms` | `42 ms` | `79 ms` | `176 ms` | `68 ms` | `100/100` |
| 4 | Browserbase | `578 ms` | `112 ms` | `255 ms` | `127 ms` | `84 ms` | `100/100` |
| 5 | Steel | `972 ms` | `170 ms` | `591 ms` | `97 ms` | `114 ms` | `100/100` |
| 6 | Browser Use | `1206 ms` | `892 ms` | `152 ms` | `60 ms` | `104 ms` | `100/100` |
| 7 | Hyperbrowser | `1745 ms` | `1028 ms` | `231 ms` | `121 ms` | `365 ms` | `100/100` |
| 8 | Anchor Browser | `3791 ms` | `1467 ms` | `168 ms` | `1322 ms` | `835 ms` | `100/100` |

This is a latency-positioning comparison, not an official leaderboard claim.

## Latest Concurrent Validation

The current public headline is the conservative sequential run above. The
concurrent path is reported as validation data, not as the headline result.

The June 6, 2026 validation used the self-host BrowserArena runner against
`https://example.com`. Each `c10 x100` row is 100 waves of 10 parallel sessions,
or 1000 session attempts total.

| Run | Run date | Shape | Success | Create p50 | Connect p50 | Goto p50 | Release p50 | Lifecycle p50 |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Fresh metal repeat 1 | 2026-06-06 | `c10 x100` | `100/100` | `352 ms` | `70.5 ms` | `177.5 ms` | `18 ms` | `618 ms` |
| Fresh metal repeat 2 | 2026-06-06 | `c10 x100` | `100/100` | `161.5 ms` | `74.5 ms` | `266 ms` | `33.5 ms` | `535.5 ms` |
| Fresh metal repeat 3 | 2026-06-06 | `c10 x100` | `100/100` | `185.5 ms` | `78.5 ms` | `263 ms` | `31 ms` | `558 ms` |
| Same metal setup run | 2026-06-06 | `c10 x100` | `100/100` | `379.5 ms` | `71 ms` | `181 ms` | `20 ms` | `651.5 ms` |
| Same metal repeat 1 | 2026-06-06 | `c10 x100` | `100/100` | `145.5 ms` | `110 ms` | `333.5 ms` | `47.5 ms` | `636.5 ms` |
| Same metal repeat 2 | 2026-06-06 | `c10 x100` | `100/100` | `174.5 ms` | `107 ms` | `286.5 ms` | `44 ms` | `612 ms` |
| Same metal repeat 3 | 2026-06-06 | `c10 x100` | `98/100` | `166 ms` | `96 ms` | `259.5 ms` | `31.5 ms` | `553 ms` |

The three fresh-metal repeats provisioned a new `t3.micro` runner and a new
`m5zn.metal` host each time. The same-metal rows reused an already-running
BaseLayer host with `--use-running-baselayer`. c10 p50 stayed in range during
back-to-back same-host repeats, but the third immediate repeat exposed a
reliability tail with two failures, so repeated same-host c10 should be treated
as a stress path rather than the normal daily-run shape.

The previous c10 validation from 2026-05-23 used `BENCH_RUNS=10` and
`BENCH_CONCURRENCY=10`, which produced 10 waves of 10 sessions:

| Run | Run date | Shape | Success | Create p50 | Connect p50 | Goto p50 | Release p50 | Lifecycle p50 |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `wsfirst-wsprobe-c10x10` | 2026-05-23 | `c10 x10` | `100/100` | `396.1 ms` | `39.6 ms` | `144.8 ms` | `50.0 ms` | `651.7 ms` |

## Historical Google-Target Snapshot

The rows below used the older Google-target methodology and should not be
compared directly with current `example.com` leaderboard rows.

### BaseLayer Google-Target Rows

| Runtime / profile | Run date | Topology | Runs | Success | Create p50 | Connect p50 | Goto p50 | Release p50 | Lifecycle p50 |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `baselayer-firecracker-headless-shell-cdp-warm-density` | 2026-04-23 | AWS `t3.micro` runner -> AWS `m5zn.metal` provider, `us-east-2`, BrowserArena `hello-browser`, Google target | 100 | `99/100` | `93 ms` | `56 ms` | `618 ms` | `5 ms` | `769 ms` |
| `baselayer-firecracker-headless-shell-cdp-warm-density` | 2026-04-24 | AWS `t3.micro` runner -> AWS `m5zn.metal` provider, `us-east-1`, BrowserArena `hello-browser`, Google target | 100 | `99/100` | `87 ms` | `102 ms` | `555 ms` | `5 ms` | `749 ms` |
| `baselayer-firecracker-full-chromium` | 2026-05-07 | AWS `t3.micro` runner -> AWS `m5zn.metal` provider, public `/v1`, BrowserArena `hello-browser`, Google target | 100 | `100/100` | `96 ms` | `61 ms` | `619 ms` | `10 ms` | `784 ms` |

### Google-Era Leaderboard Fit

The historical Google-target leaderboard snapshot below is retained only for
context. It should not be mixed with the current `example.com` rows above.

| Rank | Provider / variant | Lifecycle | Create | Connect | Goto | Release | Success |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | Kernel | `743 ms` | `28 ms` | `278 ms` | `398 ms` | `39 ms` | `1000/1000` |
| 2 | BaseLayer | `769 ms` | `93 ms` | `56 ms` | `618 ms` | `5 ms` | `99/100` |
| 3 | Notte | `953 ms` | `229 ms` | `123 ms` | `507 ms` | `94 ms` | `1000/1000` |
| 4 | Steel | `1627 ms` | `430 ms` | `575 ms` | `549 ms` | `73 ms` | `1000/1000` |
| 5 | Hyperbrowser | `2081 ms` | `1307 ms` | `186 ms` | `293 ms` | `295 ms` | `1000/1000` |
| 6 | Browserbase | `2246 ms` | `178 ms` | `946 ms` | `939 ms` | `183 ms` | `1000/1000` |
| 7 | Anchor Browser | `2967 ms` | `1356 ms` | `137 ms` | `693 ms` | `781 ms` | `1000/1000` |
| 8 | Browser Use | `5035 ms` | `1268 ms` | `105 ms` | `1602 ms` | `2060 ms` | `983/1000` |

## Replication Command

```bash
export BASELAYER_API_URL="http://<provider-host>:3000/v1"
export BASELAYER_RUNTIME_PROFILE="baselayer-firecracker-headless-shell"
export CONTROL_PLANE_ASYNC_SESSION_DELETE=1
export CONTROL_PLANE_ASYNC_SESSION_DELETE_DELAY_MS=120000
export BENCH_RUNS=100
export BENCH_CONCURRENCY=1
export BENCH_BROWSERARENA_PAGE_URL="https://example.com/"
export BENCH_PAGE_GOTO_WAIT_UNTIL="domcontentloaded"
export BENCH_CONNECT_RETRY_BUDGET_MS=15000
export BENCH_OUT="$PWD/data/benchmarks/provider-api-example-c1x100.json"

npm run bench:provider-api
```

For c10 x10 validation:

```bash
export BENCH_RUNS=10
export BENCH_CONCURRENCY=10
export BENCH_OUT="$PWD/data/benchmarks/provider-api-example-c10x10.json"

npm run bench:provider-api
```
