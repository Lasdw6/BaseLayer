import { z } from "zod";

export const browserKindSchema = z.enum(["chromium"]);
export type BrowserKind = z.infer<typeof browserKindSchema>;

export const sessionStatusSchema = z.enum([
  "pending",
  "running",
  "terminating",
  "terminated",
  "failed",
]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const agentModeSchema = z.enum(["baseline", "managed", "firecracker"]);
export type AgentMode = z.infer<typeof agentModeSchema>;

export const runtimeKindSchema = z.enum(["container", "microvm"]);
export type RuntimeKind = z.infer<typeof runtimeKindSchema>;

export const sessionActivityStateSchema = z.enum([
  "launching",
  "active-navigation",
  "interactive-idle",
  "soak-idle",
]);
export type SessionActivityState = z.infer<typeof sessionActivityStateSchema>;

export const providerSessionTagSchema = z.string().min(1).max(128);
export const providerSessionTagsSchema = z
  .record(providerSessionTagSchema, z.string().min(1).max(256))
  .superRefine((value, ctx) => {
    if (Object.keys(value).length > 16) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "sessionTags may contain at most 16 entries.",
      });
    }
  });
export type ProviderSessionTags = z.infer<typeof providerSessionTagsSchema>;

export const providerSessionMetadataSchema = z.object({
  upstreamProvider: z.string().min(1).max(128).optional(),
  providerSessionId: z.string().min(1).max(256).optional(),
  tenantId: z.string().min(1).max(128).optional(),
  projectId: z.string().min(1).max(128).optional(),
  workflowId: z.string().min(1).max(128).optional(),
  workloadClass: z.string().min(1).max(128).optional(),
});
export type ProviderSessionMetadata = z.infer<typeof providerSessionMetadataSchema>;

export const providerEventScalarSchema = z.union([
  z.string().max(512),
  z.number(),
  z.boolean(),
  z.null(),
]);
export const providerEventDataSchema = z
  .record(z.string().min(1).max(128), providerEventScalarSchema)
  .superRefine((value, ctx) => {
    if (Object.keys(value).length > 24) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "event data may contain at most 24 entries.",
      });
    }
  });
export type ProviderEventData = z.infer<typeof providerEventDataSchema>;

export const sessionEventTypeSchema = z.enum([
  "session-created",
  "session-status-updated",
  "session-activity-updated",
  "session-exit-reason-set",
  "session-metrics-updated",
]);
export type SessionEventType = z.infer<typeof sessionEventTypeSchema>;

export const sessionLogSnapshotSchema = z.object({
  source: z.enum(["control-plane", "node-agent-container", "node-agent-microvm"]),
  capturedAt: z.string(),
  lines: z.array(z.string().max(2048)).max(200),
});
export type SessionLogSnapshot = z.infer<typeof sessionLogSnapshotSchema>;

export const sessionArtifactsSummarySchema = z.object({
  sessionId: z.string(),
  status: sessionStatusSchema,
  runtimeKind: runtimeKindSchema.default("container"),
  connectUrl: z.string().url(),
  cdpUrl: z.string().url(),
  playwrightUrl: z.string().url(),
  puppeteerUrl: z.string().url(),
  debugHttpUrl: z.string().url(),
  dashboardUrl: z.string(),
  logsUrl: z.string(),
  liveUrl: z.string().nullable().default(null),
  recordingUrl: z.string().nullable().default(null),
  traceUrl: z.string().nullable().default(null),
  netlogUrl: z.string().nullable().default(null),
});
export type SessionArtifactsSummary = z.infer<typeof sessionArtifactsSummarySchema>;

