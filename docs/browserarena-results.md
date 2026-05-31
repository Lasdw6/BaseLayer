# BrowserArena Results

These are self-hosted BaseLayer runs using BrowserArena-style lifecycle stages:

```text
session create + CDP connect + page.goto + session release
```

## Latest Sequential Replication

Run shape:

- run date: 2026-05-31
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
| `baselayer-browserarena-live-1780266872992` | 2026-05-31 | `100/100` | `90.5 ms` | `19.4 ms` | `83.1 ms` | `11.7 ms` | `209.0 ms` |
| `baselayer-browserarena-live-1780266925633` | 2026-05-31 | `99/100` | `90.4 ms` | `54.5 ms` | `82.8 ms` | `11.6 ms` | `213.6 ms` |
| `baselayer-browserarena-live-1780266989299` | 2026-05-31 | `99/100` | `90.3 ms` | `54.4 ms` | `82.6 ms` | `11.3 ms` | `213.2 ms` |
| `baselayer-browserarena-live-1780267052917` | 2026-05-31 | `100/100` | `90.3 ms` | `18.9 ms` | `83.7 ms` | `11.6 ms` | `209.5 ms` |
| `baselayer-browserarena-live-1780267105128` | 2026-05-31 | `100/100` | `90.0 ms` | `50.5 ms` | `82.7 ms` | `11.2 ms` | `211.8 ms` |
| **Five-run average** | 2026-05-31 | **`498/500`** | **`90.3 ms`** | **`39.5 ms`** | **`83.0 ms`** | **`11.5 ms`** | **`211.4 ms`** |

The five-run average is `211.4 ms` p50 lifecycle across `498/500` successful
sessions. Raw artifacts and the summary are in
[`docs/benchmarks/browserarena-c1-final-2026-05-31/`](./benchmarks/browserarena-c1-final-2026-05-31/).

Against the BrowserArena c1 leaderboard snapshot checked on 2026-05-31, this
positions BaseLayer above the top listed provider by p50 lifecycle latency:

| Rank | Provider / variant | Lifecycle | Create | Connect | Goto | Release | Success |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | BaseLayer | `211 ms` | `90 ms` | `40 ms` | `83 ms` | `12 ms` | `498/500` |
| 2 | Notte | `401 ms` | `167 ms` | `110 ms` | `100 ms` | `24 ms` | `100/100` |
| 3 | Kernel | `479 ms` | `39 ms` | `70 ms` | `169 ms` | `201 ms` | `100/100` |
| 4 | Browserbase | `562 ms` | `110 ms` | `248 ms` | `122 ms` | `82 ms` | `100/100` |
| 5 | Browser Use | `1016 ms` | `764 ms` | `147 ms` | `58 ms` | `48 ms` | `100/100` |
| 6 | Steel | `1068 ms` | `179 ms` | `670 ms` | `101 ms` | `119 ms` | `100/100` |
| 7 | Hyperbrowser | `1749 ms` | `1010 ms` | `212 ms` | `164 ms` | `364 ms` | `100/100` |
| 8 | Anchor Browser | `5003 ms` | `2139 ms` | `218 ms` | `1482 ms` | `1164 ms` | `99/100` |

This is a latency-positioning comparison, not an official leaderboard claim.

## Latest Concurrent Validation

The current public headline is the sequential five-run average above. The
concurrent `c10 x10` path remains under review while the scheduler and live-demo
harness are being hardened.

The most recent published concurrent validation was run on 2026-05-23. It used
`BENCH_RUNS=10` and `BENCH_CONCURRENCY=10`, which produces 10 waves of 10
sessions, or 100 measured sessions total.

| Run | Run date | Success | Create p50 | Connect p50 | Goto p50 | Release p50 | Lifecycle p50 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `wsfirst-wsprobe-c10x10` | 2026-05-23 | `100/100` | `396.1 ms` | `39.6 ms` | `144.8 ms` | `50.0 ms` | `651.7 ms` |

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
export BENCH_BROWSERARENA_PAGE_URL="http://example.com/"
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
