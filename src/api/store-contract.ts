import type {
  HostRecord,
  HostCreateReservation,
  HostDeleteReservation,
  IdempotencyRecord,
  SessionEventRecord,
  SessionRecord,
} from "../shared/types.js";

export type ControlPlaneSessionQuery = {
  status?: SessionRecord["status"];
  providerSessionId?: string;
  workflowId?: string;
  tenantId?: string;
  projectId?: string;
  upstreamProvider?: string;
  runtimeProfile?: string;
  region?: string;
};

export interface ControlPlaneStoreBackend {
  listHosts(): HostRecord[];
  getHost(hostId: string): HostRecord | undefined;
  upsertHost(host: HostRecord): HostRecord;
  listHostCreateReservations(hostId?: string): HostCreateReservation[];
  reserveHostForCreate(input: {
    sessionId: string;
    preferredRegion?: string;
    runtimeProfile?: string;
    ttlMs: number;
  }): { host: HostRecord; reservation: HostCreateReservation };
  releaseHostCreateReservation(reservationId: string): void;
  listSessions(): SessionRecord[];
  querySessions(query: ControlPlaneSessionQuery): SessionRecord[];
  getSession(sessionId: string): SessionRecord | undefined;
  upsertSession(session: SessionRecord): SessionRecord;
  upsertSessionAndAppendEvent(
    session: SessionRecord,
    event?: SessionEventRecord,
  ): { session: SessionRecord; event?: SessionEventRecord };
  listSessionEvents(): SessionEventRecord[];
  getSessionEvents(sessionId: string): SessionEventRecord[];
  appendSessionEvent(event: SessionEventRecord): SessionEventRecord;
  getIdempotencyRecord(storageKey: string): IdempotencyRecord | undefined;
  upsertIdempotencyRecord(storageKey: string, record: IdempotencyRecord): IdempotencyRecord;
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
  };
  removeSession(sessionId: string): void;
}
