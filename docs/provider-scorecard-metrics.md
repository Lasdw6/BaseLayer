# Provider Scorecard Metrics And SOTA Targets

Date: 2026-04-11

## Why This Exists

BaseLayer needs a benchmark that answers the buyer's question:

> Is this worker substrate enough better than our AWS/GCP VM fleet that we should use it instead of staffing more browser-infra work ourselves?

That is not one metric. We need three scorecards:

1. BrowserArena-style latency and reliability.
2. Compute density under realistic concurrency.
3. Failure-adjusted cost per stable browser-hour and per 1,000 task starts.

The repo now has a runnable scorecard:

```bash
npm run bench:provider-scorecard
```

Optional inputs:

```bash
PROVIDER_SCORECARD_HOST_HOURLY_USD=5 \
PROVIDER_SCORECARD_HOST_UTILIZATION=0.70 \
PROVIDER_SCORECARD_HOST_CONCURRENCY=200 \
PROVIDER_SCORECARD_HOST_VCPU=48 \
PROVIDER_SCORECARD_HOST_MEMORY_GB=192 \
npm run bench:provider-scorecard
```

Override artifacts:

```bash
PROVIDER_SCORECARD_BROWSERARENA_PATHS="data/benchmarks/aws-baremetal-m5zn-2026-04-11/browserarena-results.jsonl" \
PROVIDER_SCORECARD_DENSITY_PATHS="data/benchmarks/gcp-n2s8/density-profile-b-optimized-node-c50.json" \
npm run bench:provider-scorecard
```

## External SOTA Numbers

