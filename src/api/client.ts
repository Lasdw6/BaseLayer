import {
  type CreateSessionRequest,
  type HostRecord,
  type RuntimeLaunchResult,
  type SessionActivityState,
  type SessionLogSnapshot,
} from "../shared/types.js";
import { agentConfig, controlPlaneConfig } from "../shared/config.js";

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function assertOk(response: Response, message: string): Promise<Response> {
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${message}: ${response.status} ${body}`);
  }

  return response;
}

function isTransientFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("fetch failed") ||
    message.includes("econnrefused") ||
    message.includes("socket hang up") ||
    message.includes("und_err_connect_timeout") ||
    message.includes("other side closed")
  );
}

function isTimeoutFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.name === "TimeoutError" ||
    error.name === "AbortError" ||
    error.message.toLowerCase().includes("timed out") ||
    error.message.toLowerCase().includes("abort")
  );
}

export class RemoteSessionCreateError extends Error {
  readonly kind: "timeout" | "request" | "response";
  readonly hostId: string;
  readonly hostApiUrl: string;
  readonly sessionId: string;

  constructor(input: {
    kind: "timeout" | "request" | "response";
    hostId: string;
    hostApiUrl: string;
    sessionId: string;
    message: string;
    cause?: unknown;
  }) {
    super(input.message, input.cause ? { cause: input.cause } : undefined);
    this.name = "RemoteSessionCreateError";
    this.kind = input.kind;
    this.hostId = input.hostId;
    this.hostApiUrl = input.hostApiUrl;
    this.sessionId = input.sessionId;
  }
}

export function resolveRemoteCreateTimeoutMs(
  host: HostRecord,
  requestedTimeoutMs: number | undefined,
): number {
  const configuredTimeoutMs = requestedTimeoutMs ?? controlPlaneConfig.remoteCreateTimeoutMs;
  if (host.mode !== "firecracker") {
    return configuredTimeoutMs;
  }

  const restoreAttempts = Math.max(1, 1 + agentConfig.firecrackerRestoreRetries);
  // A single Firecracker "restore attempt" includes more than the CDP readiness window:
  // slot claim, machine spawn, snapshot load, relay readiness, and then the bounded local
  // /json/version + /json/list checks. Keep the control-plane timeout above that full host-side
  // budget so rare slow attempts do not turn into avoidable 504s while the node-agent is still
  // making bounded progress.
  const perAttemptBudgetMs = agentConfig.firecrackerRestoreTimeoutMs + 10_000;
  const minimumFirecrackerBudgetMs = restoreAttempts * perAttemptBudgetMs + 10_000;

  return Math.max(configuredTimeoutMs, minimumFirecrackerBudgetMs);
}

async function fetchWithTransientRetry(
  url: string,
  init: RequestInit,
  retries: number,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fetch(url, init);
    } catch (error) {
      lastError = error;
      if (!isTransientFetchError(error) || attempt === retries) {
        throw error;
      }
      await sleep(attempt === 0 ? 100 : 250);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function createRemoteSession(
  host: HostRecord,
  request: CreateSessionRequest & { sessionId: string },
  options: {
    timeoutMs?: number;
    retries?: number;
  } = {},
): Promise<RuntimeLaunchResult> {
  const timeoutMs = resolveRemoteCreateTimeoutMs(host, options.timeoutMs);
  const retries = options.retries ?? controlPlaneConfig.remoteCreateRetries;
  let response: Response;

  try {
    response = await fetchWithTransientRetry(
      `${host.apiUrl}/internal/sessions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(timeoutMs),
      },
      retries,
    );
  } catch (error) {
    const kind = isTimeoutFetchError(error) ? "timeout" : "request";
    const message =
      kind === "timeout"
        ? `Timed out creating session on host ${host.hostId} after ${timeoutMs} ms.`
        : `Node agent request failed while creating session on host ${host.hostId}.`;
    throw new RemoteSessionCreateError({
      kind,
      hostId: host.hostId,
      hostApiUrl: host.apiUrl,
      sessionId: request.sessionId,
      message,
      cause: error,
    });
  }

  if (!response.ok) {
    const body = await response.text();
    throw new RemoteSessionCreateError({
      kind: "response",
      hostId: host.hostId,
      hostApiUrl: host.apiUrl,
      sessionId: request.sessionId,
      message: `Node agent failed to create a session on host ${host.hostId}: ${response.status} ${body}`,
    });
  }

  return (await response.json()) as RuntimeLaunchResult;
}

export async function deleteRemoteSession(host: HostRecord, sessionId: string): Promise<void> {
  const response = await fetch(`${host.apiUrl}/internal/sessions/${sessionId}`, {
    method: "DELETE",
    signal: AbortSignal.timeout(120_000),
  });

  await assertOk(response, "Node agent failed to terminate the session");
}

export async function fetchRemoteSessionLogs(
  host: HostRecord,
  sessionId: string,
): Promise<SessionLogSnapshot | undefined> {
  const response = await fetchWithTransientRetry(
    `${host.apiUrl}/internal/sessions/${sessionId}/logs`,
    {
      method: "GET",
      signal: AbortSignal.timeout(30_000),
    },
    1,
  );

  if (response.status === 404) {
    return undefined;
  }

  await assertOk(response, "Node agent failed to fetch session logs");
  return (await response.json()) as SessionLogSnapshot;
}

export async function markRemoteSessionActivity(
  host: HostRecord,
  sessionId: string,
  activityState: SessionActivityState,
): Promise<void> {
  const response = await fetchWithTransientRetry(
    `${host.apiUrl}/internal/sessions/${sessionId}/activity`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ activityState }),
      signal: AbortSignal.timeout(15_000),
    },
    1,
  );

  await assertOk(response, "Node agent failed to update session activity");
}
