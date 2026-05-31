# BrowserArena-Style c1 x100 Final Rerun (2026-05-31)

This directory contains the five live-demo sequential artifacts used for the current BaseLayer self-hosted c1 number.

## Setup

- Runner: AWS `t3.micro`, `us-east-2`
- Provider host: AWS `m5zn.metal`, `us-east-2`
- Runtime: Firecracker + `chromium-headless-shell` snapshot restore
- Target: `http://example.com`
- Wait condition: `domcontentloaded`
- Shape: `c1 x100`, repeated 5 times
- Delete semantics: async release

## Average p50 Across Five Runs

| Metric | Average p50 |
|---|---:|
| Lifecycle | **211.4 ms** |
| Session create | 90.3 ms |
| CDP connect | 39.5 ms |
| page.goto | 83.0 ms |
| Session release | 11.5 ms |

Success: **498/500** iterations across 5 runs.

## Per-Run Results

| Artifact | Success | Lifecycle p50 | Create | Connect | Goto | Release |
|---|---:|---:|---:|---:|---:|---:|
| [baselayer-browserarena-live-1780266872992.json](./baselayer-browserarena-live-1780266872992.json) | 100/100 | 209.0 ms | 90.5 ms | 19.4 ms | 83.1 ms | 11.7 ms |
| [baselayer-browserarena-live-1780266925633.json](./baselayer-browserarena-live-1780266925633.json) | 99/100 | 213.6 ms | 90.4 ms | 54.5 ms | 82.8 ms | 11.6 ms |
| [baselayer-browserarena-live-1780266989299.json](./baselayer-browserarena-live-1780266989299.json) | 99/100 | 213.2 ms | 90.3 ms | 54.4 ms | 82.6 ms | 11.3 ms |
| [baselayer-browserarena-live-1780267052917.json](./baselayer-browserarena-live-1780267052917.json) | 100/100 | 209.5 ms | 90.3 ms | 18.9 ms | 83.7 ms | 11.6 ms |
| [baselayer-browserarena-live-1780267105128.json](./baselayer-browserarena-live-1780267105128.json) | 100/100 | 211.8 ms | 90.0 ms | 50.5 ms | 82.7 ms | 11.2 ms |

## Failures

The two failed iterations were create-path Firecracker CDP-readiness timeouts, not navigation failures.

- baselayer-browserarena-live-1780266925633.json, wave 1: session-create failed: 502 {"error":"Node agent failed to create a session on host ip-172-31-28-55: 503 {\"error\":\"Timed out during Firecracker restore phase 'cdp-version' for session 01983390-0368-48d0-ab27-92081d3f7ae1.\"}"}
- baselayer-browserarena-live-1780266989299.json, wave 4: session-create failed: 502 {"error":"Node agent failed to create a session on host ip-172-31-28-55: 503 {\"error\":\"Timed out during Firecracker restore phase 'cdp-target-list' for session d564dc0f-209e-40f1-88d0-7b4a166701d4.\"}"}
