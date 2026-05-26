# Firecracker Scaling Analysis

## Scope

This note summarizes the verified Firecracker benchmark runs completed on April 6, 2026.

What was completed:
- Firecracker snapshot proof on GCP nested virtualization
- Firecracker integrated into the normal node-agent/session lifecycle
- Firecracker density runs on `n2-standard-8`
- Firecracker density runs on `n2-custom-12-49152` as the fallback larger host
- restore-step timing instrumentation
- lifecycle cleanup fixes for stale microVMs, sockets, state dirs, and API-driven teardown

What was not completed exactly as planned:
- the original `n2-standard-16` run

Reason:
- GCP project quota blocked creation of a `16 vCPU` instance
- error: `CPUS_ALL_REGIONS exceeded; limit = 12 globally`
- `n2-standard-12` was not available in `us-central1-a`
- fallback used instead: `n2-custom-12-49152`

## Environments

### Host A

- GCP `n2-standard-8`
- `8 vCPU`
- `32 GB RAM`
- Ubuntu `22.04`
- nested virtualization enabled

### Host B

- GCP `n2-custom-12-49152`
- `12 vCPU`
- `48 GB RAM`
- Ubuntu `22.04`
- nested virtualization enabled

### Shared Guest / Benchmark Shape

- Firecracker microVM
- `chromium-headless-shell`
- per-session snapshot restore
- fixed guest IP inside the snapshot, isolated via per-microVM host network namespaces
- deterministic local benchmark site
- mixed active/idle soak
- `5s` soak window
- active session ratio `0.5`
- `2` active rounds per active session

## Snapshot Proof

| Metric | Result |
|---|---:|
| Cold boot to CDP-ready | `6905.9 ms` |
| Restore success rate | `3/3` |
| Restore avg | `130.5 ms` |
| Restore p50 | `130.1 ms` |
| Restore p95 | `133.8 ms` |

Interpretation:
- snapshot restore is materially faster than cold boot
- the Phase 1 proof succeeded

## Density Results: Host A vs Host B

| Concurrency | Host A Create | Host A Navigate | Host A Peak Tracked Memory | Host A Pressure | Host B Create | Host B Navigate | Host B Peak Tracked Memory | Host B Pressure |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `c4` | `703.59 ms` | `1410.38 ms` | `4096 MB` | `10%` | `617.13 ms` | `1133.14 ms` | `4096 MB` | `3%` |
| `c8` | `1239.05 ms` | `2775.05 ms` | `8192 MB` | `20%` | `1002.26 ms` | `2442.80 ms` | `8192 MB` | `4%` |
| `c12` | `1655.47 ms` | `4294.87 ms` | `12288 MB` | `40%` | `1310.61 ms` | `3774.02 ms` | `12288 MB` | `5%` |
| `c16` | `2198.32 ms` | `5229.06 ms` | `16384 MB` | `9%` | `1652.00 ms` | `4998.05 ms` | `16384 MB` | `6%` |
| `c20` | `2960.01 ms` | `6643.44 ms` | `20480 MB` | `10%` | `2017.45 ms` | `6165.95 ms` | `20480 MB` | `6%` |
| `c24` | `3508.72 ms` | `8095.01 ms` | `24576 MB` | `11%` | `2616.07 ms` | `7062.94 ms` | `24576 MB` | `7%` |

Success summary:
- Host A: `100%` create success, `100%` initial navigation success, `0` soak failures through `c24`
- Host B: `100%` create success, `100%` initial navigation success, `0` soak failures through `c24`

## Scaling Takeaways

### 1. The larger host helps at every tested concurrency

Host B outperformed Host A on both launch and navigation at every verified level.

Representative gaps:
- `c24`
  - Host A: `3508.72 ms` create, `8095.01 ms` navigate
  - Host B: `2616.07 ms` create, `7062.94 ms` navigate
- `c16`
  - Host A: `2198.32 ms` create, `5229.06 ms` navigate
  - Host B: `1652.00 ms` create, `4998.05 ms` navigate
- `c12`
  - Host A: `1655.47 ms` create, `4294.87 ms` navigate
  - Host B: `1310.61 ms` create, `3774.02 ms` navigate

Interpretation:
- restore cost benefits from additional host CPU headroom
- steady-state browsing work also benefits, but less dramatically than launch

### 2. Launch path scales better than navigation path

Host A create latency rises from roughly:
- `0.70s` at `c4`
- `1.24s` at `c8`
- `1.66s` at `c12`
- `3.51s` at `c24`

Host A navigation rises more sharply:
- `1.41s` at `c4`
- `2.78s` at `c8`
- `4.29s` at `c12`
- `8.10s` at `c24`

Host B shows the same shape:
- create: `0.62s` to `2.62s`
- navigate: `1.13s` to `7.06s`

Interpretation:
- snapshot restore is working
- launch cost is no longer dominated by browser cold start
- under higher concurrency, steady-state page work becomes the dominant pain point sooner than the restore path

### 3. Snapshot load itself is not the bottleneck

Representative clean restore timing breakdown from the integrated session path:

| Step | Time |
|---|---:|
| Network setup | `195.99 ms` |
| Firecracker process spawn + API socket ready | `104.16 ms` |
| Snapshot load/configure call | `10.84 ms` |
| Relay ready | `0.47 ms` |
| CDP ready wait | `113.98 ms` |
| Total | `438.43 ms` |

Another clean run from the same host:

| Step | Time |
|---|---:|
| Network setup | `234.71 ms` |
| Firecracker process spawn + API socket ready | `105.50 ms` |
| Snapshot load/configure call | `6.48 ms` |
| Relay ready | `0.20 ms` |
| CDP ready wait | `140.55 ms` |
| Total | `501.50 ms` |

