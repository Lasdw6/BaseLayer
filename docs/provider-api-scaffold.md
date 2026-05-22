# Provider API Scaffold

Current scaffold status for the provider-facing BaseLayer API.

This is the thin public layer over the existing control-plane. It is intended for partner-style integrations and internal routing tests, not for end-customer UI work.

## What Exists

- versioned provider routes under `/v1`
- config-backed host allowlist in `config/provider-hosts.json`
- config-backed partner API key auth in `config/provider-api-keys.json`
- registration gating for node agents
- region-aware host preference
- runtime-profile host filtering
- fleet/session summary route for operator checks

## Public Routes

- `GET /v1/health`
- `GET /v1/hosts`
- `GET /v1/stats`
- `GET /v1/sessions`
- `GET /v1/sessions/:sessionId`
- `GET /v1/sessions/:sessionId/metrics`
- `GET /v1/sessions/:sessionId/events`
- `GET /v1/sessions/:sessionId/logs`
- `GET /v1/sessions/:sessionId/artifacts`
- `POST /v1/sessions/:sessionId/activity`
- `POST /v1/sessions`
- `DELETE /v1/sessions/:sessionId`

The legacy `/sessions` routes still exist for internal/admin use, but the control-plane can now run in public `/v1`-only mode with:

- `CONTROL_PLANE_PUBLIC_V1_ONLY=1`

In that mode, legacy routes, dashboard routes, and internal routes return `404` from the same listener.

When partner auth is enabled or partner keys are configured, `/v1` expects either:

- `Authorization: Bearer <api-key>`, or
- `X-BaseLayer-API-Key: <api-key>`

`POST /v1/sessions` and `DELETE /v1/sessions/:sessionId` now also support:

- `Idempotency-Key: <opaque-key>`

for persistent replay protection scoped to the partner key and route.

The provider create path now also has an explicit remote-create timeout policy:

- `CONTROL_PLANE_REMOTE_CREATE_TIMEOUT_MS` (default `45000`)
- `CONTROL_PLANE_REMOTE_CREATE_RETRIES` (default `1`)

If the selected node-agent does not answer in time, the control-plane now fails
the provider create with `504` instead of leaving the request hanging.

## Timing Visibility

The `/v1` create and delete path now surfaces control-plane timing in two forms:

- persisted `controlPlaneTimings` on the session record and metrics payload
- `Server-Timing` headers on `POST /v1/sessions` and `DELETE /v1/sessions/:sessionId`

Create currently breaks out:

- request validation
- scheduler selection
- node-agent create
- persistence
- response build

This is intended to answer the practical provider question: "Did the time go into BaseLayer control-plane work, the node-agent/runtime path, or the network/client side?"

## Provider-Owned Session Metadata

Session create accepts an optional `provider` object for the upstream platform, not the end customer.

Fields:

- `upstreamProvider`
- `providerSessionId`
- `tenantId`
- `projectId`
- `workflowId`
- `workloadClass`

This metadata is persisted on the control-plane session record and returned through the session and metrics endpoints so the upstream provider can correlate BaseLayer sessions with its own jobs and dashboards.

If partner auth is scoped, the control plane can inject or enforce:

- `tenantId`
- `projectId`
- `upstreamProvider`

on `POST /v1/sessions`.

## Host Allowlist

Provider hosts are loaded from `config/provider-hosts.json` by default. Start from
[`config/provider-hosts.example.json`](../config/provider-hosts.example.json) for local
configuration.

Behavior:

- if the file is empty or missing and `CONTROL_PLANE_ENFORCE_HOST_ALLOWLIST=0`, any registering host is accepted
- if the file contains entries, registration is effectively allowlisted
- if `enabled=false`, the host can stay in config but will not be scheduled

Each host entry can override or enrich the node-agent registration with:

- `hostId`
- `apiUrl`
- `region`
- `mode`
- `instanceType`
- `enabled`
- `labels`
- `supportedRuntimeProfiles`

Partner API keys are loaded from `config/provider-api-keys.json` by default. Start from
[`config/provider-api-keys.example.json`](../config/provider-api-keys.example.json) and
keep the real file out of Git.

