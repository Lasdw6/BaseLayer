import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";

import {
  hostCreateReservationSchema,
  hostDeleteReservationSchema,
  sessionEventRecordSchema,
  hostRecordSchema,
  idempotencyRecordSchema,
  sessionRecordSchema,
  stateFileSchema,
  type HostCreateReservation,
  type HostDeleteReservation,
  type IdempotencyRecord,
  type SessionEventRecord,
  type HostRecord,
  type SessionRecord,
  type StateFile,
} from "../shared/types.js";
import type { ControlPlaneSessionQuery, ControlPlaneStoreBackend } from "./store-contract.js";
import { chooseHost } from "./scheduler.js";

function emptyState(): StateFile {
  return {
    sessions: {},
    hosts: {},
    sessionEvents: {},
    idempotencyRecords: {},
    hostCreateReservations: {},
    hostDeleteReservations: {},
  };
}

const STORE_LOCK_TIMEOUT_MS = 5_000;
const STORE_LOCK_WAIT_MS = 25;

function sleepMs(durationMs: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, durationMs);
}

export class ControlPlaneStore implements ControlPlaneStoreBackend {
  readonly #statePath: string;
  readonly #lockPath: string;

  #state: StateFile;
  #lastLoadedMtimeMs: number;

  constructor(statePath: string) {
    this.#statePath = statePath;
    this.#lockPath = `${statePath}.lock`;
    this.#state = emptyState();
    this.#lastLoadedMtimeMs = -1;
    this.#refreshFromDisk(true);
  }

