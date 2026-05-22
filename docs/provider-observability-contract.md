# Provider Observability Contract

BaseLayer exposes provider-facing observability as control-plane data, not as runtime orchestration state.

This is intended to support:

- internal dashboards
- partner-facing debugging surfaces
- SDK support tooling
- session audit and quality reporting

## Public Observability Endpoints

- `GET /v1/sessions/:sessionId/metrics`
  - current per-session summary
  - launch timings
  - control-plane timings
  - current resource usage snapshot
  - terminal result when available

- `GET /v1/sessions/:sessionId/events`
  - bounded event stream for the session
  - lifecycle changes
  - activity-state changes
  - metric snapshot updates

- `GET /v1/sessions/:sessionId/logs`
  - recent log snapshot for the session
  - live sessions try to read directly from the node agent
  - terminated sessions return the last persisted log capture

- `GET /v1/sessions/:sessionId/artifacts`
  - provider-facing artifact summary
  - current connection URLs
  - dashboard and logs links
  - placeholders for live view, recording, trace, and netlog

- `POST /v1/sessions/:sessionId/activity`
  - provider-owned activity hint
  - lets the upstream scheduler mark active versus idle phases
  - intended for provider orchestration loops and fluid-compute experiments

- `GET /dashboard/convex-export`
  - one-shot export payload for dashboard consumers
  - includes `sessions`, `metrics`, and `events`

- `GET /dashboard`
  - lightweight built-in operator page
  - reads from `/dashboard/convex-export`
  - useful as a reference view before moving the same payload into Convex

## Session Metadata

The control plane accepts and persists provider-facing metadata on `POST /v1/sessions`:

- `runtimeProfile`
- `region`
- `proxyProfile`
- `provider`
- `sessionTags`

These are passthrough control-plane fields today. They allow upstream providers to attach their own routing, tenancy, and workload context without exposing BaseLayer internals to end customers.

## Metrics Shape

Per-session metrics are intentionally summary-oriented:

- session identity and status
- runtime kind / profile / region
- launch timings
- control-plane timings:
  - request validation
  - scheduler selection
  - node-agent create
  - persistence
  - response build
- latest usage snapshot:
  - memory
  - CPU
  - renderer count
  - `/dev/shm`
  - activity state
  - scheduler weight
- terminal result:
  - exit reason
  - crash flag

This is the level of data another browser platform can use for:

- customer support
- partner dashboards
- internal billing or quality scoring
- debugging slow or failed sessions

## Request Timing Headers

Create and delete responses also emit `Server-Timing` headers so an upstream provider can measure control-plane work without fetching the session again.

Current create-stage header segments:

- `cp_total`
- `cp_validate`
- `cp_sched`
- `cp_agent`
- `cp_persist`
- `cp_build`

Current delete-stage header segments depend on delete mode:

- async:
  - `cp_delete_total`
  - `cp_delete_persist`
  - `cp_delete_async`
- sync:
  - `cp_delete_total`
  - `cp_delete_remote`
  - `cp_delete_persist`

## Event Types

Current session events:

- `session-created`
- `session-status-updated`
- `session-activity-updated`
- `session-exit-reason-set`
- `session-metrics-updated`

The event stream is bounded per session and is meant for auditability and dashboard timelines, not as a high-frequency metrics transport.

## Out of Scope

This contract intentionally does not expose raw host heartbeats as the partner-facing primary surface.

Host-global scheduler state, internal capacity heuristics, and Firecracker-specific internals should remain internal unless a specific partner integration requires them.