Current key scope supports:

- `tenantId`
- `projectId`
- `upstreamProvider`
- `allowedRegions`
- `allowedRuntimeProfiles`

## Required Node-Agent Metadata

The scaffold expects future provider hosts to set:

- `NODE_AGENT_HOST_ID`
- `NODE_AGENT_PUBLIC_API_URL`
- `BASELAYER_REGION`
- `BASELAYER_INSTANCE_TYPE`
- `BASELAYER_HOST_LABELS`
- `BASELAYER_SUPPORTED_RUNTIME_PROFILES`

Example:

```bash
export CONTROL_PLANE_URL="http://127.0.0.1:3000"
export NODE_AGENT_HOST_ID="use2-metal-1"
export NODE_AGENT_PUBLIC_API_URL="http://10.0.0.24:4000"
export BASELAYER_REGION="us-east-2"
export BASELAYER_INSTANCE_TYPE="m5zn.metal"
export BASELAYER_HOST_LABELS='{"provider":"aws","role":"provider-host"}'
export BASELAYER_SUPPORTED_RUNTIME_PROFILES="baselayer-firecracker-headless-shell,baselayer-firecracker-headless-shell-startup-prune"
npm run dev:agent
```

## Scheduling Behavior

Session create uses the existing control-plane scheduler with three provider-oriented additions:

1. If a request includes `region`, same-region hosts are preferred when any are eligible.
2. If a request includes `runtimeProfile`, hosts that advertise supported runtime profiles are filtered accordingly.
3. If multiple eligible hosts remain for that `runtimeProfile`, hosts reporting matching warm-ready capacity are preferred before the normal headroom score.

If no eligible host remains, the API returns `503`.

As of 2026-04-22, the control plane also keeps a short-lived host-create reservation in the shared store while a `/v1/sessions` create is in flight:

- reservations are visible in the effective host view used by scheduling
- reservations immediately consume advertised `activeSessions`
- Firecracker reservations also consume advertised warm-ready count when the scheduler expected a warm borrow
- `/v1/hosts` now reads that same effective host view, so partner-visible host capacity is less dependent on the next heartbeat alone

The first explicit warm-capacity signals now flow through host heartbeats as:

- `metrics.warmPools[]`
- `metrics.coldAdmitRemaining`

This is intentionally conservative in the current implementation:

- warm readiness is only reported when the host is configured with exactly one supported runtime profile
- that keeps the contract honest until real runtime-profile-keyed host-local warm pools are implemented

As of 2026-04-22, the first real host-local Firecracker warm pool exists for the narrow default lane:

- Firecracker mode only
- exactly one supported runtime profile on the host
- node-agent-owned local pool
- warm borrow on launch with cold restore fallback if the warm claim fails

This is still an intentionally conservative first implementation, not a generalized pool manager.

## Session Search

`GET /v1/sessions` currently supports:

- `status`
- `limit`
- `providerSessionId`
- `workflowId`
- `tenantId`
- `projectId`
- `upstreamProvider`
- `runtimeProfile`
- `region`

When partner auth is scoped, results are further constrained to the key's tenant/project/provider scope.

## Provider Activity Hints

`POST /v1/sessions/:sessionId/activity` lets the upstream provider hint whether a session is:

- `active-navigation`
- `interactive-idle`
- `soak-idle`

This exists for provider orchestration loops and fluid-compute experiments. BaseLayer should not expect the provider's customer SDK to call this directly.

## Basic Local Smoke Test

1. Start the control-plane.
2. Keep the sample host entry in `config/provider-hosts.json`, or replace it with the host you want to test.
3. Start a node-agent with matching `NODE_AGENT_HOST_ID` and `NODE_AGENT_PUBLIC_API_URL`.
4. Create a session through `/v1/sessions`.
5. Verify `/v1/hosts`, `/v1/sessions/:id/artifacts`, and `/v1/sessions/:id/logs`.
6. Delete the session with `DELETE /v1/sessions/:id`.

## Latest Validation

The scaffold is now validated on both:

- a generic managed-host proof (`t3.large`, cold container path), and
- the optimized Firecracker path on AWS `m5zn.metal`.

The latest cloud hardening pass is documented in [provider-api-cloud-validation-2026-04-21.md](./provider-api-cloud-validation-2026-04-21.md).

That run confirmed all of the new partner-surface behaviors on a real AWS VM:

- partner auth
- `/v1`-only public listener behavior
- persistent create/delete idempotency
- real CDP connect and external navigation through `/v1`

It also exposed one real architectural issue:

- when internal and public listeners run as separate processes against the same file-backed store, host registrations are stale until the second process reloads or restarts

That follow-up is now implemented locally in `ControlPlaneStore`:

- reads refresh from disk when the shared state file changes
- writes acquire a small file lock, reload the latest file state, then persist atomically

That is enough for the current small control-plane design. It is not a database replacement, but it removes the specific stale-read bug found during the cloud validation.

The next paid cloud rerun is now also complete: [provider-api-firecracker-warm-validation-2026-04-22.md](./provider-api-firecracker-warm-validation-2026-04-22.md).

That run validated the new warm-pool lane on a real Firecracker host with split public/internal listeners:

- the public `/v1` listener saw host registration written by the internal listener without a restart
- the host allowlist was enforced with a real host-specific entry
- the first provider create on `baselayer-firecracker-headless-shell` was a real warm borrow:
  - control-plane total about `39 ms`
  - node-agent create about `36 ms`
  - `launchTimings.totalMs = 0`
- idempotent replay still worked on both create and delete

It also surfaced two operational follow-ups:

- sample `config/provider-hosts.json` content can block real node-agent registration until replaced with the actual host id
- provider-host prep paths that run `bootstrap-firecracker-linux.sh` under `sudo` need to restore repo ownership before the next `npm ci`

That ownership issue is now patched in:

- `scripts/bench/adhoc/prepare-basic-profiles-host.sh`
- `scripts/bench/adhoc/aws-bootstrap-provider-api.sh`

One final local follow-up landed after that rerun:

- node-agent now sends an immediate heartbeat after launch
- node-agent now sends an immediate heartbeat after termination
- node-agent now sends an immediate heartbeat after warm-pool maintenance

That follow-up is now revalidated on a paid cloud host in
[provider-api-firecracker-heartbeat-validation-2026-04-22.md](./provider-api-firecracker-heartbeat-validation-2026-04-22.md):

- `/v1/hosts` reflected the warm borrow within `255 ms`
- `/v1/hosts` reflected the host back at `warmReadyCount = 1` within `758 ms`

Latest optimized provider/API result:

- `baselayer-firecracker-headless-shell`
- real Google
- `domcontentloaded`
- direct same-region provider path p50 about `850 ms`
- same-runner BrowserArena sequential p50 about `725 ms`

The detailed write-up and artifacts are in [provider-api-firecracker-validation-2026-04-21.md](./provider-api-firecracker-validation-2026-04-21.md).

The provider create path also now records warm-path expectation vs. outcome in `controlPlaneTimings.create`:

- `warmExpected`
- `warmActual`
- `warmMismatch`

This exists specifically to detect the class of bug where the scheduler routed to a host because it looked warm, but the actual node-agent create fell back to a cold path.

Taken together, the current provider substrate phase is now closed for its
intended scope:

- split public/internal listeners
- partner auth/idempotency/scoped search
- store abstraction
- host-create reservations
- warm-aware scheduling
- first host-local Firecracker warm pool
- explicit remote-create timeout policy
- paid cloud validation of immediate warm borrow/refill visibility

Additional local scaffold validation completed on 2026-04-21:

- partner auth still gates `/v1`
- invalid `limit` now returns `400`
- `/v1/hosts` no longer dumps the full configured allowlist
- `CONTROL_PLANE_PUBLIC_V1_ONLY=1` correctly made `/health` return `404` while authenticated `/v1/health` still returned `ok=true`

## Next Work

- per-host admin update route instead of file-only allowlist changes
- more explicit provider metrics and billing/export surfaces
- regional host pools and autoscaling hooks