export const createSessionRequestSchema = z.object({
  browser: browserKindSchema.default("chromium"),
  keepAlive: z.boolean().default(false),
  timeoutSec: z.number().int().positive().max(3600).default(900),
  idleTimeoutSec: z.number().int().positive().max(3600).default(120),
  proxyProfile: z.string().min(1).max(128).optional(),
  runtimeProfile: z.string().min(1).max(128).optional(),
  region: z.string().min(1).max(64).optional(),
  provider: providerSessionMetadataSchema.optional(),
  sessionTags: providerSessionTagsSchema.optional(),
});
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const launchTimingSchema = z.object({
  totalMs: z.number().nonnegative(),
  networkSetupMs: z.number().nonnegative().optional(),
  networkClaimMs: z.number().nonnegative().optional(),
  networkValidateMs: z.number().nonnegative().optional(),
  networkPrepareMissMs: z.number().nonnegative().optional(),
  helperCleanupMs: z.number().nonnegative().optional(),
  processSpawnMs: z.number().nonnegative().optional(),
  configureMs: z.number().nonnegative().optional(),
  relayReadyMs: z.number().nonnegative().optional(),
  cdpReadyMs: z.number().nonnegative().optional(),
  cdpSocketReadyMs: z.number().nonnegative().optional(),
  cdpVersionReadyMs: z.number().nonnegative().optional(),
  cdpTargetListReadyMs: z.number().nonnegative().optional(),
});
export type LaunchTiming = z.infer<typeof launchTimingSchema>;

export const controlPlaneCreateTimingSchema = z.object({
  totalMs: z.number().nonnegative(),
  requestValidationMs: z.number().nonnegative().optional(),
  schedulerMs: z.number().nonnegative().optional(),
  reservationMs: z.number().nonnegative().optional(),
  nodeAgentCreateMs: z.number().nonnegative().optional(),
  persistMs: z.number().nonnegative().optional(),
  responseBuildMs: z.number().nonnegative().optional(),
  warmExpected: z.boolean().optional(),
  warmActual: z.boolean().optional(),
  warmMismatch: z.boolean().optional(),
});
export type ControlPlaneCreateTiming = z.infer<typeof controlPlaneCreateTimingSchema>;

export const controlPlaneDeleteTimingSchema = z.object({
  totalMs: z.number().nonnegative(),
  remoteDeleteMs: z.number().nonnegative().optional(),
  persistMs: z.number().nonnegative().optional(),
  async: z.boolean(),
});
export type ControlPlaneDeleteTiming = z.infer<typeof controlPlaneDeleteTimingSchema>;

export const controlPlaneTimingSchema = z.object({
  create: controlPlaneCreateTimingSchema.optional(),
  delete: controlPlaneDeleteTimingSchema.optional(),
});
export type ControlPlaneTiming = z.infer<typeof controlPlaneTimingSchema>;

export const createSessionResultSchema = z.object({
  sessionId: z.string(),
  status: sessionStatusSchema,
  hostId: z.string(),
  connectUrl: z.string().url(),
  cdpUrl: z.string().url(),
  playwrightUrl: z.string().url(),
  puppeteerUrl: z.string().url(),
  debugHttpUrl: z.string().url(),
  expiresAt: z.string(),
  createdAt: z.string(),
  runtimeProfile: z.string().optional(),
  region: z.string().optional(),
  provider: providerSessionMetadataSchema.optional(),
  sessionTags: providerSessionTagsSchema.optional(),
  launchTimings: launchTimingSchema.optional(),
  controlPlaneTimings: controlPlaneTimingSchema.optional(),
});
export type CreateSessionResult = z.infer<typeof createSessionResultSchema>;

export const hostLabelValueSchema = z.string().min(1).max(256);
export const hostLabelsSchema = z
  .record(z.string().min(1).max(128), hostLabelValueSchema)
  .superRefine((value, ctx) => {
    if (Object.keys(value).length > 24) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "labels may contain at most 24 entries.",
      });
    }
  });
export type HostLabels = z.infer<typeof hostLabelsSchema>;

