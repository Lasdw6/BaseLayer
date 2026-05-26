# BrowserArena Results

These are self-hosted BaseLayer runs using BrowserArena-style lifecycle stages:

```text
session create + CDP connect + page.goto + session release
```

## Latest Sequential Replication

Run shape:

- run date: 2026-05-23
- provider/API and benchmark runner: same AWS `m5zn.metal` host
- target: `https://example.com/`
- wait condition: `domcontentloaded`
- runs: `100`
- concurrency: `1`
- runtime: Firecracker + `chromium-headless-shell`
- delete path: async API release with delayed node-agent teardown
- connection path: WebSocket-first CDP connect with HTTP CDP fallback

| Run | Run date | Success | Create p50 | Connect p50 | Goto p50 | Release p50 | Lifecycle p50 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `wsprobe-c1x100` | 2026-05-23 | `99/100` | `167.7 ms` | `15.1 ms` | `103.4 ms` | `26.6 ms` | `332.2 ms` |
| `repl332-c1x100` | 2026-05-23 | `99/100` | `158.6 ms` | `22.6 ms` | `103.2 ms` | `24.9 ms` | `331.1 ms` |
| `repl332b-c1x100` | 2026-05-23 | `98/100` | `167.7 ms` | `14.8 ms` | `100.9 ms` | `26.5 ms` | `331.5 ms` |

The latency replicated tightly at roughly `331-332 ms` p50 lifecycle.

Against the BrowserArena `2026-05-22` c1 leaderboard snapshot, this positions
BaseLayer ahead of the top listed provider by p50 lifecycle latency:

| Rank | Provider / variant | Lifecycle | Create | Connect | Goto | Release | Success |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | BaseLayer | `331 ms` | `159 ms` | `23 ms` | `103 ms` | `25 ms` | `99/100` |
| 2 | Kernel | `341 ms` | `34 ms` | `84 ms` | `185 ms` | `39 ms` | `100/100` |
| 3 | Notte | `394 ms` | `157 ms` | `112 ms` | `101 ms` | `24 ms` | `100/100` |
| 4 | Browserbase | `557 ms` | `110 ms` | `241 ms` | `126 ms` | `81 ms` | `100/100` |
| 5 | Steel | `1190 ms` | `346 ms` | `629 ms` | `100 ms` | `116 ms` | `100/100` |
| 6 | Hyperbrowser | `1761 ms` | `1048 ms` | `218 ms` | `134 ms` | `361 ms` | `99/100` |
| 7 | Anchor Browser | `3664 ms` | `1440 ms` | `155 ms` | `1257 ms` | `812 ms` | `99/100` |
| 8 | Browser Use | `4538 ms` | `1489 ms` | `114 ms` | `782 ms` | `2154 ms` | `100/100` |

This is a latency-positioning comparison, not an official leaderboard claim.

## Latest Concurrent Validation

The concurrent validation was run on 2026-05-23. It used `BENCH_RUNS=10` and
`BENCH_CONCURRENCY=10`, which produces 10 waves of 10 sessions, or 100 measured
sessions total.

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
