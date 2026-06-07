import crypto from "node:crypto";

import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";

import { agentConfig, controlPlaneConfig } from "../shared/config.js";
import { log, logError } from "../shared/logging.js";
import { expiresAtFromNow } from "../shared/time.js";
import {
  createSessionRequestSchema,
  createSessionResultSchema,
  dashboardExportSchema,
  hostHeartbeatSchema,
  hostRegistrationSchema,
  hostRecordSchema,
  sessionActivityStateSchema,
  sessionArtifactsSummarySchema,
  sessionLogSnapshotSchema,
  sessionMetricsSummarySchema,
  type ProviderEventData,
  type SessionActivityState,
  type SessionEventRecord,
  type SessionLogSnapshot,
  type SessionMetricsSummary,
  type HostRecord,
  type SessionRecord,
} from "../shared/types.js";
import {
  createRemoteSession,
  deleteRemoteSession,
  fetchRemoteSessionLogs,
  markRemoteSessionActivity,
  RemoteSessionCreateError,
} from "./client.js";
import {
  applyPartnerScopeToCreateRequest,
  canPartnerAccessSession,
  filterHostsForPartner,
  filterSessionsForPartner,
  ProviderApiKeyStore,
  type PartnerAuthContext,
} from "./provider-auth.js";
import { ProviderHostAllowlist } from "./provider-hosts.js";
import { SchedulerError } from "./scheduler.js";
import { createControlPlaneStore } from "./store.js";
import type { ControlPlaneSessionQuery } from "./store-contract.js";

const fastify = Fastify({ logger: false });
const store = createControlPlaneStore(controlPlaneConfig.statePath);
const hostAllowlist = ProviderHostAllowlist.load(
  controlPlaneConfig.providerHostConfigPath,
  controlPlaneConfig.enforceProviderHostAllowlist,
);
const partnerAuth = ProviderApiKeyStore.load(
  controlPlaneConfig.providerApiKeyConfigPath,
  controlPlaneConfig.enforceProviderApiKeyAuth,
);
const HOST_CREATE_RESERVATION_TTL_MS = Math.max(
  controlPlaneConfig.remoteCreateTimeoutMs + 5_000,
  Math.max(1, 1 + agentConfig.firecrackerRestoreRetries) *
    (agentConfig.firecrackerRestoreTimeoutMs + 10_000) +
    15_000,
);
const HOST_DELETE_RESERVATION_TTL_MS = 15_000;
const SCHEDULER_ADMISSION_WAIT_MS = Number.parseInt(
  process.env["CONTROL_PLANE_SCHEDULER_ADMISSION_WAIT_MS"] ?? "0",
  10,
);
const SCHEDULER_ADMISSION_POLL_MS = Math.max(
  50,
  Number.parseInt(process.env["CONTROL_PLANE_SCHEDULER_ADMISSION_POLL_MS"] ?? "250", 10),
);

declare module "fastify" {
  interface FastifyRequest {
    partnerAuth?: PartnerAuthContext;
  }
}

function authenticatePartnerRequest(
  request: FastifyRequest,
  reply: FastifyReply,
): PartnerAuthContext | undefined {
  if (!request.url.startsWith("/v1")) {
    return undefined;
  }

  if (!partnerAuth.required) {
    return undefined;
  }

  const auth = partnerAuth.authenticate(request.headers);
  if (!auth) {
    reply.header("WWW-Authenticate", 'Bearer realm="baselayer-partner"');
    reply.code(401).send({ error: "Partner authentication required." });
    return undefined;
  }

  return auth;
}

async function sleepMs(durationMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, durationMs));
}

async function reserveHostForCreateWithBackpressure(input: {
  sessionId: string;
  preferredRegion?: string;
  runtimeProfile?: string;
  ttlMs: number;
}): Promise<ReturnType<typeof store.reserveHostForCreate>> {
  const waitMs = Number.isFinite(SCHEDULER_ADMISSION_WAIT_MS)
    ? Math.max(0, SCHEDULER_ADMISSION_WAIT_MS)
    : 0;
  const deadline = Date.now() + waitMs;
  let lastError: SchedulerError | undefined;

  while (true) {
    try {
      return store.reserveHostForCreate(input);
    } catch (error) {
      if (!(error instanceof SchedulerError) || Date.now() >= deadline) {
        throw error;
      }
      lastError = error;
      await sleepMs(Math.min(SCHEDULER_ADMISSION_POLL_MS, Math.max(1, deadline - Date.now())));
    }
  }

  throw lastError ?? new SchedulerError("No host is currently eligible for session admission.");
}