  #load(): { state: StateFile; mtimeMs: number } {
    if (!fs.existsSync(this.#statePath)) {
      return { state: emptyState(), mtimeMs: -1 };
    }

    const raw = fs.readFileSync(this.#statePath, "utf8");
    const parsed = stateFileSchema.safeParse(JSON.parse(raw));
    const stat = fs.statSync(this.#statePath);
    return {
      state: parsed.success ? parsed.data : emptyState(),
      mtimeMs: stat.mtimeMs,
    };
  }

  #refreshFromDisk(force = false): void {
    if (!fs.existsSync(this.#statePath)) {
      if (force || this.#lastLoadedMtimeMs !== -1) {
        this.#state = emptyState();
        this.#lastLoadedMtimeMs = -1;
      }
      return;
    }

    const loaded = this.#load();
    this.#state = loaded.state;
    this.#lastLoadedMtimeMs = loaded.mtimeMs;
  }

  #persist(): void {
    fs.mkdirSync(path.dirname(this.#statePath), { recursive: true });
    const tempPath = `${this.#statePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(this.#state));
    fs.renameSync(tempPath, this.#statePath);
    this.#lastLoadedMtimeMs = fs.statSync(this.#statePath).mtimeMs;
  }

  #cleanupExpiredReservations(nowIso = new Date().toISOString()): void {
    for (const [reservationId, reservation] of Object.entries(this.#state.hostCreateReservations)) {
      if (reservation.expiresAt <= nowIso) {
        delete this.#state.hostCreateReservations[reservationId];
      }
    }

    for (const [reservationId, reservation] of Object.entries(this.#state.hostDeleteReservations)) {
      if (reservation.expiresAt <= nowIso) {
        delete this.#state.hostDeleteReservations[reservationId];
      }
    }
  }

  #effectiveHosts(nowIso = new Date().toISOString()): HostRecord[] {
    const createReservations = Object.values(this.#state.hostCreateReservations)
      .filter((reservation) => reservation.expiresAt > nowIso)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const deleteReservations = Object.values(this.#state.hostDeleteReservations)
      .filter((reservation) => reservation.expiresAt > nowIso)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const hosts = Object.values(this.#state.hosts)
      .sort((left, right) => left.hostId.localeCompare(right.hostId))
      .map((host) => structuredClone(host));

    for (const reservation of createReservations) {
      const host = hosts.find((entry) => entry.hostId === reservation.hostId);
      if (!host) {
        continue;
      }

      host.metrics.activeSessions += 1;
      host.metrics.activeRendererCount += 1;
      host.metrics.coldAdmitRemaining = Math.max(0, (host.metrics.coldAdmitRemaining ?? 0) - 1);

      if (host.mode !== "firecracker") {
        continue;
      }

      if (reservation.warmExpected) {
        const warmPool = host.metrics.warmPools.find(
          (pool) =>
            pool.runtimeProfile === reservation.runtimeProfile &&
            pool.readyCount > 0,
        );
        if (warmPool) {
          warmPool.readyCount = Math.max(0, warmPool.readyCount - 1);
          continue;
        }
      }

      host.metrics.activeMicrovmCount += 1;
      host.metrics.reservedMicrovmMemoryMb += host.capacity.microvmMemoryMb;
    }

    for (const reservation of deleteReservations) {
      const host = hosts.find((entry) => entry.hostId === reservation.hostId);
      if (!host) {
        continue;
      }

      host.metrics.activeSessions = Math.max(0, host.metrics.activeSessions - 1);
      host.metrics.activeRendererCount = Math.max(
        0,
        host.metrics.activeRendererCount - Math.max(1, reservation.rendererCount),
      );
      host.metrics.coldAdmitRemaining = Math.min(
        host.capacity.maxSessions,
        (host.metrics.coldAdmitRemaining ?? 0) + 1,
      );

      if (host.mode !== "firecracker" || reservation.runtimeKind !== "microvm") {
        continue;
      }

      host.metrics.activeMicrovmCount = Math.max(0, host.metrics.activeMicrovmCount - 1);
      host.metrics.reservedMicrovmMemoryMb = Math.max(
        0,
        host.metrics.reservedMicrovmMemoryMb - host.capacity.microvmMemoryMb,
      );
    }

    return hosts;
  }

  #withWriteLock<T>(mutate: () => T): T {
    fs.mkdirSync(path.dirname(this.#statePath), { recursive: true });
    const startedAt = Date.now();
    let lockFd: number | undefined;

    while (lockFd === undefined) {
      try {
        lockFd = fs.openSync(this.#lockPath, "wx");
      } catch (error) {
        const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
        if (code !== "EEXIST") {
          throw error;
        }
        if (Date.now() - startedAt >= STORE_LOCK_TIMEOUT_MS) {
          throw new Error(`Timed out acquiring control-plane store lock for ${this.#statePath}`);
        }
        sleepMs(STORE_LOCK_WAIT_MS);
      }
    }

    try {
      this.#refreshFromDisk(true);
      const result = mutate();
      this.#persist();
      return result;
    } finally {
      fs.closeSync(lockFd);
      fs.rmSync(this.#lockPath, { force: true });
    }
  }

  #withWriteLockMeasured<T>(mutate: () => T): { result: T; persistMs: number } {
    fs.mkdirSync(path.dirname(this.#statePath), { recursive: true });
    const startedAt = Date.now();
    let lockFd: number | undefined;

    while (lockFd === undefined) {
      try {
        lockFd = fs.openSync(this.#lockPath, "wx");
      } catch (error) {
        const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
        if (code !== "EEXIST") {
          throw error;
        }
        if (Date.now() - startedAt >= STORE_LOCK_TIMEOUT_MS) {
          throw new Error(`Timed out acquiring control-plane store lock for ${this.#statePath}`);
        }
        sleepMs(STORE_LOCK_WAIT_MS);
      }
    }

    try {
      this.#refreshFromDisk(true);
      const result = mutate();
      const persistStarted = performance.now();
      this.#persist();
      const persistMs = performance.now() - persistStarted;
      return { result, persistMs };
    } finally {
      fs.closeSync(lockFd);
      fs.rmSync(this.#lockPath, { force: true });
    }
  }

  listHosts(): HostRecord[] {
    this.#refreshFromDisk();
    return this.#effectiveHosts();
  }

  getHost(hostId: string): HostRecord | undefined {
    this.#refreshFromDisk();
    return this.#effectiveHosts().find((host) => host.hostId === hostId);
  }

  upsertHost(host: HostRecord): HostRecord {
    return this.#withWriteLock(() => {
      const parsed = hostRecordSchema.parse(host);
      this.#state.hosts[parsed.hostId] = parsed;
      return parsed;
    });
  }

  listHostCreateReservations(hostId?: string): HostCreateReservation[] {
    this.#refreshFromDisk();
    return Object.values(this.#state.hostCreateReservations)
      .filter((reservation) => reservation.expiresAt > new Date().toISOString())
      .filter((reservation) => (hostId ? reservation.hostId === hostId : true))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  reserveHostForCreate(input: {
    sessionId: string;
    preferredRegion?: string;
    runtimeProfile?: string;
    ttlMs: number;
  }): { host: HostRecord; reservation: HostCreateReservation } {
    return this.#withWriteLock(() => {
      const now = new Date();
      this.#cleanupExpiredReservations(now.toISOString());
      const hosts = this.#effectiveHosts(now.toISOString());
      const host = chooseHost(hosts, {
        preferredRegion: input.preferredRegion,
        runtimeProfile: input.runtimeProfile,
      });
      const effectiveRuntimeProfile =
        input.runtimeProfile ??
        (host.supportedRuntimeProfiles?.length === 1 ? host.supportedRuntimeProfiles[0] : undefined) ??
        (host.metrics.warmPools.length === 1 ? host.metrics.warmPools[0]?.runtimeProfile : undefined);
      const matchingWarmPool = effectiveRuntimeProfile
        ? host.metrics.warmPools.find((pool) => pool.runtimeProfile === effectiveRuntimeProfile)
        : undefined;
      const reservation = hostCreateReservationSchema.parse({
        reservationId: crypto.randomUUID(),
        sessionId: input.sessionId,
        hostId: host.hostId,
        runtimeProfile: effectiveRuntimeProfile,
        preferredRegion: input.preferredRegion,
        warmExpected: (matchingWarmPool?.readyCount ?? 0) > 0,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
      });
      this.#state.hostCreateReservations[reservation.reservationId] = reservation;

      const reservedHost = this.#effectiveHosts(now.toISOString()).find(
        (entry) => entry.hostId === host.hostId,
      );
      return { host: reservedHost ?? host, reservation };
    });
  }

  releaseHostCreateReservation(reservationId: string): void {
    this.#withWriteLock(() => {
      this.#cleanupExpiredReservations();
      delete this.#state.hostCreateReservations[reservationId];
    });
  }

