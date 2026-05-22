import crypto from "node:crypto";
import fs from "node:fs";

import { z } from "zod";

import type {
  CreateSessionRequest,
  HostRecord,
  ProviderSessionMetadata,
  SessionRecord,
} from "../shared/types.js";

const providerApiKeyConfigEntrySchema = z.object({
  keyId: z.string().min(1).max(128),
  apiKey: z.string().min(1).max(512),
  enabled: z.boolean().default(true),
  name: z.string().min(1).max(128).optional(),
  tenantId: z.string().min(1).max(128).optional(),
  projectId: z.string().min(1).max(128).optional(),
  upstreamProvider: z.string().min(1).max(128).optional(),
  allowedRegions: z.array(z.string().min(1).max(64)).max(64).optional(),
  allowedRuntimeProfiles: z.array(z.string().min(1).max(128)).max(128).optional(),
});

const providerApiKeyConfigSchema = z.array(providerApiKeyConfigEntrySchema);

export type ProviderApiKeyConfigEntry = z.infer<typeof providerApiKeyConfigEntrySchema>;

export type PartnerAuthContext = {
  keyId: string;
  name?: string;
  tenantId?: string;
  projectId?: string;
  upstreamProvider?: string;
  allowedRegions?: string[];
  allowedRuntimeProfiles?: string[];
};

export type PartnerSessionQuery = {
  status?: SessionRecord["status"];
  limit?: number;
  providerSessionId?: string;
  workflowId?: string;
  tenantId?: string;
  projectId?: string;
  upstreamProvider?: string;
  runtimeProfile?: string;
  region?: string;
};

function readHeaderValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const raw = headers[name];
  if (Array.isArray(raw)) {
    return raw[0];
  }
  return raw;
}

