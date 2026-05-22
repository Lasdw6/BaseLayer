# BaseLayer Documentation

This folder contains the public architecture, API, benchmark, and experiment
notes for BaseLayer.

Recommended reading order:

| Topic | File |
| --- | --- |
| Benchmark commands and output schema | [BENCHMARKS.md](./BENCHMARKS.md) |
| Current maintained profiles | [current-best-profiles.md](./current-best-profiles.md) |
| Public profile IDs and legacy aliases | [profile-naming-system.md](./profile-naming-system.md) |
| Firecracker phase notes | [firecracker-phases.md](./firecracker-phases.md) |
| Firecracker scaling notes | [firecracker-scaling-analysis.md](./firecracker-scaling-analysis.md) |
| Firecracker rootfs variants | [firecracker-rootfs-variants.md](./firecracker-rootfs-variants.md) |
| Provider API surface | [provider-api-scaffold.md](./provider-api-scaffold.md) |
| Provider observability contract | [provider-observability-contract.md](./provider-observability-contract.md) |
| Provider scorecard metrics | [provider-scorecard-metrics.md](./provider-scorecard-metrics.md) |
| BrowserArena result notes | [browserarena-results.md](./browserarena-results.md) |
| Experiment ledger | [optimization-experiments-log.md](./optimization-experiments-log.md) |

Benchmark notes are research artifacts. Check each document's topology and
caveats before comparing numbers across runs.