Interpretation:
- snapshot load/configure is already tiny
- the main restore overhead is infrastructure around the VM, not restoring guest memory

### 4. Memory is not the first hard ceiling

At `c24`:
- Host A tracked guest allocation reached `24576 MB`
- Host B tracked guest allocation reached `24576 MB`
- both hosts still had `100%` create and navigation success
- both had `0` soak failures

Interpretation:
- the current admission model is safe
- the visible next limit is CPU/render contention, not immediate memory exhaustion

One caution:
- `trackedMemoryMb` is reserved guest allocation, not actual host RSS per microVM
- the pressure numbers are real host-level readings, so the mismatch is expected

## Bottlenecks To Improve Next

### 1. Host network setup overhead

Evidence:
- network setup is the largest single restore step at about `196-235 ms`

Possible improvements:
- pre-create and recycle net namespaces
- pre-create tap/veth pairs instead of constructing them per session
- move from ad hoc per-session setup toward a pool of prepared host-side networking slots

Expected impact:
- largest likely reduction in restore time

### 2. Firecracker process startup overhead

Evidence:
- Firecracker spawn/API socket bring-up is about `104-105 ms`

Possible improvements:
- reduce wrapper overhead around privileged spawn
- examine jailer vs direct spawn tradeoffs
- keep host-side Firecracker invocation path lean and stable

Expected impact:
- meaningful but smaller than networking

### 3. CDP-ready wait

Evidence:
- CDP readiness contributes about `114-141 ms`

Possible improvements:
- make the guest snapshot even more post-browser-ready
- reduce work between guest resume and DevTools readiness
- benchmark whether a slightly later snapshot point reduces CDP-ready time without introducing stale state risk

Expected impact:
- medium

### 4. CPU/render contention at higher concurrency

Evidence:
- navigation latency degrades much faster than create latency as concurrency rises
- larger host CPU helps, but does not flatten the navigation curve

Possible improvements:
- test `1 vCPU` guests instead of `2 vCPU`
- trim guest browser workload and background services further
- add host CPU pressure to admission in addition to VM count and reserved memory
- evaluate whether smaller guest memory footprints reduce host scheduling overhead

Expected impact:
- better throughput and better tail latency under load

## Implementation Holes And Limitations

### 1. Guest memory accounting is still coarse

Current behavior:
- `trackedMemoryMb` is reserved guest memory budget
- it is not a precise measurement of actual resident host RSS for each microVM

Why this matters:
- admission is safe, but still conservative and model-based rather than truly measured

Needed improvement:
- add real host RSS accounting per Firecracker process tree and compare it to reserved guest memory

### 2. Control-plane disconnect handling is still weak

Observed in logs:
- when the control plane was restarted, the node agent logged repeated `fetch failed` errors for session updates and heartbeats

Why this matters:
- control-plane restarts should degrade gracefully

Needed improvement:
- add retry/backoff and reconciliation after control-plane unavailability

### 3. Cleanup required explicit hardening

Previous issue:
- interrupted runs could leave stale Firecracker processes behind

Current state:
- fixed via startup reconciliation and stronger destroy logic
- verified that API-driven delete now returns the host to zero Firecracker processes, zero sockets, and zero state entries

Remaining caution:
- this should still be stress-tested under repeated interrupted benchmark runs

### 4. The larger-host comparison is a fallback, not the original target

Current state:
- the second host data is useful and real
- but it came from `n2-custom-12-49152`, not `n2-standard-16`

Why this matters:
- it proves scaling with more host resources
- it does not answer the exact original `n2-standard-16` question

## Bottom Line

The Firecracker path now has four strong properties:
- snapshot restore is real and fast
- integrated session lifecycle works through the normal control plane
- cleanup behaves correctly on the normal API flow
- scaling improves with a larger host in the expected direction

The current bottleneck is not snapshot restore.
It is the host-side work around restore, especially:
- network namespace and tap setup
- Firecracker process bring-up
- then, at higher concurrency, CPU/render contention during actual page work

That is a good outcome for the thesis:
- the hard question was whether snapshot restore could beat cold boot and remain useful under concurrency
- that is now answered positively
- the next optimization work should go into per-session host overhead and high-concurrency execution efficiency

## Fluid Compute Status

A later `fluid5` comparison was run as a separate experiment against the same Firecracker baseline.

Valid artifacts:
- `fluid5-c24-baseline.json`
- `fluid5-c12-always.json`
- `fluid5-c24-always.json`
- `fluid5-c12-hybrid.json`
- `fluid5-c24-hybrid.json`

One earlier artifact should not be used for comparison:
- `fluid5-c12-baseline.json`
  - this was produced before the 5-minute benchmark timeout bug was fixed
  - it has `12/12` creates but `0/12` navigations due to the old timeout condition

Current result:
- at `c24`, baseline still has the best launch latency
- `always` and `hybrid` both slightly improve steady-state navigation
- but both make create latency worse than baseline

Representative `c24` comparison:

| Policy | Create | Navigate | Launch Total | CDP Ready |
|---|---:|---:|---:|---:|
| baseline | `1415.95 ms` | `7184.91 ms` | `1308.75 ms` | `220.56 ms` |
| always | `1735.45 ms` | `6997.81 ms` | `1613.79 ms` | `251.75 ms` |
| hybrid | `1677.67 ms` | `7020.41 ms` | `1564.78 ms` | `243.04 ms` |

Conclusion:
- fluid-compute remains experimental
- baseline Firecracker is still the main runtime policy
