# BrowserArena-Style c1 x100 Final Rerun (2026-06-01)

This folder contains the June 1, 2026 BaseLayer self-hosted sequential rerun
artifacts used for the current public headline number.

## Run Shape

- benchmark runner: AWS `t3.micro`, `us-east-2`
- provider host: AWS `m5zn.metal`, `us-east-2`
- target: `http://example.com/`
- wait condition: `domcontentloaded`
- workload: `c1 x100`, repeated five times
- runtime: Firecracker + `chromium-headless-shell`
- delete path: async API release with delayed node-agent teardown

## Headline Number: 223.6 ms, rounded to 224 ms

The public headline uses the slowest clean `100/100` run from the five-run
batch. That keeps the number conservative instead of picking the fastest run.

| Metric | Value |
| --- | ---: |
| Lifecycle stage-sum | **223.6 ms** |
| Session create | 74.8 ms |
| CDP connect | 54.4 ms |
| `page.goto` | 82.6 ms |
| Session release | 11.8 ms |
| Success | 100/100 |
| Artifact | [`baselayer-browserarena-live-1780317628739.json`](./baselayer-browserarena-live-1780317628739.json) |

BrowserArena-style lifecycle latency is computed by taking the p50 of each
successful lifecycle stage and summing those stage p50s:

```text
session create p50 + CDP connect p50 + page.goto p50 + session release p50
```

The raw per-iteration `total_ms.p50` is retained for auditability, but it is not
the headline comparison value.

## Five-Run Batch

| Artifact | Success | Stage-sum p50 | Raw total p50 | Create p50 | Connect p50 | Goto p50 | Release p50 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| [`baselayer-browserarena-live-1780317402874.json`](./baselayer-browserarena-live-1780317402874.json) | 98/100 | 190.8 ms | 193.3 ms | 74.2 ms | 22.8 ms | 82.8 ms | 10.9 ms |
| [`baselayer-browserarena-live-1780317475105.json`](./baselayer-browserarena-live-1780317475105.json) | 100/100 | 200.4 ms | 195.3 ms | 74.7 ms | 31.8 ms | 82.6 ms | 11.3 ms |
| [`baselayer-browserarena-live-1780317525945.json`](./baselayer-browserarena-live-1780317525945.json) | 100/100 | 191.4 ms | 193.5 ms | 75.1 ms | 21.3 ms | 83.2 ms | 11.8 ms |
| [`baselayer-browserarena-live-1780317577522.json`](./baselayer-browserarena-live-1780317577522.json) | 100/100 | 223.3 ms | 197.1 ms | 74.9 ms | 54.4 ms | 82.1 ms | 11.8 ms |
| [`baselayer-browserarena-live-1780317628739.json`](./baselayer-browserarena-live-1780317628739.json) | 100/100 | 223.6 ms | 196.9 ms | 74.8 ms | 54.4 ms | 82.6 ms | 11.8 ms |
| **Pooled successful iterations** | **498/500** | **216.3 ms** | **195.5 ms** | **74.8 ms** | **47.6 ms** | **82.6 ms** | **11.3 ms** |

The first run had two transient Firecracker restore CDP readiness timeouts. The
headline row intentionally uses a clean `100/100` artifact from the same batch.
