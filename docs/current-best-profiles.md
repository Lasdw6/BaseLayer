# Current Best Profiles

This file is the public snapshot of BaseLayer's maintained benchmark profiles.
Older internal codenames still resolve as compatibility aliases, but new docs
and commands should use the descriptive public IDs below.

## Maintained Profiles

| Profile | Status | Best public result | Notes |
| --- | --- | --- | --- |
| `baselayer-firecracker-headless-shell` | main | `331-332 ms` p50 lifecycle on self-hosted BrowserArena-stage `example.com` c1 x100 replication; best row `99/100`, create `158.6 ms`, connect `22.6 ms`, goto `103.2 ms`, release `24.9 ms`, lifecycle `331.1 ms`. Concurrent c10 x10 validation: `100/100`, lifecycle `651.7 ms`. | Default Firecracker + `chromium-headless-shell` lane for latency-style runs. Uses async API release with delayed node-agent teardown. |
| `baselayer-firecracker-full-chromium` | experimental | Historical Google-target provider-path row: `100/100`, create `96 ms`, connect `61 ms`, goto `619 ms`, release `10 ms`, lifecycle `784 ms`. | Compatibility-heavy lane. Not the current headline result. |
| `baselayer-managed-node` | active | Local and managed-node benchmark support is available through the in-repo harness. | Non-Firecracker browser-aware host runtime. |
| `baselayer-container-generic` | reference | Local baseline profile for comparing generic container-per-session behavior. | Useful for regression checks, not a headline profile. |

See [browserarena-results.md](./browserarena-results.md) for the BrowserArena
methodology snapshot and [profile-naming-system.md](./profile-naming-system.md)
for legacy alias mapping.

## Default Recommendation

- Use `baselayer-firecracker-headless-shell` for the main public benchmark path.
- Use `https://example.com/` and `waitUntil: "domcontentloaded"` for current BrowserArena-methodology comparisons.
- Use async release for latency-style runs.
- Treat Google-target rows as historical only.
- Treat full Chromium, custom shell, Lightpanda, fluid compute, and kernel-flag variants as experimental lanes unless a future public result promotes them.