function extractIdempotencyKey(request: FastifyRequest): string | undefined {
  const raw = request.headers["idempotency-key"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function hashIdempotencyPayload(payload: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function buildIdempotencyStorageKey(
  auth: PartnerAuthContext | undefined,
  method: "POST" | "DELETE",
  route: string,
  idempotencyKey: string,
): string {
  return `${auth?.keyId ?? "anonymous"}:${method}:${route}:${idempotencyKey}`;
}

function buildCreateSessionResponse(session: SessionRecord) {
  return createSessionResultSchema.parse({
    sessionId: session.sessionId,
    status: session.status,
    hostId: session.hostId,
    connectUrl: session.connectUrl,
    cdpUrl: session.cdpUrl,
    playwrightUrl: session.playwrightUrl,
    puppeteerUrl: session.puppeteerUrl,
    debugHttpUrl: session.debugHttpUrl,
    expiresAt: session.expiresAt,
    createdAt: session.createdAt,
    runtimeProfile: session.runtimeProfile,
    region: session.region,
    provider: session.provider,
    sessionTags: session.sessionTags,
    launchTimings: session.launchTimings,
    controlPlaneTimings: session.controlPlaneTimings,
  });
}

function replayCreateIdempotency(
  reply: FastifyReply,
  auth: PartnerAuthContext | undefined,
  scopedRequest: ReturnType<typeof applyPartnerScopeToCreateRequest>,
  idempotencyKey: string | undefined,
): SessionRecord | undefined {
  if (!idempotencyKey) {
    return undefined;
  }

  const storageKey = buildIdempotencyStorageKey(auth, "POST", "/v1/sessions", idempotencyKey);
  const requestHash = hashIdempotencyPayload(scopedRequest);
  const existing = store.getIdempotencyRecord(storageKey);
  if (!existing) {
    return undefined;
  }

  if (existing.requestHash !== requestHash) {
    reply.code(409).send({ error: "Idempotency key reused with different request payload." });
    return undefined;
  }

  const session = existing.sessionId ? store.getSession(existing.sessionId) : undefined;
  if (!session) {
    reply.code(409).send({ error: "Idempotent session record is no longer available." });
    return undefined;
  }

  reply.header("Idempotency-Replayed", "true");
  reply.code(existing.responseStatus === 201 ? 200 : existing.responseStatus).send({
    ...buildCreateSessionResponse(session),
    controlPlaneTimings: session.controlPlaneTimings,
  });
  return session;
}

function isTerminalStatus(status: SessionRecord["status"]): boolean {
  return status === "terminated" || status === "failed";
}

function buildSessionMetricsSummary(session: SessionRecord): SessionMetricsSummary {
  return sessionMetricsSummarySchema.parse({
    sessionId: session.sessionId,
    status: session.status,
    browser: session.browser,
    hostId: session.hostId,
    runtimeKind: session.runtimeKind,
    runtimeProfile: session.runtimeProfile,
    region: session.region,
    proxyProfile: session.proxyProfile,
    provider: session.provider,
    sessionTags: session.sessionTags,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    endedAt: session.endedAt,
    launchTimings: session.launchTimings,
    controlPlaneTimings: session.controlPlaneTimings,
    recentLogs: session.recentLogs,
    usage: session.lastKnownMetrics,
    result:
      session.exitReason || isTerminalStatus(session.status)
        ? {
            exitReason: session.exitReason,
            crashed: session.status === "failed",
          }
        : undefined,
  });
}

function appendSessionEvent(
  sessionId: string,
  source: SessionEventRecord["source"],
  type: SessionEventRecord["type"],
  fields: {
    status?: SessionRecord["status"];
    activityState?: SessionActivityState;
    exitReason?: string;
    data?: ProviderEventData;
  } = {},
): SessionEventRecord {
  return store.appendSessionEvent({
    eventId: crypto.randomUUID(),
    sessionId,
    ts: new Date().toISOString(),
    source,
    type,
    status: fields.status,
    activityState: fields.activityState,
    exitReason: fields.exitReason,
    data: fields.data,
  });
}

function buildProviderStats(auth?: PartnerAuthContext) {
  const hosts = filterHostsForPartner(store.listHosts(), auth);
  const sessions = filterSessionsForPartner(store.listSessions(), {}, auth);
  const activeSessions = sessions.filter((session) => session.status === "running");
  const failedSessions = sessions.filter((session) => session.status === "failed");
  const launchValues = activeSessions
    .map((session) => session.launchTimings?.totalMs)
    .filter((value): value is number => typeof value === "number");
  const avgLaunchMs =
    launchValues.length > 0
      ? Math.round(launchValues.reduce((sum, value) => sum + value, 0) / launchValues.length)
      : null;

  return {
    generatedAt: new Date().toISOString(),
    hostCount: hosts.length,
    allowlistedHostCount: hostAllowlist.list().length,
    activeSessions: activeSessions.length,
    failedSessions: failedSessions.length,
    avgLaunchMs,
    healthyHosts: hosts.filter((host) => host.status === "healthy").length,
    degradedHosts: hosts.filter((host) => host.status === "degraded").length,
    drainingHosts: hosts.filter((host) => host.status === "draining").length,
    noAdmitHosts: hosts.filter((host) => host.status === "no-admit").length,
  };
}

function getSessionOrReply(
  sessionId: string,
  reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } },
): SessionRecord | undefined {
  const session = store.getSession(sessionId);
  if (!session) {
    reply.code(404).send({ error: "Session not found." });
    return undefined;
  }

  return session;
}

async function createSessionFromRequest(
  request: FastifyRequest,
  body: unknown,
  reply: FastifyReply,
  auth?: PartnerAuthContext,
) {
  const createStarted = performance.now();
  const parsed = createSessionRequestSchema.safeParse(body);
  const requestValidationMs = performance.now() - createStarted;
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }

  try {
    const scopedRequest = applyPartnerScopeToCreateRequest(parsed.data, auth);
    const idempotencyKey = auth ? extractIdempotencyKey(request) : undefined;
    replayCreateIdempotency(reply, auth, scopedRequest, idempotencyKey);
    if (reply.sent) {
      return;
    }

    const sessionId = crypto.randomUUID();
    const schedulerStarted = performance.now();
    const { host, reservation } = await reserveHostForCreateWithBackpressure({
      sessionId,
      preferredRegion: scopedRequest.region,
      runtimeProfile: scopedRequest.runtimeProfile,
      ttlMs: HOST_CREATE_RESERVATION_TTL_MS,
    });
    const schedulerMs = performance.now() - schedulerStarted;
    const reservationMs = 0;

    const nodeAgentCreateStarted = performance.now();
    let runtime;
    try {
      runtime = await createRemoteSession(host, {
        ...scopedRequest,
        sessionId,
      });
    } catch (error) {
      store.releaseHostCreateReservation(reservation.reservationId);
      throw error;
    }
    const nodeAgentCreateMs = performance.now() - nodeAgentCreateStarted;
    const warmActual = runtime.runtimeKind === "microvm" && runtime.launchTimings?.totalMs === 0;
    const warmMismatch = reservation.warmExpected !== warmActual;
    const idempotencyStorageKey =
      auth && idempotencyKey
        ? buildIdempotencyStorageKey(auth, "POST", "/v1/sessions", idempotencyKey)
        : undefined;

    const recordDraft: SessionRecord = {
      sessionId,
      browser: parsed.data.browser,
      status: "running",
      hostId: host.hostId,
      connectUrl: runtime.connectUrl,
      cdpUrl: runtime.cdpUrl,
      playwrightUrl: runtime.playwrightUrl,
      puppeteerUrl: runtime.puppeteerUrl,
      debugHttpUrl: runtime.debugHttpUrl,
      keepAlive: parsed.data.keepAlive,
      timeoutSec: parsed.data.timeoutSec,
      idleTimeoutSec: parsed.data.idleTimeoutSec,
      proxyProfile: scopedRequest.proxyProfile,
      runtimeProfile: scopedRequest.runtimeProfile,
      region: scopedRequest.region,
      provider: scopedRequest.provider,
      sessionTags: scopedRequest.sessionTags,
      createdAt: runtime.startedAt,
      expiresAt: expiresAtFromNow(parsed.data.timeoutSec),
      containerId: runtime.containerId,
      containerName: runtime.containerName,
      runtimeKind: runtime.runtimeKind,
      launchTimings: runtime.launchTimings,
      controlPlaneTimings: {
        create: {
          totalMs: 0,
          requestValidationMs,
          schedulerMs,
          reservationMs,
          nodeAgentCreateMs,
          persistMs: 0,
          responseBuildMs: 0,
          warmExpected: reservation.warmExpected,
          warmActual,
          warmMismatch,
        },
      },
    };
    const createdEvent: SessionEventRecord = {
      eventId: crypto.randomUUID(),
      sessionId,
      ts: new Date().toISOString(),
      source: "control-plane",
      type: "session-created",
      status: "running",
      data: {
        hostId: recordDraft.hostId,
        runtimeKind: recordDraft.runtimeKind,
        browser: recordDraft.browser,
        keepAlive: recordDraft.keepAlive,
        timeoutSec: recordDraft.timeoutSec,
        idleTimeoutSec: recordDraft.idleTimeoutSec,
        ...(recordDraft.runtimeProfile ? { runtimeProfile: recordDraft.runtimeProfile } : {}),
        ...(recordDraft.region ? { region: recordDraft.region } : {}),
        ...(recordDraft.proxyProfile ? { proxyProfile: recordDraft.proxyProfile } : {}),
        ...(recordDraft.provider?.upstreamProvider
          ? { upstreamProvider: recordDraft.provider.upstreamProvider }
          : {}),
        ...(recordDraft.provider?.providerSessionId
          ? { providerSessionId: recordDraft.provider.providerSessionId }
          : {}),
      },
    };

    const firstWrite = store.commitSessionMutation({
      releaseReservationId: reservation.reservationId,
      session: recordDraft,
      event: createdEvent,
      idempotency:
        auth && idempotencyKey && idempotencyStorageKey
          ? {
              storageKey: idempotencyStorageKey,
              record: {
                scopeKey: auth.keyId,
                idempotencyKey,
                method: "POST",
                route: "/v1/sessions",
                requestHash: hashIdempotencyPayload(scopedRequest),
                sessionId,
                responseStatus: 201,
                createdAt: new Date().toISOString(),
              },
            }
        : undefined,
    });
    const buildSeedRecord: SessionRecord = {
      ...(firstWrite.session ?? recordDraft),
      controlPlaneTimings: {
        ...(firstWrite.session?.controlPlaneTimings ?? recordDraft.controlPlaneTimings),
        create: {
          totalMs: 0,
          requestValidationMs,
          schedulerMs,
          reservationMs,
          nodeAgentCreateMs,
          persistMs: firstWrite.persistMs,
          responseBuildMs: 0,
          warmExpected: reservation.warmExpected,
          warmActual,
          warmMismatch,
        },
      },
    };
    const responseBuildStarted = performance.now();
    buildCreateSessionResponse(buildSeedRecord);
    const responseBuildMs = performance.now() - responseBuildStarted;
    const totalMs = performance.now() - createStarted;
    const finalRecord: SessionRecord = {
      ...buildSeedRecord,
      controlPlaneTimings: {
        ...buildSeedRecord.controlPlaneTimings,
        create: {
          ...buildSeedRecord.controlPlaneTimings!.create!,
          totalMs,
          responseBuildMs,
        },
      },
    };
    const persistedRecord = store.commitSessionMutation({ session: finalRecord }).session ?? finalRecord;
    const responsePayload = {
      ...buildCreateSessionResponse(persistedRecord),
      controlPlaneTimings: persistedRecord.controlPlaneTimings,
    };

    log("control-plane", "session-created", {
      sessionId,
      hostId: host.hostId,
      mode: host.mode,
      controlPlaneCreateMs: totalMs,
      warmExpected: reservation.warmExpected,
      warmActual,
      warmMismatch,
    });

    reply.header(
      "Server-Timing",
      [
        `cp_total;dur=${totalMs.toFixed(1)}`,
        `cp_validate;dur=${requestValidationMs.toFixed(1)}`,
        `cp_sched;dur=${schedulerMs.toFixed(1)}`,
        `cp_reserve;dur=${reservationMs.toFixed(1)}`,
        `cp_agent;dur=${nodeAgentCreateMs.toFixed(1)}`,
        `cp_persist;dur=${firstWrite.persistMs.toFixed(1)}`,
        `cp_build;dur=${responseBuildMs.toFixed(1)}`,
      ].join(", "),
    );
    return reply.code(201).send(responsePayload);
  } catch (error) {
    if (error instanceof SchedulerError) {
      return reply.code(503).send({ error: error.message });
    }
    if (error instanceof RemoteSessionCreateError) {
      if (error.kind === "timeout") {
        return reply.code(504).send({ error: error.message });
      }
      return reply.code(502).send({ error: error.message });
    }
    if (error instanceof Error) {
      if (
        error.message.includes("scope mismatch") ||
        error.message.includes("not allowed for this partner key")
      ) {
        return reply.code(403).send({ error: error.message });
      }
    }

    logError("control-plane", "session-create-failed", error);
    return reply.code(502).send({ error: "Failed to create session." });
  }
}