export const hostRegistrationSchema = z.object({
  hostId: z.string().min(1),
  name: z.string().min(1),
  apiUrl: z.string().url(),
  mode: agentModeSchema,
  region: z.string().min(1).max(64).optional(),
  instanceType: z.string().min(1).max(128).optional(),
  labels: hostLabelsSchema.optional(),
  supportedRuntimeProfiles: z.array(z.string().min(1).max(128)).max(64).optional(),
  capacity: z.object({
    maxSessions: z.number().int().positive(),
    maxRendererCount: z.number().int().positive().default(8),
    sessionMemoryLimitMb: z.number().int().positive().default(512),
    sessionShmLimitMb: z.number().int().positive().default(128),
    sessionRendererLimit: z.number().int().positive().default(2),
    minFreeMemoryMb: z.number().int().nonnegative().default(512),
    maxShmUtilizationPct: z.number().int().min(1).max(100).default(90),
    maxCrashCount5m: z.number().int().nonnegative().default(3),
    maxMicrovmCount: z.number().int().nonnegative().default(0),
    microvmMemoryMb: z.number().int().nonnegative().default(0),
    microvmVcpuCount: z.number().int().nonnegative().default(0),
    /** 0 = unlimited. When >0, new sessions are rejected while this many sessions are in `active-navigation`. */
    maxConcurrentActiveNavigation: z.number().int().nonnegative().default(0),
  }),
});
export type HostRegistration = z.infer<typeof hostRegistrationSchema>;

export const hostHeartbeatSchema = z.object({
  hostId: z.string(),
  mode: agentModeSchema,
  status: z.enum(["healthy", "degraded", "no-admit", "draining"]),
  capacity: hostRegistrationSchema.shape.capacity,
  metrics: z.object({
    totalMemoryMb: z.number().nonnegative(),
    freeMemoryMb: z.number().nonnegative(),
    usedMemoryMb: z.number().nonnegative(),
    memoryPressurePct: z.number().min(0).max(100),
    shmCapacityMb: z.number().nonnegative(),
    shmUsedMb: z.number().nonnegative(),
    activeSessions: z.number().int().nonnegative(),
    activeRendererCount: z.number().int().nonnegative().default(0),
    trackedMemoryMb: z.number().nonnegative().default(0),
    trackedShmUsedMb: z.number().nonnegative().default(0),
    crashCount5m: z.number().int().nonnegative(),
    activeMicrovmCount: z.number().int().nonnegative().default(0),
    reservedMicrovmMemoryMb: z.number().nonnegative().default(0),
    avgRestoreMs: z.number().nonnegative().default(0),
    cpuUtilizationPct: z.number().min(0).max(100).default(0),
    loadAvg1m: z.number().nonnegative().default(0),
    loadAvg5m: z.number().nonnegative().default(0),
    highPrioritySessionCount: z.number().int().nonnegative().default(0),
    /** Sessions currently in `active-navigation` (concurrent page work / goto pressure). */
    activeNavigationSessionCount: z.number().int().nonnegative().default(0),
    /** Explicit cold-create admission left after current local reservations. */
    coldAdmitRemaining: z.number().int().nonnegative().default(0),
    /** Runtime-profile keyed warm readiness reported by the node agent. */
    warmPools: z
      .array(
        z.object({
          runtimeProfile: z.string().min(1).max(128),
          readyCount: z.number().int().nonnegative(),
          targetCount: z.number().int().nonnegative(),
          refillInFlight: z.number().int().nonnegative(),
        }),
      )
      .max(64)
      .default([]),
  }),
  reportedAt: z.string(),
});
export type HostHeartbeat = z.infer<typeof hostHeartbeatSchema>;

export const runtimeLaunchResultSchema = z.object({
  sessionId: z.string(),
  containerId: z.string(),
  containerName: z.string(),
  runtimeKind: runtimeKindSchema.default("container"),
  connectUrl: z.string().url(),
  cdpUrl: z.string().url(),
  playwrightUrl: z.string().url(),
  puppeteerUrl: z.string().url(),
  debugHttpUrl: z.string().url(),
  startedAt: z.string(),
  launchTimings: launchTimingSchema.optional(),
});
export type RuntimeLaunchResult = z.infer<typeof runtimeLaunchResultSchema>;

