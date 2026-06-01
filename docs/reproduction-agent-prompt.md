# Reproduction Agent Prompt

Copy this prompt into a coding agent when you want help reproducing the
BaseLayer BrowserArena-style benchmark on fresh AWS hosts.

```text
You are helping me reproduce the BaseLayer BrowserArena-style benchmark from
the public BaseLayer repo.

Goal:
- Run the BaseLayer self-hosted BrowserArena-style c1 x100 benchmark.
- Use one AWS t3.micro runner and one AWS m5zn.metal provider host.
- Target http://example.com with waitUntil=domcontentloaded.
- Report the BrowserArena-style lifecycle number as:
  p50(session create) + p50(CDP connect) + p50(page.goto) + p50(session release)
  over successful iterations. Do not use raw p50(total_ms) as the headline.

Repo:
- https://github.com/Lasdw6/BaseLayer

Expected topology:
- Runner: AWS t3.micro, same region/AZ as possible.
- Provider host: AWS m5zn.metal with Linux/KVM.
- Provider API exposed at http://<provider-host>:3000/v1.
- CDP relay ports must be reachable from the runner.

Before running the benchmark, verify setup end to end:
1. The repo exists on both machines at /home/ubuntu/baselayer.
2. Node and npm are installed on both machines.
3. npm dependencies are installed.
4. TypeScript build succeeds.
5. Firecracker kernel and rootfs exist on the provider host.
6. config/provider-hosts.json allowlists the actual provider host ID/hostname.
7. The provider services start and /v1/health reports one healthy host.
8. A smoke session succeeds:
   - POST /v1/sessions returns 201.
   - The returned debugHttpUrl is reachable from the runner.
   - /json/version returns 200.
   - DELETE /v1/sessions/:id returns 204.

Important gotchas:
- Provisioning scripts only create machines; they do not by themselves upload
  the repo, bootstrap dependencies, generate the allowlist, start services, and
  run a smoke test.
- The node-agent must return CDP URLs using the provider host's public IP when
  the runner is remote.
- The node-agent's internal CDP readiness probe should use localhost or the
  relay probe host, not the provider host's public IP.
- If sessions create but Playwright fails with ECONNREFUSED, check that the
  returned CDP URL is not localhost and that the runner can reach the relay port.
- If registration fails with "Host is not allowlisted", update
  config/provider-hosts.json for the actual fresh host ID/hostname or disable
  allowlist enforcement for the local benchmark.
- If repeated runs get slower, check for accumulated local state/artifacts and
  prune retained terminal/session state before comparing numbers.

Benchmark command shape:

export BASELAYER_API_URL="http://<provider-host>:3000/v1"
export BASELAYER_RUNTIME_PROFILE="baselayer-firecracker-headless-shell"
export BENCH_BROWSERARENA_PAGE_URL="http://example.com/"
export BENCH_PAGE_GOTO_WAIT_UNTIL="domcontentloaded"
export BENCH_CONNECT_RETRY_BUDGET_MS=15000
export BENCH_RUNS=100
export BENCH_CONCURRENCY=1
export BENCH_OUT="$PWD/data/benchmarks/provider-api-example-c1x100.json"

npm run bench:provider-api

After the run:
- Confirm success count.
- Compute/report the stage-p50 sum.
- Keep raw total_ms.p50 only as an audit/debug metric.
- Save the artifact and note host type, region, date, target URL, wait condition,
  concurrency, and run count.
```