async function updateSessionActivityFromRequest(
  sessionId: string,
  body: unknown,
  reply: FastifyReply,
) {
  const session = getSessionOrReply(sessionId, reply);
  if (!session) {
    return;
  }

  const parsed = sessionActivityStateSchema.safeParse(
    typeof body === "object" && body !== null ? (body as { activityState?: unknown }).activityState : undefined,
  );
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }

  const host = store.getHost(session.hostId);
  if (!host) {
    return reply.code(409).send({ error: "Assigned host is no longer registered." });
  }

  try {
    await markRemoteSessionActivity(host, sessionId, parsed.data);
    appendSessionEvent(sessionId, "control-plane", "session-activity-updated", {
      status: session.status,
      activityState: parsed.data,
      data: {
        previousActivityState: session.lastKnownMetrics?.activityState ?? null,
        nextActivityState: parsed.data,
        source: "provider-api",
      },
    });
    return reply.code(204).send({});
  } catch (error) {
    logError("control-plane", "session-activity-update-failed", error, { sessionId });
    return reply.code(502).send({ error: "Failed to update session activity." });
  }
}

async function deleteSessionFromRequest(
  request: FastifyRequest,
  sessionId: string,
  reply: FastifyReply,
  auth?: PartnerAuthContext,
) {
  const deleteStarted = performance.now();
  const session = store.getSession(sessionId);
  if (!session) {
    // Provider-facing delete should stay idempotent under async teardown and split listeners.
    // BrowserArena and upstream providers should not see a hard 404 merely because the row
    // disappeared between create-time success and later release.
    return reply.code(204).send();
  }
  if (auth && !canPartnerAccessSession(session, auth)) {
    return reply.code(404).send({ error: "Session not found." });
  }

  const idempotencyKey = auth ? extractIdempotencyKey(request) : undefined;
  if (auth && idempotencyKey) {
    const storageKey = buildIdempotencyStorageKey(auth, "DELETE", `/v1/sessions/${sessionId}`, idempotencyKey);
    const requestHash = hashIdempotencyPayload({ sessionId });
    const existing = store.getIdempotencyRecord(storageKey);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        return reply.code(409).send({ error: "Idempotency key reused with different delete target." });
      }
      reply.header("Idempotency-Replayed", "true");
      return reply.code(204).send();
    }
  }

  if (session.status === "terminated") {
    return reply.code(204).send();
  }

  const host = store.getHost(session.hostId);
  if (!host) {
    return reply.code(409).send({ error: "Assigned host is no longer registered." });
  }

  const asyncDelete = process.env["CONTROL_PLANE_ASYNC_SESSION_DELETE"] !== "0";
  const idempotencyStorageKey =
    auth && idempotencyKey
      ? buildIdempotencyStorageKey(auth, "DELETE", `/v1/sessions/${sessionId}`, idempotencyKey)
      : undefined;
  const deleteEvent: SessionEventRecord = {
    eventId: crypto.randomUUID(),
    sessionId,
    ts: new Date().toISOString(),
    source: "control-plane",
    type: "session-status-updated",
    status: "terminated",
    exitReason: "terminated-by-api",
    data: { previousStatus: session.status, nextStatus: "terminated" },
  };

  let remoteDeleteMs = 0;
  if (!asyncDelete) {
    const remoteDeleteStarted = performance.now();
    await deleteRemoteSession(host, sessionId);
    remoteDeleteMs = performance.now() - remoteDeleteStarted;
  }

  const totalMs = performance.now() - deleteStarted;
  const persistedBase = store.commitSessionMutation({
    addDeleteReservation: asyncDelete
      ? {
          reservationId: crypto.randomUUID(),
          sessionId,
          hostId: host.hostId,
          runtimeKind: session.runtimeKind,
          rendererCount: Math.max(1, session.lastKnownMetrics?.rendererCount ?? 1),
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + HOST_DELETE_RESERVATION_TTL_MS).toISOString(),
        }
      : undefined,
    session: {
      ...session,
      status: "terminated",
      endedAt: session.endedAt ?? new Date().toISOString(),
      exitReason: "terminated-by-api",
      controlPlaneTimings: {
        ...session.controlPlaneTimings,
        delete: {
          totalMs,
          remoteDeleteMs,
          persistMs: 0,
          async: asyncDelete,
        },
      },
    },
    event: deleteEvent,
    idempotency:
      auth && idempotencyKey && idempotencyStorageKey
        ? {
            storageKey: idempotencyStorageKey,
            record: {
              scopeKey: auth.keyId,
              idempotencyKey,
              method: "DELETE",
              route: `/v1/sessions/${sessionId}`,
              requestHash: hashIdempotencyPayload({ sessionId }),
              sessionId,
              responseStatus: 204,
              createdAt: new Date().toISOString(),
            },
          }
        : undefined,
  });
  // Single full-state write per delete: the stored record carries persistMs: 0 as a
  // placeholder because the persist duration is only known after the write returns.
  // The accurate value is reported via the Server-Timing header below from
  // persistedBase.persistMs; nothing reads delete.persistMs back from the store, so a
  // second commit purely to backfill it is wasted work that serializes hard on the
  // store lock under concurrent release (c10).

  if (asyncDelete) {
    void deleteRemoteSession(host, sessionId).catch((error) => {
      logError("control-plane", "session-delete-failed-async", error, { sessionId });
    });
    reply.header(
      "Server-Timing",
      [
        `cp_delete_total;dur=${totalMs.toFixed(1)}`,
        `cp_delete_persist;dur=${persistedBase.persistMs.toFixed(1)}`,
        "cp_delete_async;desc=\"true\"",
      ].join(", "),
    );
  } else {
    reply.header(
      "Server-Timing",
      [
        `cp_delete_total;dur=${totalMs.toFixed(1)}`,
        `cp_delete_remote;dur=${remoteDeleteMs.toFixed(1)}`,
        `cp_delete_persist;dur=${persistedBase.persistMs.toFixed(1)}`,
      ].join(", "),
    );
  }

  return reply.code(204).send();
}

function renderDashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>BaseLayer Observability</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f3f5ef;
        --panel: #fffdf7;
        --ink: #172018;
        --muted: #677467;
        --line: #d7ddd2;
        --accent: #14532d;
        --warn: #92400e;
        --bad: #991b1b;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 24px;
        background: radial-gradient(circle at top, #eef7ea 0, var(--bg) 45%);
        color: var(--ink);
        font: 14px/1.45 "Segoe UI", system-ui, sans-serif;
      }
      h1, h2 { margin: 0; }
      .wrap {
        display: grid;
        gap: 18px;
        max-width: 1400px;
        margin: 0 auto;
      }
      .hero, .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 16px;
        box-shadow: 0 10px 30px rgba(23, 32, 24, 0.06);
      }
      .hero { padding: 20px; }
      .hero p { margin: 8px 0 0; color: var(--muted); }
      .stats {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 12px;
        margin-top: 18px;
      }
      .stat {
        padding: 14px;
        border: 1px solid var(--line);
        border-radius: 12px;
        background: #fbfcf8;
      }
      .stat strong { display: block; font-size: 24px; }
      .grid {
        display: grid;
        gap: 18px;
        grid-template-columns: 1.5fr 1fr;
      }
      .panel { padding: 16px; overflow: hidden; }
      .panel header {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 12px;
        margin-bottom: 12px;
      }
      .muted { color: var(--muted); }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th, td {
        padding: 10px 8px;
        text-align: left;
        border-top: 1px solid var(--line);
        vertical-align: top;
      }
      th {
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .pill {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 999px;
        background: #e6f4ea;
        color: var(--accent);
        font-size: 12px;
      }
      .pill.bad { background: #fee2e2; color: var(--bad); }
      .pill.warn { background: #fef3c7; color: var(--warn); }
      .events {
        display: grid;
        gap: 10px;
        max-height: 640px;
        overflow: auto;
      }
      .event {
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 12px;
        background: #fbfcf8;
      }
      .event pre {
        white-space: pre-wrap;
        word-break: break-word;
        margin: 8px 0 0;
        color: var(--muted);
      }
      @media (max-width: 980px) {
        .grid { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <section class="hero">
        <h1>BaseLayer Observability</h1>
        <p>Provider-facing session view for internal operators and partner-style integrations.</p>
        <div class="stats" id="stats"></div>
      </section>
      <section class="grid">
        <section class="panel">
          <header>
            <h2>Sessions</h2>
            <span class="muted" id="generated-at">Loading…</span>
          </header>
          <div style="overflow:auto;">
            <table>
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Status</th>
                  <th>Runtime</th>
                  <th>Timings</th>
                  <th>Usage</th>
                </tr>
              </thead>
              <tbody id="session-rows"></tbody>
            </table>
          </div>
        </section>
        <section class="panel">
          <header>
            <h2>Recent Events</h2>
            <span class="muted">bounded per session</span>
          </header>
          <div class="events" id="event-list"></div>
        </section>
      </section>
    </div>
    <script>
      const formatNumber = (value) =>
        typeof value === "number" && Number.isFinite(value) ? value.toFixed(0) : "n/a";
      const pillClass = (status) => {
        if (status === "failed") return "pill bad";
        if (status === "terminating") return "pill warn";
        return "pill";
      };
      async function load() {
        const response = await fetch("/dashboard/convex-export");
        const data = await response.json();
        document.getElementById("generated-at").textContent =
          "generated " + new Date(data.generatedAt).toLocaleString();

        const sessions = data.sessions ?? [];
        const metricsById = new Map((data.metrics ?? []).map((item) => [item.sessionId, item]));
        const events = [...(data.events ?? [])].sort((left, right) => right.ts.localeCompare(left.ts));

        const runningCount = sessions.filter((session) => session.status === "running").length;
        const failedCount = sessions.filter((session) => session.status === "failed").length;
        const firecrackerCount = sessions.filter((session) => session.runtimeKind === "microvm").length;
        const avgCreateMs = (() => {
          const values = [...metricsById.values()]
            .map((item) => item.launchTimings?.totalMs)
            .filter((value) => typeof value === "number");
          if (values.length === 0) return "n/a";
          return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) + " ms";
        })();

        document.getElementById("stats").innerHTML = [
          ["Active sessions", runningCount],
          ["Failed sessions", failedCount],
          ["MicroVM sessions", firecrackerCount],
          ["Avg launch", avgCreateMs],
        ].map(([label, value]) => '<div class="stat"><span class="muted">' + label + '</span><strong>' + value + '</strong></div>').join("");

        document.getElementById("session-rows").innerHTML = sessions.map((session) => {
          const metrics = metricsById.get(session.sessionId);
          const usage = metrics?.usage;
          const timings = metrics?.launchTimings;
          const runtime = [
            session.runtimeKind,
            session.runtimeProfile,
            session.region,
          ].filter(Boolean).join(" / ");
          const timingText = [
            timings?.totalMs ? "launch " + formatNumber(timings.totalMs) + " ms" : null,
            timings?.cdpReadyMs ? "cdp " + formatNumber(timings.cdpReadyMs) + " ms" : null,
          ].filter(Boolean).join("<br />");
          const usageText = usage
            ? [
                "mem " + formatNumber(usage.memoryMb) + " MB",
                "cpu " + formatNumber(usage.cpuPct) + "%",
                "renderers " + formatNumber(usage.rendererCount),
                "state " + usage.activityState,
              ].join("<br />")
            : "n/a";
          const controlPlaneText = metrics?.controlPlaneTimings?.create
            ? [
                "cp " + formatNumber(metrics.controlPlaneTimings.create.totalMs) + " ms",
                metrics.controlPlaneTimings.create.schedulerMs !== undefined
                  ? "sched " + formatNumber(metrics.controlPlaneTimings.create.schedulerMs) + " ms"
                  : null,
                metrics.controlPlaneTimings.create.nodeAgentCreateMs !== undefined
                  ? "agent " + formatNumber(metrics.controlPlaneTimings.create.nodeAgentCreateMs) + " ms"
                  : null,
              ].filter(Boolean).join("<br />")
            : null;
          return '<tr>' +
            '<td><strong>' + session.sessionId + '</strong><br /><span class="muted">' + (session.sessionTags ? Object.entries(session.sessionTags).map(([key, value]) => key + '=' + value).join(", ") : "no tags") + '</span></td>' +
            '<td><span class="' + pillClass(session.status) + '">' + session.status + '</span><br /><span class="muted">' + (session.exitReason ?? "") + '</span></td>' +
            '<td>' + (runtime || "n/a") + '<br /><span class="muted">' + session.hostId + '</span></td>' +
            '<td>' + ([timingText, controlPlaneText].filter(Boolean).join("<br />") || "n/a") + '</td>' +
            '<td>' + usageText + '</td>' +
          '</tr>';
        }).join("");

        document.getElementById("event-list").innerHTML = events.slice(0, 80).map((event) => {
          const body = event.data ? JSON.stringify(event.data, null, 2) : "";
          return '<article class="event">' +
            '<strong>' + event.type + '</strong> <span class="muted">' + event.sessionId + '</span><br />' +
            '<span class="muted">' + new Date(event.ts).toLocaleString() + ' · ' + event.source + '</span>' +
            '<pre>' + [event.status, event.activityState, event.exitReason, body].filter(Boolean).join("\\n") + '</pre>' +
          '</article>';
        }).join("");
      }
      load().catch((error) => {
        document.body.innerHTML = '<pre>' + String(error) + '</pre>';
      });
    </script>
  </body>
</html>`;
}

fastify.addHook("onRequest", async (request, reply) => {
  if (controlPlaneConfig.publicOnlyV1 && !request.url.startsWith("/v1")) {
    reply.code(404).send({ error: "Not found." });
    return reply;
  }
  const auth = authenticatePartnerRequest(request, reply);
  if (partnerAuth.required && request.url.startsWith("/v1") && !auth) {
    return reply;
  }
  request.partnerAuth = auth;
});

fastify.get("/health", async () => ({
  ok: true,
  hosts: store.listHosts().length,
  sessions: store.listSessions().length,
}));

fastify.get("/hosts", async () => ({
  hosts: store.listHosts(),
}));

fastify.get("/v1/health", async (request) => ({
  ok: true,
  controlPlane: "ready",
  allowlistEnforced: hostAllowlist.enforced,
  authRequired: partnerAuth.required,
  stats: buildProviderStats(request.partnerAuth),
}));

fastify.get("/v1/hosts", async (request) => ({
  hosts: filterHostsForPartner(store.listHosts(), request.partnerAuth).map((host) =>
    hostRecordSchema.parse({
      ...host,
      allowlisted: host.allowlisted ?? Boolean(hostAllowlist.get(host.hostId)),
      enabled: host.enabled ?? true,
    }),
  ),
  allowlist: {
    enforced: hostAllowlist.enforced,
    configuredHostCount: hostAllowlist.list().length,
  },
}));

fastify.get("/sessions", async () => ({
  sessions: store.listSessions(),
}));

fastify.get("/v1/sessions", async (request, reply) => {
  const query = request.query as {
    status?: SessionRecord["status"];
    limit?: string;
    providerSessionId?: string;
    workflowId?: string;
    tenantId?: string;
    projectId?: string;
    upstreamProvider?: string;
    runtimeProfile?: string;
    region?: string;
  };
  const limit = query.limit ? Number.parseInt(query.limit, 10) : undefined;
  if (query.limit !== undefined && !Number.isFinite(limit)) {
    return reply.code(400).send({ error: "Query parameter 'limit' must be an integer." });
  }
  const sessions = filterSessionsForPartner(
    store.querySessions({
      status: query.status,
      providerSessionId: query.providerSessionId,
      workflowId: query.workflowId,
      tenantId: query.tenantId,
      projectId: query.projectId,
      upstreamProvider: query.upstreamProvider,
      runtimeProfile: query.runtimeProfile,
      region: query.region,
    } satisfies ControlPlaneSessionQuery),
    {
      limit,
    },
    request.partnerAuth,
  );

  return { sessions };
});

fastify.get("/sessions/:sessionId", async (request, reply) => {
  const sessionId = (request.params as { sessionId: string }).sessionId;
  const session = getSessionOrReply(sessionId, reply);
  if (!session) {
    return;
  }

  return session;
});

fastify.get("/v1/sessions/:sessionId", async (request, reply) => {
  const sessionId = (request.params as { sessionId: string }).sessionId;
  const session = getSessionOrReply(sessionId, reply);
  if (!session) {
    return;
  }
  if (!canPartnerAccessSession(session, request.partnerAuth)) {
    return reply.code(404).send({ error: "Session not found." });
  }

  return session;
});

fastify.get("/sessions/:sessionId/metrics", async (request, reply) => {
  const sessionId = (request.params as { sessionId: string }).sessionId;
  const session = getSessionOrReply(sessionId, reply);
  if (!session) {
    return;
  }

  return buildSessionMetricsSummary(session);
});

fastify.get("/v1/sessions/:sessionId/metrics", async (request, reply) => {
  const sessionId = (request.params as { sessionId: string }).sessionId;
  const session = getSessionOrReply(sessionId, reply);
  if (!session) {
    return;
  }
  if (!canPartnerAccessSession(session, request.partnerAuth)) {
    return reply.code(404).send({ error: "Session not found." });
  }

  return buildSessionMetricsSummary(session);
});

fastify.get("/sessions/:sessionId/events", async (request, reply) => {
  const sessionId = (request.params as { sessionId: string }).sessionId;
  const session = getSessionOrReply(sessionId, reply);
  if (!session) {
    return;
  }

  return {
    sessionId,
    events: store.getSessionEvents(sessionId),
  };
});

fastify.get("/v1/sessions/:sessionId/events", async (request, reply) => {
  const sessionId = (request.params as { sessionId: string }).sessionId;
  const session = getSessionOrReply(sessionId, reply);
  if (!session) {
    return;
  }
  if (!canPartnerAccessSession(session, request.partnerAuth)) {
    return reply.code(404).send({ error: "Session not found." });
  }

  return {
    sessionId,
    events: store.getSessionEvents(sessionId),
  };
});

fastify.get("/sessions/:sessionId/logs", async (request, reply) => {
  const sessionId = (request.params as { sessionId: string }).sessionId;
  const session = store.getSession(sessionId);
  if (!session) {
    return reply.code(404).send({ error: "Session not found." });
  }

  let logs: SessionLogSnapshot | undefined = session.recentLogs;
  if (session.status === "running") {
    const host = store.getHost(session.hostId);
    if (host) {
      logs = (await fetchRemoteSessionLogs(host, sessionId).catch(() => undefined)) ?? logs;
    }
  }

  if (!logs) {
    logs = sessionLogSnapshotSchema.parse({
      source: "control-plane",
      capturedAt: new Date().toISOString(),
      lines: [],
    });
  }

  return {
    sessionId,
    status: session.status,
    logs,
  };
});

fastify.get("/sessions/:sessionId/artifacts", async (request, reply) => {
  const sessionId = (request.params as { sessionId: string }).sessionId;
  const session = getSessionOrReply(sessionId, reply);
  if (!session) {
    return;
  }

  const artifact = sessionArtifactsSummarySchema.parse({
    sessionId: session.sessionId,
    status: session.status,
    runtimeKind: session.runtimeKind,
    connectUrl: session.connectUrl,
    cdpUrl: session.cdpUrl,
    playwrightUrl: session.playwrightUrl,
    puppeteerUrl: session.puppeteerUrl,
    debugHttpUrl: session.debugHttpUrl,
    dashboardUrl: `/dashboard`,
    logsUrl: `/sessions/${session.sessionId}/logs`,
    liveUrl: null,
    recordingUrl: null,
    traceUrl: null,
    netlogUrl: null,
  });

  return artifact;
});

fastify.get("/v1/sessions/:sessionId/artifacts", async (request, reply) => {
  const sessionId = (request.params as { sessionId: string }).sessionId;
  const session = getSessionOrReply(sessionId, reply);
  if (!session) {
    return;
  }
  if (!canPartnerAccessSession(session, request.partnerAuth)) {
    return reply.code(404).send({ error: "Session not found." });
  }

  const artifact = sessionArtifactsSummarySchema.parse({
    sessionId: session.sessionId,
    status: session.status,
    runtimeKind: session.runtimeKind,
    connectUrl: session.connectUrl,
    cdpUrl: session.cdpUrl,
    playwrightUrl: session.playwrightUrl,
    puppeteerUrl: session.puppeteerUrl,
    debugHttpUrl: session.debugHttpUrl,
    dashboardUrl: `/dashboard`,
    logsUrl: `/v1/sessions/${session.sessionId}/logs`,
    liveUrl: null,
    recordingUrl: null,
    traceUrl: null,
    netlogUrl: null,
  });

  return artifact;
});

fastify.get("/v1/sessions/:sessionId/logs", async (request, reply) => {
  const sessionId = (request.params as { sessionId: string }).sessionId;
  const session = getSessionOrReply(sessionId, reply);
  if (!session) {
    return;
  }
  if (!canPartnerAccessSession(session, request.partnerAuth)) {
    return reply.code(404).send({ error: "Session not found." });
  }

  let logs: SessionLogSnapshot | undefined = session.recentLogs;
  if (session.status === "running") {
    const host = store.getHost(session.hostId);
    if (host) {
      logs = (await fetchRemoteSessionLogs(host, sessionId).catch(() => undefined)) ?? logs;
    }
  }

  if (!logs) {
    logs = sessionLogSnapshotSchema.parse({
      source: "control-plane",
      capturedAt: new Date().toISOString(),
      lines: [],
    });
  }

  return {
    sessionId,
    status: session.status,
    logs,
  };
});

fastify.get("/v1/stats", async (request) => buildProviderStats(request.partnerAuth));

fastify.get("/dashboard/convex-export", async () => {
  const sessions = store.listSessions();
  const payload = {
    generatedAt: new Date().toISOString(),
    sessions,
    metrics: sessions.map((session) => buildSessionMetricsSummary(session)),
    events: store.listSessionEvents(),
  };

  return dashboardExportSchema.parse(payload);
});

fastify.get("/dashboard", async (_request, reply) => {
  return reply.type("text/html; charset=utf-8").send(renderDashboardHtml());
});

fastify.post("/sessions", async (request, reply) => {
  return createSessionFromRequest(request, request.body, reply);
});

fastify.post("/v1/sessions", async (request, reply) =>
  createSessionFromRequest(request, request.body, reply, request.partnerAuth));

fastify.post("/v1/sessions/:sessionId/activity", async (request, reply) => {
  const sessionId = (request.params as { sessionId: string }).sessionId;
  const session = getSessionOrReply(sessionId, reply);
  if (!session) {
    return;
  }
  if (!canPartnerAccessSession(session, request.partnerAuth)) {
    return reply.code(404).send({ error: "Session not found." });
  }
  return updateSessionActivityFromRequest(sessionId, request.body, reply);
});

fastify.delete("/sessions/:sessionId", async (request, reply) => {
  const sessionId = (request.params as { sessionId: string }).sessionId;
  return deleteSessionFromRequest(request, sessionId, reply);
});

fastify.delete("/v1/sessions/:sessionId", async (request, reply) => {
  const sessionId = (request.params as { sessionId: string }).sessionId;
  return deleteSessionFromRequest(request, sessionId, reply, request.partnerAuth);
});

fastify.patch("/internal/sessions/:sessionId", async (request, reply) => {
  const sessionId = (request.params as { sessionId: string }).sessionId;
  const session = store.getSession(sessionId);
  if (!session) {
    return reply.code(404).send({ error: "Session not found." });
  }

  const body = request.body as {
    status?: "running" | "terminated" | "failed";
    exitReason?: string;
    recentLogs?: SessionLogSnapshot;
    lastKnownMetrics?: {
      memoryMb: number;
      cpuPct: number;
      rendererCount: number;
      shmUsedMb: number;
      memoryLimitMb: number;
      shmLimitMb: number;
      activityState: "launching" | "active-navigation" | "interactive-idle" | "soak-idle";
      schedulerWeight: number;
    };
  };

  const nextStatus = body.status ?? session.status;
  const nextExitReason = body.exitReason ?? session.exitReason;
  const nextLastKnownMetrics =
    body.lastKnownMetrics === undefined
      ? session.lastKnownMetrics
      : {
          memoryMb: body.lastKnownMetrics.memoryMb,
          cpuPct: body.lastKnownMetrics.cpuPct,
          rendererCount: body.lastKnownMetrics.rendererCount,
          shmUsedMb: body.lastKnownMetrics.shmUsedMb,
          memoryLimitMb: body.lastKnownMetrics.memoryLimitMb,
          shmLimitMb: body.lastKnownMetrics.shmLimitMb,
          activityState: body.lastKnownMetrics.activityState,
          schedulerWeight: body.lastKnownMetrics.schedulerWeight,
        };
  const updated = store.upsertSession({
    ...session,
    status: nextStatus,
    exitReason: nextExitReason,
    endedAt: isTerminalStatus(nextStatus)
      ? session.endedAt ?? new Date().toISOString()
      : session.endedAt,
    recentLogs: body.recentLogs ?? session.recentLogs,
    lastKnownMetrics: nextLastKnownMetrics,
  });

  if (nextStatus !== session.status) {
    appendSessionEvent(sessionId, "node-agent", "session-status-updated", {
      status: nextStatus,
      exitReason: nextExitReason,
      data: {
        previousStatus: session.status,
        nextStatus,
      },
    });
  }

  if (nextExitReason && nextExitReason !== session.exitReason) {
    appendSessionEvent(sessionId, "node-agent", "session-exit-reason-set", {
      status: nextStatus,
      exitReason: nextExitReason,
    });
  }

  if (
    nextLastKnownMetrics?.activityState &&
    nextLastKnownMetrics.activityState !== session.lastKnownMetrics?.activityState
  ) {
    appendSessionEvent(sessionId, "node-agent", "session-activity-updated", {
      status: updated.status,
      activityState: nextLastKnownMetrics.activityState,
      data: {
        previousActivityState: session.lastKnownMetrics?.activityState ?? null,
        nextActivityState: nextLastKnownMetrics.activityState,
      },
    });
  }

  if (body.lastKnownMetrics !== undefined) {
    appendSessionEvent(sessionId, "node-agent", "session-metrics-updated", {
      status: updated.status,
      activityState: nextLastKnownMetrics?.activityState,
      data: {
        memoryMb: nextLastKnownMetrics?.memoryMb ?? 0,
        cpuPct: nextLastKnownMetrics?.cpuPct ?? 0,
        rendererCount: nextLastKnownMetrics?.rendererCount ?? 0,
        shmUsedMb: nextLastKnownMetrics?.shmUsedMb ?? 0,
      },
    });
  }

  if (body.recentLogs !== undefined) {
    appendSessionEvent(sessionId, "node-agent", "session-metrics-updated", {
      status: updated.status,
      data: {
        logLines: body.recentLogs.lines.length,
      },
    });
  }

  return reply.code(202).send({ ok: true });
});

fastify.post("/internal/hosts/register", async (request, reply) => {
  const parsed = hostRegistrationSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }

  if (!hostAllowlist.isAllowed(parsed.data.hostId)) {
    return reply.code(403).send({
      error:
        "Host is not allowlisted for provider control-plane registration. Add it to config/provider-hosts.json or disable allowlist enforcement.",
    });
  }

  const now = new Date().toISOString();
  const host = hostAllowlist.enrichRegisteredHost(
    hostRecordSchema.parse({
      hostId: parsed.data.hostId,
      name: parsed.data.name,
      apiUrl: parsed.data.apiUrl,
      mode: parsed.data.mode,
      region: parsed.data.region,
      instanceType: parsed.data.instanceType,
      labels: parsed.data.labels,
      supportedRuntimeProfiles: parsed.data.supportedRuntimeProfiles,
      status: "healthy",
      capacity: parsed.data.capacity,
      metrics: {
      totalMemoryMb: 0,
      freeMemoryMb: 0,
      usedMemoryMb: 0,
      memoryPressurePct: 0,
      shmCapacityMb: 0,
      shmUsedMb: 0,
      activeSessions: 0,
      activeRendererCount: 0,
      trackedMemoryMb: 0,
      trackedShmUsedMb: 0,
      crashCount5m: 0,
      activeMicrovmCount: 0,
      reservedMicrovmMemoryMb: 0,
      avgRestoreMs: 0,
      cpuUtilizationPct: 0,
      loadAvg1m: 0,
      loadAvg5m: 0,
      highPrioritySessionCount: 0,
      activeNavigationSessionCount: 0,
      coldAdmitRemaining: 0,
      warmPools: [],
      },
      registeredAt: now,
      reportedAt: now,
    }),
  );

  store.upsertHost(host);
  log("control-plane", "host-registered", {
    hostId: host.hostId,
    apiUrl: host.apiUrl,
    mode: host.mode,
    region: host.region,
  });

  return reply.code(201).send(host);
});

fastify.post("/internal/hosts/:hostId/heartbeat", async (request, reply) => {
  const hostId = (request.params as { hostId: string }).hostId;
  const parsed = hostHeartbeatSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }

  const existing = store.getHost(hostId);
  if (!existing) {
    return reply.code(404).send({ error: "Host not registered." });
  }

  store.upsertHost({
    ...existing,
    mode: parsed.data.mode,
    status: parsed.data.status,
    capacity: parsed.data.capacity,
    metrics: parsed.data.metrics,
    reportedAt: parsed.data.reportedAt,
  });

  return reply.code(202).send({ ok: true });
});

async function main(): Promise<void> {
  try {
    await fastify.listen({
      port: controlPlaneConfig.port,
      host: "0.0.0.0",
    });
    log("control-plane", "listening", { port: controlPlaneConfig.port });
  } catch (error) {
    logError("control-plane", "listen-failed", error);
    process.exitCode = 1;
  }
}

void main();