export const sessionRecordSchema = z.object({
  sessionId: z.string(),
  browser: browserKindSchema,
  status: sessionStatusSchema,
  hostId: z.string(),
  connectUrl: z.string().url(),
  cdpUrl: z.string().url(),
  playwrightUrl: z.string().url(),
  puppeteerUrl: z.string().url(),
  debugHttpUrl: z.string().url(),
  keepAlive: z.boolean(),
  timeoutSec: z.number().int().positive(),
  idleTimeoutSec: z.number().int().positive(),
  proxyProfile: z.string().optional(),
  runtimeProfile: z.string().optional(),
  region: z.string().optional(),
  provider: providerSessionMetadataSchema.optional(),
  sessionTags: providerSessionTagsSchema.optional(),
  createdAt: z.string(),
  expiresAt: z.string(),
  endedAt: z.string().optional(),
  containerId: z.string(),
  containerName: z.string(),
  runtimeKind: runtimeKindSchema.default("container"),
  launchTimings: launchTimingSchema.optional(),
  controlPlaneTimings: controlPlaneTimingSchema.optional(),
  exitReason: z.string().optional(),
  recentLogs: sessionLogSnapshotSchema.optional(),
  lastKnownMetrics: z
    .object({
      memoryMb: z.number().nonnegative(),
      cpuPct: z.number().nonnegative(),
      rendererCount: z.number().int().nonnegative(),
      shmUsedMb: z.number().nonnegative(),
      memoryLimitMb: z.number().int().positive(),
      shmLimitMb: z.number().int().positive(),
      activityState: sessionActivityStateSchema.default("interactive-idle"),
      schedulerWeight: z.number().int().min(-20).max(19).default(0),
    })
    .optional(),
});
export type SessionRecord = z.infer<typeof sessionRecordSchema>;

export const sessionEventRecordSchema = z.object({
  eventId: z.string(),
  sessionId: z.string(),
  ts: z.string(),
  source: z.enum(["control-plane", "node-agent", "runtime", "benchmark"]),
  type: sessionEventTypeSchema,
  status: sessionStatusSchema.optional(),
  activityState: sessionActivityStateSchema.optional(),
  exitReason: z.string().optional(),
  data: providerEventDataSchema.optional(),
});
export type SessionEventRecord = z.infer<typeof sessionEventRecordSchema>;

export const sessionMetricsSummarySchema = z.object({
  sessionId: z.string(),
  status: sessionStatusSchema,
  browser: browserKindSchema,
  hostId: z.string(),
  runtimeKind: runtimeKindSchema.default("container"),
  runtimeProfile: z.string().optional(),
  region: z.string().optional(),
  proxyProfile: z.string().optional(),
  provider: providerSessionMetadataSchema.optional(),
  sessionTags: providerSessionTagsSchema.optional(),
  createdAt: z.string(),
  expiresAt: z.string(),
  endedAt: z.string().optional(),
  launchTimings: launchTimingSchema.optional(),
  controlPlaneTimings: controlPlaneTimingSchema.optional(),
  recentLogs: sessionLogSnapshotSchema.optional(),
  usage: z
    .object({
      memoryMb: z.number().nonnegative(),
      cpuPct: z.number().nonnegative(),
      rendererCount: z.number().int().nonnegative(),
      shmUsedMb: z.number().nonnegative(),
      memoryLimitMb: z.number().int().positive(),
      shmLimitMb: z.number().int().positive(),
      activityState: sessionActivityStateSchema.default("interactive-idle"),
      schedulerWeight: z.number().int().min(-20).max(19).default(0),
    })
    .optional(),
  result: z
    .object({
      exitReason: z.string().optional(),
      crashed: z.boolean(),
    })
    .optional(),
});
export type SessionMetricsSummary = z.infer<typeof sessionMetricsSummarySchema>;

