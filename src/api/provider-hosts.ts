import fs from "node:fs";

import {
  providerHostConfigSchema,
  type HostRecord,
  type ProviderHostConfigEntry,
} from "../shared/types.js";

export class ProviderHostAllowlist {
  readonly #entries = new Map<string, ProviderHostConfigEntry>();

  readonly #enforced: boolean;

  constructor(entries: ProviderHostConfigEntry[], enforced: boolean) {
    for (const entry of entries) {
      this.#entries.set(entry.hostId, entry);
    }
    this.#enforced = enforced || this.#entries.size > 0;
  }

  static load(configPath: string, enforced: boolean): ProviderHostAllowlist {
    if (!fs.existsSync(configPath)) {
      return new ProviderHostAllowlist([], enforced);
    }

    const raw = fs.readFileSync(configPath, "utf8").trim();
    if (!raw) {
      return new ProviderHostAllowlist([], enforced);
    }

    const parsed = providerHostConfigSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      throw new Error(`Invalid provider host config at ${configPath}: ${parsed.error.message}`);
    }

    return new ProviderHostAllowlist(parsed.data, enforced);
  }

  get enforced(): boolean {
    return this.#enforced;
  }

  list(): ProviderHostConfigEntry[] {
    return [...this.#entries.values()].sort((left, right) => left.hostId.localeCompare(right.hostId));
  }

  get(hostId: string): ProviderHostConfigEntry | undefined {
    return this.#entries.get(hostId);
  }

  isAllowed(hostId: string): boolean {
    if (!this.#enforced) {
      return true;
    }

    const entry = this.#entries.get(hostId);
    return Boolean(entry?.enabled);
  }

  enrichRegisteredHost(input: HostRecord): HostRecord {
    const entry = this.#entries.get(input.hostId);
    return {
      ...input,
      apiUrl: entry?.apiUrl ?? input.apiUrl,
      mode: entry?.mode ?? input.mode,
      region: entry?.region ?? input.region,
      instanceType: entry?.instanceType ?? input.instanceType,
      labels: entry?.labels ?? input.labels,
      supportedRuntimeProfiles: entry?.supportedRuntimeProfiles ?? input.supportedRuntimeProfiles,
      allowlisted: Boolean(entry),
      enabled: entry?.enabled ?? true,
    };
  }
}