function extractApiKey(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const explicit = readHeaderValue(headers, "x-baselayer-api-key");
  if (explicit) {
    return explicit.trim();
  }

  const auth = readHeaderValue(headers, "authorization");
  if (!auth) {
    return undefined;
  }

  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

function matchesApiKey(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(actual, "utf8");
  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function sessionMatchesPartnerScope(
  session: SessionRecord,
  auth?: PartnerAuthContext,
): boolean {
  if (!auth) {
    return true;
  }

  if (auth.tenantId && session.provider?.tenantId !== auth.tenantId) {
    return false;
  }

  if (auth.projectId && session.provider?.projectId !== auth.projectId) {
    return false;
  }

  if (auth.upstreamProvider && session.provider?.upstreamProvider !== auth.upstreamProvider) {
    return false;
  }

  if (
    auth.allowedRegions &&
    auth.allowedRegions.length > 0 &&
    session.region &&
    !auth.allowedRegions.includes(session.region)
  ) {
    return false;
  }

  if (
    auth.allowedRuntimeProfiles &&
    auth.allowedRuntimeProfiles.length > 0 &&
    session.runtimeProfile &&
    !auth.allowedRuntimeProfiles.includes(session.runtimeProfile)
  ) {
    return false;
  }

  return true;
}

export function filterSessionsForPartner(
  sessions: SessionRecord[],
  query: PartnerSessionQuery,
  auth?: PartnerAuthContext,
): SessionRecord[] {
  return sessions
    .filter((session) => sessionMatchesPartnerScope(session, auth))
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
    .filter((session) => (query.region ? session.region === query.region : true))
    .slice(0, typeof query.limit === "number" && Number.isFinite(query.limit) ? query.limit : undefined);
}

export function filterHostsForPartner(
  hosts: HostRecord[],
  auth?: PartnerAuthContext,
): HostRecord[] {
  if (!auth) {
    return hosts;
  }

  return hosts.filter((host) => {
    if (auth.allowedRegions && auth.allowedRegions.length > 0) {
      if (!host.region || !auth.allowedRegions.includes(host.region)) {
        return false;
      }
    }

    if (auth.allowedRuntimeProfiles && auth.allowedRuntimeProfiles.length > 0) {
      if (
        !host.supportedRuntimeProfiles ||
        host.supportedRuntimeProfiles.length === 0 ||
        !host.supportedRuntimeProfiles.some((profile) =>
          auth.allowedRuntimeProfiles!.includes(profile),
        )
      ) {
        return false;
      }
    }

    return true;
  });
}

function mergeProviderScope(
  provider: ProviderSessionMetadata | undefined,
  auth: PartnerAuthContext | undefined,
): ProviderSessionMetadata | undefined {
  if (!auth) {
    return provider;
  }

  const merged: ProviderSessionMetadata = {
    ...(provider ?? {}),
  };

  if (auth.tenantId) {
    if (merged.tenantId && merged.tenantId !== auth.tenantId) {
      throw new Error("Tenant scope mismatch.");
    }
    merged.tenantId = auth.tenantId;
  }

  if (auth.projectId) {
    if (merged.projectId && merged.projectId !== auth.projectId) {
      throw new Error("Project scope mismatch.");
    }
    merged.projectId = auth.projectId;
  }

  if (auth.upstreamProvider) {
    if (merged.upstreamProvider && merged.upstreamProvider !== auth.upstreamProvider) {
      throw new Error("Upstream provider scope mismatch.");
    }
    merged.upstreamProvider = auth.upstreamProvider;
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function applyPartnerScopeToCreateRequest(
  request: CreateSessionRequest,
  auth?: PartnerAuthContext,
): CreateSessionRequest {
  if (!auth) {
    return request;
  }

  if (
    auth.allowedRegions &&
    auth.allowedRegions.length > 0 &&
    request.region &&
    !auth.allowedRegions.includes(request.region)
  ) {
    throw new Error("Region is not allowed for this partner key.");
  }

  if (
    auth.allowedRuntimeProfiles &&
    auth.allowedRuntimeProfiles.length > 0 &&
    request.runtimeProfile &&
    !auth.allowedRuntimeProfiles.includes(request.runtimeProfile)
  ) {
    throw new Error("Runtime profile is not allowed for this partner key.");
  }

  return {
    ...request,
    provider: mergeProviderScope(request.provider, auth),
  };
}

export class ProviderApiKeyStore {
  readonly #entries: ProviderApiKeyConfigEntry[];

  readonly enforced: boolean;

  constructor(entries: ProviderApiKeyConfigEntry[], enforced: boolean) {
    this.#entries = entries.filter((entry) => entry.enabled);
    this.enforced = enforced;
  }

  static load(configPath: string, enforced: boolean): ProviderApiKeyStore {
    if (!fs.existsSync(configPath)) {
      return new ProviderApiKeyStore([], enforced);
    }

    try {
      const raw = fs.readFileSync(configPath, "utf8");
      const parsed = providerApiKeyConfigSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        console.error(
          `[provider-auth] Invalid partner API key config at ${configPath}; ignoring entries.`,
        );
        return new ProviderApiKeyStore([], enforced);
      }
      return new ProviderApiKeyStore(parsed.data, enforced);
    } catch (error) {
      console.error(
        `[provider-auth] Failed to load partner API key config at ${configPath}; ignoring entries.`,
        error,
      );
      return new ProviderApiKeyStore([], enforced);
    }
  }

  get required(): boolean {
    return this.enforced || this.#entries.length > 0;
  }

  authenticate(
    headers: Record<string, string | string[] | undefined>,
  ): PartnerAuthContext | undefined {
    const apiKey = extractApiKey(headers);
    if (!apiKey) {
      return undefined;
    }

    const match = this.#entries.find((entry) => matchesApiKey(entry.apiKey, apiKey));
    if (!match) {
      return undefined;
    }

    return {
      keyId: match.keyId,
      name: match.name,
      tenantId: match.tenantId,
      projectId: match.projectId,
      upstreamProvider: match.upstreamProvider,
      allowedRegions: match.allowedRegions,
      allowedRuntimeProfiles: match.allowedRuntimeProfiles,
    };
  }
}

export function canPartnerAccessSession(
  session: SessionRecord,
  auth?: PartnerAuthContext,
): boolean {
  return sessionMatchesPartnerScope(session, auth);
}