export const dashboardExportSchema = z.object({
  generatedAt: z.string(),
  sessions: z.array(sessionRecordSchema),
  metrics: z.array(sessionMetricsSummarySchema),
  events: z.array(sessionEventRecordSchema),
});
export type DashboardExport = z.infer<typeof dashboardExportSchema>;

export const hostRecordSchema = z.object({
  hostId: z.string(),
  name: z.string(),
  apiUrl: z.string().url(),
  mode: agentModeSchema,
  region: z.string().min(1).max(64).optional(),
  instanceType: z.string().min(1).max(128).optional(),
  labels: hostLabelsSchema.optional(),
  supportedRuntimeProfiles: z.array(z.string().min(1).max(128)).max(64).optional(),
  allowlisted: z.boolean().default(false),
  enabled: z.boolean().default(true),
  status: z.enum(["healthy", "degraded", "no-admit", "draining"]),
  capacity: hostRegistrationSchema.shape.capacity,
  metrics: hostHeartbeatSchema.shape.metrics,
  registeredAt: z.string(),
  reportedAt: z.string(),
});
export type HostRecord = z.infer<typeof hostRecordSchema>;

export const providerHostConfigEntrySchema = z.object({
  hostId: z.string().min(1),
  apiUrl: z.string().url().optional(),
  mode: agentModeSchema.optional(),
  region: z.string().min(1).max(64).optional(),
  instanceType: z.string().min(1).max(128).optional(),
  enabled: z.boolean().default(true),
  labels: hostLabelsSchema.optional(),
  supportedRuntimeProfiles: z.array(z.string().min(1).max(128)).max(64).optional(),
});
export type ProviderHostConfigEntry = z.infer<typeof providerHostConfigEntrySchema>;

export const providerHostConfigSchema = z.array(providerHostConfigEntrySchema);
export type ProviderHostConfig = z.infer<typeof providerHostConfigSchema>;

export const idempotencyRecordSchema = z.object({
  scopeKey: z.string().min(1).max(256),
  idempotencyKey: z.string().min(1).max(256),
  method: z.enum(["POST", "DELETE"]),
  route: z.string().min(1).max(256),
  requestHash: z.string().min(1).max(128),
  sessionId: z.string().optional(),
  responseStatus: z.number().int().min(100).max(599),
  createdAt: z.string(),
});
export type IdempotencyRecord = z.infer<typeof idempotencyRecordSchema>;

export const hostCreateReservationSchema = z.object({
  reservationId: z.string(),
  sessionId: z.string().uuid(),
  hostId: z.string().min(1),
  runtimeProfile: z.string().min(1).max(128).optional(),
  preferredRegion: z.string().min(1).max(64).optional(),
  warmExpected: z.boolean().default(false),
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type HostCreateReservation = z.infer<typeof hostCreateReservationSchema>;

export const hostDeleteReservationSchema = z.object({
  reservationId: z.string(),
  sessionId: z.string().uuid(),
  hostId: z.string().min(1),
  runtimeKind: z.enum(["container", "microvm"]),
  rendererCount: z.number().int().nonnegative().default(1),
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type HostDeleteReservation = z.infer<typeof hostDeleteReservationSchema>;

export const stateFileSchema = z.object({
  sessions: z.record(sessionRecordSchema),
  hosts: z.record(hostRecordSchema),
  sessionEvents: z.record(z.array(sessionEventRecordSchema)).default({}),
  idempotencyRecords: z.record(idempotencyRecordSchema).default({}),
  hostCreateReservations: z.record(hostCreateReservationSchema).default({}),
  hostDeleteReservations: z.record(hostDeleteReservationSchema).default({}),
});
export type StateFile = z.infer<typeof stateFileSchema>;