  listSessions(): SessionRecord[] {
    this.#refreshFromDisk();
    return Object.values(this.#state.sessions).sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    );
  }

  querySessions(query: ControlPlaneSessionQuery): SessionRecord[] {
    return this.listSessions()
      .filter((session) => (query.status ? session.status === query.status : true))
      .filter((session) =>
        query.providerSessionId ? session.provider?.providerSessionId === query.providerSessionId : true,
      )
      .filter((session) => (query.workflowId ? session.provider?.workflowId === query.workflowId : true))
      .filter((session) => (query.tenantId ? session.provider?.tenantId === query.tenantId : true))
      .filter((session) => (query.projectId ? session.provider?.projectId === query.projectId : true))
      .filter((session) =>
        query.upstreamProvider ? session.provider?.upstreamProvider === query.upstreamProvider : true,
      )
      .filter((session) => (query.runtimeProfile ? session.runtimeProfile === query.runtimeProfile : true))
      .filter((session) => (query.region ? session.region === query.region : true));
  }

  getSession(sessionId: string): SessionRecord | undefined {
    this.#refreshFromDisk();
    return this.#state.sessions[sessionId];
  }

  upsertSession(session: SessionRecord): SessionRecord {
    return this.#withWriteLock(() => {
      this.#cleanupExpiredReservations();
      const parsed = sessionRecordSchema.parse(session);
      this.#state.sessions[parsed.sessionId] = parsed;
      return parsed;
    });
  }

  upsertSessionAndAppendEvent(
    session: SessionRecord,
    event?: SessionEventRecord,
  ): { session: SessionRecord; event?: SessionEventRecord } {
    return this.#withWriteLock(() => {
      this.#cleanupExpiredReservations();
      const parsedSession = sessionRecordSchema.parse(session);
      this.#state.sessions[parsedSession.sessionId] = parsedSession;

      let parsedEvent: SessionEventRecord | undefined;
      if (event) {
        parsedEvent = sessionEventRecordSchema.parse(event);
        const existing = this.#state.sessionEvents[parsedEvent.sessionId] ?? [];
        this.#state.sessionEvents[parsedEvent.sessionId] = [...existing, parsedEvent].slice(-256);
      }

      return { session: parsedSession, event: parsedEvent };
    });
  }

  listSessionEvents(): SessionEventRecord[] {
    this.#refreshFromDisk();
    return Object.values(this.#state.sessionEvents)
      .flat()
      .sort((left, right) => left.ts.localeCompare(right.ts));
  }

  getSessionEvents(sessionId: string): SessionEventRecord[] {
    this.#refreshFromDisk();
    return [...(this.#state.sessionEvents[sessionId] ?? [])].sort((left, right) =>
      left.ts.localeCompare(right.ts),
    );
  }

  appendSessionEvent(event: SessionEventRecord): SessionEventRecord {
    return this.#withWriteLock(() => {
      this.#cleanupExpiredReservations();
      const parsed = sessionEventRecordSchema.parse(event);
      const existing = this.#state.sessionEvents[parsed.sessionId] ?? [];
      const next = [...existing, parsed].slice(-256);
      this.#state.sessionEvents[parsed.sessionId] = next;
      return parsed;
    });
  }

  getIdempotencyRecord(storageKey: string): IdempotencyRecord | undefined {
    this.#refreshFromDisk();
    return this.#state.idempotencyRecords[storageKey];
  }

  upsertIdempotencyRecord(storageKey: string, record: IdempotencyRecord): IdempotencyRecord {
    return this.#withWriteLock(() => {
      this.#cleanupExpiredReservations();
      const parsed = idempotencyRecordSchema.parse(record);
      this.#state.idempotencyRecords[storageKey] = parsed;
      return parsed;
    });
  }

  commitSessionMutation(input: {
    releaseReservationId?: string;
    addDeleteReservation?: HostDeleteReservation;
    session?: SessionRecord;
    event?: SessionEventRecord;
    idempotency?: {
      storageKey: string;
      record: IdempotencyRecord;
    };
    removeSessionId?: string;
  }): {
    session?: SessionRecord;
    event?: SessionEventRecord;
    idempotency?: IdempotencyRecord;
    persistMs: number;
  } {
    const { result, persistMs } = this.#withWriteLockMeasured(() => {
      this.#cleanupExpiredReservations();

      if (input.releaseReservationId) {
        delete this.#state.hostCreateReservations[input.releaseReservationId];
      }

      if (input.addDeleteReservation) {
        const parsedDeleteReservation = hostDeleteReservationSchema.parse(input.addDeleteReservation);
        this.#state.hostDeleteReservations[parsedDeleteReservation.reservationId] =
          parsedDeleteReservation;
      }

      if (input.removeSessionId) {
        delete this.#state.sessions[input.removeSessionId];
        delete this.#state.sessionEvents[input.removeSessionId];
      }

      let parsedSession: SessionRecord | undefined;
      if (input.session) {
        parsedSession = sessionRecordSchema.parse(input.session);
        this.#state.sessions[parsedSession.sessionId] = parsedSession;
      }

      let parsedEvent: SessionEventRecord | undefined;
      if (input.event) {
        parsedEvent = sessionEventRecordSchema.parse(input.event);
        const existing = this.#state.sessionEvents[parsedEvent.sessionId] ?? [];
        this.#state.sessionEvents[parsedEvent.sessionId] = [...existing, parsedEvent].slice(-256);
      }

      let parsedIdempotency: IdempotencyRecord | undefined;
      if (input.idempotency) {
        parsedIdempotency = idempotencyRecordSchema.parse(input.idempotency.record);
        this.#state.idempotencyRecords[input.idempotency.storageKey] = parsedIdempotency;
      }

      return {
        session: parsedSession,
        event: parsedEvent,
        idempotency: parsedIdempotency,
      };
    });

    return {
      ...result,
      persistMs,
    };
  }

  removeSession(sessionId: string): void {
    this.#withWriteLock(() => {
      this.#cleanupExpiredReservations();
      delete this.#state.sessions[sessionId];
      delete this.#state.sessionEvents[sessionId];
    });
  }
}

export function createControlPlaneStore(statePath: string): ControlPlaneStoreBackend {
  return new ControlPlaneStore(statePath);
}