BrowserArena is the cleanest public reference right now. It compares cloud-browser providers on speed, reliability, and cost, with open-source benchmarks ([BrowserArena](https://www.browserarena.ai/), [BrowserArena GitHub](https://github.com/nottelabs/browserarena)).

As fetched on 2026-04-11, BrowserArena sequential `hello-browser` shows:

| Provider | Runs | Reliability | Latency | Cost/hr |
|---|---:|---:|---:|---:|
| Kernel | 1,000 | 100.0% | 743 ms | $0.06 |
| Notte | 1,000 | 100.0% | 953 ms | $0.05 |
| Steel | 1,000 | 100.0% | 1,627 ms | $0.10 |
| Hyperbrowser | 1,000 | 100.0% | 2,081 ms | $0.10 |
| Browserbase | 1,000 | 100.0% | 2,246 ms | $0.12 |
| Anchor Browser | 1,000 | 100.0% | 2,967 ms | $0.05 |
| Browser Use | 1,000 | 98.3% | 5,035 ms | $0.06 |

BrowserArena concurrent `hello-browser` at `100 x 16` shows:

| Provider | Runs | Reliability | Latency | Cost/hr |
|---|---:|---:|---:|---:|
| Kernel | 1,600 | 99.7% | 1,014 ms | $0.06 |
| Notte | 1,600 | 99.9% | 1,131 ms | $0.05 |
| Steel | 1,600 | 99.8% | 1,925 ms | $0.10 |
| Browserbase | 1,600 | 100.0% | 2,312 ms | $0.12 |
| Hyperbrowser | 1,600 | 99.9% | 3,035 ms | $0.10 |
| Anchor Browser | 1,600 | 100.0% | 3,738 ms | $0.05 |
| Browser Use | 1,600 | 97.6% | 5,139 ms | $0.06 |

Interpretation:

- To be speed SOTA, BaseLayer needs `p50 total <= 1,000 ms` sequential, with a stretch target near Kernel's `743 ms`.
- To be concurrent SOTA, BaseLayer needs `p50 total <= 1,100 ms` at BrowserArena `100 x 16`, while keeping reliability at `>= 99.9%`.
- To be commercially credible even if not speed-first SOTA, BaseLayer should be clearly better than Steel/Browserbase latency while materially cheaper at the worker-substrate layer.

## BaseLayer Current Evidence

Current local artifacts:

| Run | Sample | Reliability | P50 create | P50 connect | P50 goto | P50 release | P50 total |
|---|---:|---:|---:|---:|---:|---:|---:|
| GCP BrowserArena 2026-04-09 | last 100 | 99.0% | 537 ms | 112 ms | 1,738 ms | 5,894 ms | 8,281 ms |
| KVM short baseline | 5 | 100.0% | 523 ms | 107 ms | 1,442 ms | 3 ms | 2,075 ms |
| AWS `m5zn.metal` local-runner | 5 | 100.0% | 441 ms | 51 ms | 499 ms | 1 ms | 992 ms |

Caveat: the AWS `m5zn.metal` result used a same-host/local runner, so it is not yet BrowserArena leaderboard-equivalent. It is still the strongest evidence that bare metal plus the current runtime can move the compute path into the SOTA band.

Current GCP `n2-standard-8` local density artifacts:

| Profile | Concurrency | Stable | P50 create | P95 create | P50 navigate | P95 navigate | Peak tracked memory |
|---|---:|---|---:|---:|---:|---:|---:|
| Generic container worker | 50 | yes | 13,904 ms | 22,327 ms | 4,461 ms | 5,778 ms | 4,180 MB |
| Optimized multi-session node | 50 | yes | 10,575 ms | 19,226 ms | 4,465 ms | 5,493 ms | 3,962 MB |
| Firecracker snapshot tier | 24 | yes | 3,628 ms | 4,608 ms | 8,104 ms | 8,499 ms | 24,576 MB |

Interpretation:

- The optimized multi-session node improves create tail versus generic container at the same `c50` level, but it does not yet prove a higher stable concurrency ceiling. The next density run must go past `c50` until failure.
- Firecracker snapshot tier has better create latency under c24 than the generic c50 case, but the current density navigation and memory reservation are not yet competitive for a density tier. It fits the hardened-isolation lane until memory per session improves.

## SOTA Target Gates

### Gate 1: BrowserArena Sequential Speed

Run shape:

- BrowserArena `hello-browser`
- `1,000` measured sequential runs
- `10` warmups
- runner not on the same host as BaseLayer
- record create, connect, goto, release, total, failure stage

Targets:

| Level | Reliability | P50 total | P95 total | P95 release |
|---|---:|---:|---:|---:|
| Minimum credible | >= 99.5% | <= 1,500 ms | <= 2,500 ms | <= 250 ms |
| SOTA candidate | >= 99.9% | <= 1,000 ms | <= 1,500 ms | <= 100 ms |
| Speed leader | 100.0% | <= 750 ms | <= 1,100 ms | <= 50 ms |

Why these numbers:

- Kernel is currently `743 ms` sequential at `100.0%`.
- Notte is currently `953 ms` sequential at `100.0%`.
- A provider evaluating BaseLayer needs to see us inside that top band, not merely near mid-pack.

### Gate 2: BrowserArena Concurrent Speed

Run shape:

- BrowserArena `hello-browser`
- `100 x 16` concurrent shape, matching the public concurrent tab
- runner not on the same host as BaseLayer

Targets:

| Level | Reliability | P50 total | P95 total |
|---|---:|---:|---:|
| Minimum credible | >= 99.5% | <= 1,800 ms | <= 3,000 ms |
| SOTA candidate | >= 99.9% | <= 1,100 ms | <= 1,800 ms |
| Speed leader | >= 99.9% | <= 1,000 ms | <= 1,500 ms |

Why these numbers:

- Kernel is currently `1,014 ms` at `99.7%` in the BrowserArena `100 x 16` run.
- Notte is currently `1,131 ms` at `99.9%`.
- A strong result needs to combine Kernel-like speed with Notte-like reliability.

### Gate 3: Stable Density

Run shape:

- same benchmark workload on generic VM/container baseline and BaseLayer bare-metal worker
- same browser runtime class unless the test is explicitly comparing tiers
- increase concurrency until either create or navigation success falls below the SLO
- record p50/p95/p99 create and navigate, plus host pressure metrics

SLO:

- create success rate `>= 99.5%`
- navigation success rate `>= 99.5%`
- soak action failure rate `< 0.5%`
- p95 create latency within agreed bound for the workload
- p95 navigate latency within agreed bound for the workload
- no leaked processes, microVMs, overlays, sockets, or profile locks after cleanup

Targets:

| Level | Stable sessions per dollar | Stable sessions per vCPU | Notes |
|---|---:|---:|---|
| Minimum credible | >= 20% better than generic VM baseline | same or better | Worth a pilot only if integration is easy |
| Strong | >= 30% better than generic VM baseline | >= 30% better | Real adoption wedge |
| SOTA substrate | >= 50% better than generic VM baseline | >= 50% better | Hard for an internal infra team to ignore |

The important formula:

```text
required_baselayer_concurrency =
  baseline_concurrency * (baselayer_host_hourly_usd / baseline_host_hourly_usd) / (1 - target_cost_reduction)
```

Examples:

| BaseLayer host cost ratio vs baseline | Target cost reduction | Required concurrency vs baseline |
|---:|---:|---:|
| 1.0x | 30% | 1.43x |
| 1.5x | 30% | 2.14x |
| 2.0x | 30% | 2.86x |
| 1.0x | 50% | 2.00x |
| 1.5x | 50% | 3.00x |

This is why "bare metal" alone is not enough. If the bare-metal host costs more than the VM pack it replaces, BaseLayer must produce a proportionally larger concurrency or tail-reliability win.

### Gate 4: Cost Per Stable Browser-Hour

Formula:

```text
cost_per_stable_browser_hour =
  host_hourly_usd / (stable_concurrency * utilization * reliability)
```

Targets:

| Level | Infra cost per stable browser-hour |
|---|---:|
| Minimum credible | <= provider's current VM baseline |
| Strong | >= 30% lower than provider's current VM baseline |
| SOTA substrate | <= $0.02 to $0.035, if the downstream provider retails near $0.05/hr |

The `$0.02-$0.035` target is not a public-cloud price claim. It is a margin target. BrowserArena's cheapest public providers show `$0.05-$0.06/hr` browser pricing, so a worker-substrate vendor has to leave room for the provider's own control plane, proxy costs, support, billing, and margin.

Required stable concurrency for example host costs, assuming `70%` utilization and `99.9%` reliability:

| Host cost/hr | Cost target/browser-hour | Required stable concurrency |
|---:|---:|---:|
| $2/hr | $0.035 | 82 |
| $2/hr | $0.020 | 143 |
| $5/hr | $0.035 | 205 |
| $5/hr | $0.020 | 358 |
| $10/hr | $0.035 | 409 |
| $10/hr | $0.020 | 715 |

### Gate 5: Cost Per 1,000 Short Task Starts

This matters for short agent tasks where the browser is created, used briefly, and released.

Formula:

```text
cost_per_1000_starts =
  1000 * host_hourly_usd * lifecycle_seconds /
  (stable_concurrency * 3600 * utilization * reliability)
```

Example with `host_hourly_usd=$5`, `utilization=70%`, `reliability=99.9%`:

| Stable concurrency | 1s lifecycle | 5s lifecycle | 30s lifecycle |
|---:|---:|---:|---:|
| 50 | $0.040 | $0.199 | $1.191 |
| 100 | $0.020 | $0.099 | $0.596 |
| 200 | $0.010 | $0.050 | $0.298 |

Targets:

- For BrowserArena-like short lifecycle work, aim for `< $0.05 per 1,000 starts` at the SOTA latency gate.
- For 30-second agent tasks, aim for `< $0.50 per 1,000 starts` on the density tier.
- For hardened microVM sessions, accept higher cost only if the provider can sell it as a premium isolation tier.

### Gate 6: Compute Efficiency

Report these on every density run:

- stable sessions per vCPU
- stable sessions per GB RAM
- peak tracked memory per session
- peak renderer count per session
- peak `/dev/shm` per session
- CPU pressure / PSI during burst launch
- p95 create and p95 navigate at each concurrency level

Initial targets for the local synthetic density workload:

| Metric | Density tier target | Hardened tier target |
|---|---:|---:|
| Stable sessions per vCPU | >= 6 at `50%` active mix | >= 1 |
| P95 navigate at density SLO | <= 5,000 ms | <= 8,000 ms until browser runtime improves |
| Peak tracked memory/session | <= 100 MB synthetic, <= 350 MB real page | <= 512 MB reserved, stretch <= 384 MB |
| Peak renderer count/session | <= 2.5 | <= 2.5 |
| Orphaned process/microVM cleanup | 0 per 1,000 sessions | 0 per 1,000 sessions |

Current evidence:

- Optimized multi-session node at `c50` on `n2-standard-8`: `6.25 sessions/vCPU`, p95 navigate `5,493 ms`, peak tracked memory about `79 MB/session`.
- Firecracker tier at `c24`: p95 navigate `8,499 ms`, peak tracked memory `1,024 MB/session`; this is not yet a density-tier result.

## Benchmark Setup To Run Next

### 1. BrowserArena SOTA Validation

Run:

- `100` sequential first to catch obvious issues.
- `1,000` sequential for leaderboard-equivalent confidence.
- `100 x 16` concurrent after sequential is stable.

Pass/fail:

- `>= 99.9%` reliability.
- `<= 1,000 ms` p50 total sequential.
- `<= 1,100 ms` p50 total at concurrency 16.
- `<= 100 ms` p95 release.

### 2. Density-To-Failure Sweep

Run generic VM/container and BaseLayer bare-metal on equivalent spend.

Do not stop at `c50`; run until failure or until p95 latency violates SLO:

```text
c20, c30, c40, c50, c75, c100, c150, c200, ...
```

Pass/fail:

- BaseLayer has `>= 30%` lower cost per stable browser-hour than the VM baseline.
- Strong result is `>= 50%` lower.

### 3. Real-Page Compute Sweep

The local synthetic page is useful, but provider buyers care about real pages.

Run a small fixed set:

- `https://google.com/` for BrowserArena continuity
- one JS-heavy app
- one login/persistent-context workload
- one proxy-routed page

Pass/fail:

- p95 create and navigation do not collapse at the target stable concurrency.
- failure taxonomy cleanly separates browser, proxy, site, and infra failures.

### 4. Profile Persistence Benchmark

Measure:

- fresh profile create/connect/goto
- clone existing context
- commit profile
- reopen committed profile
- discard profile
- profile leak/corruption checks

Targets:

- cloned context at least `30%` faster than fresh session for authenticated workflows.
- zero cross-session cookie/storage leaks in 1,000 iterations.

## What Would Be A SOTA BaseLayer Claim

BaseLayer can claim a SOTA browser-hosting substrate only if it can show all of this:

- BrowserArena sequential: `<= 1,000 ms` p50 and `>= 99.9%` reliability.
- BrowserArena concurrent 16: `<= 1,100 ms` p50 and `>= 99.9%` reliability.
- Density: `>= 30%` lower failure-adjusted cost per stable browser-hour versus a generic VM/container fleet on equivalent spend.
- Compute: stable sessions per vCPU and per GB are at least `30%` better than the baseline at the same p95 SLO.
- Cleanup: zero leaked process trees, overlays, sockets, and microVMs in 1,000 forced-termination tests.
- Hardened tier: materially cheaper/faster than one-browser-per-VM, even if it is not as dense as the multi-session tier.

If we only beat BrowserArena latency but not density/cost, providers can copy the launch/runtime trick. If we beat density/cost but not compatibility and tail reliability, providers will not risk production traffic. The moat is the combination.
