# Profile Naming

BaseLayer public profile IDs are descriptive, lowercase strings. They describe
the runtime architecture rather than an internal experiment codename.

Use public IDs in new commands, docs, and benchmark reports. Historical
`BaseLayer-<codename>-...` and `profile-*` IDs are still accepted by the
benchmark harness as legacy aliases so older result files remain reproducible.

## Public Profiles

| Public profile ID | Legacy alias | Status | Summary |
| --- | --- | --- | --- |
| `baselayer-firecracker-headless-shell` | `BaseLayer-Mew-firecracker-headless-shell`, `profile-c-firecracker-snapshot` | main | Firecracker + `chromium-headless-shell`, 1 vCPU / 1024 MB, async delete for latency-style runs. |
| `baselayer-managed-node` | `BaseLayer-Charizard-managed-node`, `profile-b-optimized-node` | active | Browser-aware managed node outside the Firecracker lane. |
| `baselayer-container-generic` | `BaseLayer-Bulbasaur-generic-container`, `profile-a-generic-container` | reference | Generic container-per-session baseline. |
| `baselayer-firecracker-full-chromium` | `BaseLayer-Mewtwo-full-chromium`, `profile-o-firecracker-full-chromium` | experimental | Full Chromium guest for compatibility-heavy workloads. |
| `baselayer-firecracker-headless-shell-cdp-warm-density` | `BaseLayer-Vulpix-density-cdp-warm`, `profile-bp-firecracker-density-cdp-warm` | experimental | CDP-ready warm snapshot density lane. |
| `baselayer-firecracker-headless-shell-startup-prune` | `BaseLayer-Gengar-kernel-startup-prune`, `profile-bz-firecracker-kernel-startup-prune` | experimental | Startup/service-prune Firecracker lane. |
| `baselayer-firecracker-headless-shell-kernel-balanced` | `BaseLayer-Dragonite-kernel-balanced`, `profile-ca-firecracker-kernel-balanced` | experimental | Balanced Kernel-inspired launch bundle. |
| `baselayer-firecracker-fluid-density` | `BaseLayer-Spearow-fluid-density`, `profile-z-firecracker-fluid-density` | experimental | Density lane with hybrid fluid CPU policy. |
| `baselayer-firecracker-headless-shell-density-512mb-1vcpu` | `BaseLayer-Raticate-density-512-1vcpu`, `profile-y-firecracker-density-512-1vcpu` | experimental | 512 MB / 1 vCPU packing experiment. |
| `baselayer-firecracker-custom-shell` | `BaseLayer-Abra-custom-shell-baseline` | experimental | Custom-built `chrome-headless-shell` baseline. |

Additional experimental aliases are registered in
[`src/bench/lib/profiles.ts`](../src/bench/lib/profiles.ts). If a profile is
not listed above, treat it as a narrow research lane.

## Command Guidance

Prefer public IDs:

```bash
BENCH_PROFILE_IDS="baselayer-firecracker-headless-shell" npm run bench:latency
```

Legacy IDs still work:

```bash
BENCH_PROFILE_IDS="BaseLayer-Mew-firecracker-headless-shell" npm run bench:latency
BENCH_PROFILE_IDS="profile-c-firecracker-snapshot" npm run bench:latency
```

When reporting new benchmark results, put the public profile ID first and
include the legacy alias only if it helps connect to an older result document.
