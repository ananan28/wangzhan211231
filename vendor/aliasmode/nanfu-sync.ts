/**
 * Nanfu environment sync.
 *
 * Only a strict allowlist of environment *configuration* leaves the machine:
 * name, group, engine, UA, screen, timezone, locale, fingerprint seed, tags,
 * proxy settings, and the names (never the files) of assigned extensions.
 * Account credentials, cookies, 2FA seeds, session bundles and cached browser
 * data are structurally impossible to include because the exporter never reads
 * those fields.
 *
 * Payloads are encrypted on the client with a key derived from the user's sync
 * passphrase (scrypt + AES-256-GCM); the server stores ciphertext only.
 */

import { normalizeSecureServiceUrl } from "./app-config.ts";
import { NanfuCipher, NanfuDecryptError, createNanfuKeyParams, type NanfuKeyParams } from "./nanfu-crypto.ts";
import type { Profile } from "./types.ts";

export {
  NanfuCipher as NanfuSyncCipher,
  NanfuDecryptError as NanfuSyncDecryptError,
  createNanfuKeyParams as createNanfuSyncKeyParams,
  type NanfuKeyParams as NanfuSyncKeyParams,
};

export const NANFU_SYNC_SCHEMA = 1;
export const NANFU_SYNC_TABLE = "nanfu_environments";

export interface NanfuEnvironmentProxy {
  type: string;
  host: string;
  port: string;
  user: string;
  pass: string;
}

export interface NanfuEnvironmentConfig {
  schema: typeof NANFU_SYNC_SCHEMA;
  id: string;
  name: string;
  group: string;
  engine: "chromium" | "firefox";
  platform: string;
  ua: string;
  timezone: string;
  locale: string;
  screen: { width: number; height: number };
  fingerprint: { seed: number; platformOs?: string; hardwareCores?: number };
  tags: string[];
  /** Extension names for reference on another device; archives are never synced. */
  extensions: string[];
  proxy: NanfuEnvironmentProxy | null;
  updatedAt: string;
}

/**
 * Build the syncable view of one profile. `extensionNames` maps local extension
 * ids to their display names; ids are per-machine and must not travel.
 */
export function exportNanfuEnvironment(
  profile: Profile,
  extensionNames: ReadonlyMap<string, string>,
  updatedAt: string,
): NanfuEnvironmentConfig {
  const names = new Set<string>();
  for (const id of profile.extensions ?? []) {
    const name = extensionNames.get(id);
    if (name) names.add(name);
  }
  const seed = Number.isFinite(profile.fingerprintSeed) ? Math.trunc(profile.fingerprintSeed) : 0;
  return {
    schema: NANFU_SYNC_SCHEMA,
    id: profile.id,
    name: profile.name,
    group: profile.group,
    engine: profile.engine === "firefox" ? "firefox" : "chromium",
    platform: profile.platform ?? "",
    ua: profile.ua,
    timezone: profile.timezone,
    locale: profile.locale ?? "",
    screen: { width: profile.screenWidth, height: profile.screenHeight },
    fingerprint: {
      seed,
      ...(profile.platformOs ? { platformOs: profile.platformOs } : {}),
      ...(profile.hardware ? { hardwareCores: profile.hardware.cores } : {}),
    },
    tags: [...(profile.tags ?? [])],
    extensions: [...names].sort(),
    proxy: profile.proxy
      ? {
          type: profile.proxy.type,
          host: profile.proxy.host,
          port: profile.proxy.port,
          user: profile.proxy.user,
          pass: profile.proxy.pass,
        }
      : null,
    updatedAt,
  };
}

/** Local side of one environment: the last server version this device saw. */
export interface NanfuLocalRecord {
  id: string;
  version: number;
  envelope: string;
  /** The local environment changed since `version` was acknowledged. */
  dirty: boolean;
  deleted?: boolean;
}

export interface NanfuRemoteRecord {
  id: string;
  version: number;
  updatedAt: string;
  envelope: string;
  deleted?: boolean;
}

export interface NanfuSyncPlan {
  push: NanfuLocalRecord[];
  pull: NanfuRemoteRecord[];
  unchanged: string[];
  /** Ids both sides changed; the higher version wins, local wins a tie. */
  conflicts: string[];
}

/**
 * Versioned last-write-wins. Versions only ever increase, so a device never
 * needs synchronized wall clocks: a remote row strictly ahead means another
 * device wrote later; otherwise a dirty local row is the newest write.
 */
export function planNanfuSync(
  local: readonly NanfuLocalRecord[],
  remote: readonly NanfuRemoteRecord[],
): NanfuSyncPlan {
  const remoteById = new Map(remote.map((row) => [row.id, row]));
  const localIds = new Set(local.map((row) => row.id));
  const plan: NanfuSyncPlan = { push: [], pull: [], unchanged: [], conflicts: [] };
  for (const item of local) {
    const other = remoteById.get(item.id);
    if (!other) {
      if (item.deleted) {
        plan.unchanged.push(item.id);
      } else {
        plan.push.push(item);
      }
      continue;
    }
    if (item.deleted) {
      if (other.version > item.version) plan.pull.push(other);
      else plan.push.push(item);
      continue;
    }
    if (item.dirty) {
      if (other.version > item.version) plan.conflicts.push(item.id);
      plan.push.push(item);
      continue;
    }
    if (other.version > item.version) {
      plan.pull.push(other);
      continue;
    }
    plan.unchanged.push(item.id);
  }
  for (const row of remote) {
    if (!localIds.has(row.id)) plan.pull.push(row);
  }
  return plan;
}

export type NanfuSyncFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface NanfuSyncClientOptions {
  baseUrl: string;
  anonKey: string;
  accessToken: () => Promise<string | undefined>;
  fetchFn?: NanfuSyncFetch;
  requestTimeoutMs?: number;
  table?: string;
}

export class NanfuSyncError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly unauthorized = status === 401 || status === 403,
  ) {
    super(message);
    this.name = "NanfuSyncError";
  }
}

export interface NanfuOrganization {
  orgId: string;
  name: string;
  identity: string;
  roleName: string | null;
  permissions: string[];
  quota: number;
  used: number;
  status: string;
  locked: boolean;
}

export interface NanfuVisibleEnvironment {
  id: string;
  ownerUserId: string;
  orgId: string;
  groupId: string | null;
  version: number;
  updatedAt: string;
}

export class NanfuSyncClient {
  private readonly visibleRequests = new Set<AbortController>();
  private readonly baseUrl: string;
  private readonly table: string;
  private readonly fetchFn: NanfuSyncFetch;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: NanfuSyncClientOptions) {
    this.baseUrl = normalizeSecureServiceUrl(options.baseUrl, "Nanfu sync service");
    this.table = options.table ?? NANFU_SYNC_TABLE;
    this.fetchFn = options.fetchFn ?? ((url, init) => fetch(url, init));
    this.requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? 30_000);
  }

  cancelVisibleRequests(): void {
    for (const controller of this.visibleRequests) controller.abort();
    this.visibleRequests.clear();
  }

  async organization(signal?: AbortSignal): Promise<NanfuOrganization | null> {
    const rows = await this.visibleRequest("/rpc/nanfu_org_me", { method: "POST", body: "{}", signal });
    if (!Array.isArray(rows)) throw new NanfuSyncError("Invalid organization response", 502);
    const row = rows[0];
    if (!row) return null;
    if (typeof row.org_id !== "string" || typeof row.identity !== "string" || typeof row.status !== "string" || typeof row.locked !== "boolean") {
      throw new NanfuSyncError("Invalid organization response", 502);
    }
    const query = new URLSearchParams({ select: "id,name", id: `eq.${row.org_id}` });
    const organizations = row.locked || row.status !== "active"
      ? [] : await this.visibleRequest(`/nanfu_orgs?${query}`, { method: "GET", signal });
    if (!Array.isArray(organizations)) throw new NanfuSyncError("Invalid organization response", 502);
    return {
      orgId: row.org_id,
      name: typeof organizations[0]?.name === "string" ? organizations[0].name : row.org_id,
      identity: row.identity,
      roleName: typeof row.role_name === "string" ? row.role_name : null,
      permissions: Array.isArray(row.permissions) ? row.permissions.filter((v: unknown) => typeof v === "string") : [],
      quota: Number(row.env_quota),
      used: Number(row.used),
      status: row.status,
      locked: row.locked,
    };
  }

  async visibleEnvironments(orgId: string, signal?: AbortSignal): Promise<NanfuVisibleEnvironment[]> {
    const result: NanfuVisibleEnvironment[] = [];
    for (let offset = 0; ; offset += 500) {
      const query = new URLSearchParams({
        select: "environment_id,owner_user_id,org_id,group_id,version,updated_at",
        org_id: `eq.${orgId}`, deleted: "eq.false", order: "environment_id.asc,owner_user_id.asc",
        limit: "500", offset: String(offset),
      });
      const rows = await this.visibleRequest(`/${this.table}?${query}`, { method: "GET", signal });
      if (!Array.isArray(rows)) throw new NanfuSyncError("Invalid environment response", 502);
      for (const row of rows) {
        if (typeof row.environment_id !== "string" || typeof row.owner_user_id !== "string" || row.org_id !== orgId) {
          throw new NanfuSyncError("Invalid environment response", 502);
        }
        result.push({
          id: row.environment_id, ownerUserId: row.owner_user_id, orgId: row.org_id,
          groupId: typeof row.group_id === "string" ? row.group_id : null,
          version: Number(row.version), updatedAt: String(row.updated_at ?? ""),
        });
      }
      if (rows.length < 500) return result;
    }
  }

  private async visibleRequest(path: string, init: RequestInit): Promise<any> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (init.signal?.aborted) controller.abort();
    init.signal?.addEventListener("abort", cancel, { once: true });
    this.visibleRequests.add(controller);
    try {
      return await this.request(path, { ...init, signal: controller.signal });
    } finally {
      init.signal?.removeEventListener("abort", cancel);
      this.visibleRequests.delete(controller);
    }
  }

  async list(userId: string): Promise<NanfuRemoteRecord[]> {
    const query = new URLSearchParams({
      select: "environment_id,version,updated_at,device_id,payload,deleted",
      owner_user_id: `eq.${userId}`,
      order: "environment_id.asc",
    });
    const rows = await this.request(`/${this.table}?${query}`, { method: "GET" });
    if (!Array.isArray(rows)) throw new NanfuSyncError("Nanfu sync service returned an unexpected list", 502);
    return rows.map((row: any) => ({
      id: String(row.environment_id),
      version: Number(row.version),
      updatedAt: String(row.updated_at ?? ""),
      envelope: typeof row.payload === "string" ? row.payload : "",
      ...(row.deleted === true ? { deleted: true } : {}),
    }));
  }

  async upsert(userId: string, deviceId: string, record: NanfuLocalRecord): Promise<NanfuRemoteRecord> {
    const rows = await this.request(
      `/${this.table}?on_conflict=owner_user_id,environment_id`,
      {
        method: "POST",
        headers: { prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify([{
          owner_user_id: userId,
          environment_id: record.id,
          version: record.version + 1,
          device_id: deviceId,
          payload: record.deleted ? "" : record.envelope,
          deleted: record.deleted === true,
        }]),
      },
    );
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) throw new NanfuSyncError("Nanfu sync service did not return the stored environment", 502);
    return {
      id: String(row.environment_id),
      version: Number(row.version),
      updatedAt: String(row.updated_at ?? ""),
      envelope: typeof row.payload === "string" ? row.payload : "",
      ...(row.deleted === true ? { deleted: true } : {}),
    };
  }

  async remove(userId: string, id: string): Promise<void> {
    const query = new URLSearchParams({
      owner_user_id: `eq.${userId}`,
      environment_id: `eq.${id}`,
    });
    await this.request(`/${this.table}?${query}`, { method: "DELETE" });
  }

  private async request(path: string, init: RequestInit): Promise<any> {
    const token = await this.options.accessToken();
    if (!token) throw new NanfuSyncError("Sign in before syncing", 401);
    const headers = new Headers(init.headers);
    headers.set("apikey", this.options.anonKey);
    headers.set("authorization", `Bearer ${token}`);
    headers.set("content-type", "application/json");
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (init.signal?.aborted) controller.abort();
    init.signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
    try {
      if (controller.signal.aborted) throw new NanfuSyncError("Request cancelled", 0);
      let response: Response;
      try {
        response = await this.fetchFn(`${this.baseUrl}/rest/v1${path}`, { ...init, headers, signal: controller.signal });
      } catch (error) {
        throw new NanfuSyncError(`Nanfu sync service could not be reached: ${(error as Error)?.message ?? error}`, 0);
      }
      if (response.status === 204) return null;
      const text = await response.text();
      if (!response.ok) {
        throw new NanfuSyncError(
          text.trim() || `Nanfu sync request failed (${response.status})`,
          response.status,
        );
      }
      if (!text.trim()) return null;
      try {
        return JSON.parse(text);
      } catch {
        throw new NanfuSyncError("Nanfu sync service returned non-JSON", 502);
      }
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", cancel);
    }
  }
}

export interface NanfuSyncResult {
  state: NanfuLocalRecord[];
  pushed: number;
  pulled: number;
  conflicts: string[];
}

/**
 * Push local edits and apply newer remote environments. Pulled payloads are
 * decrypted before the local record is marked clean, so a wrong passphrase
 * fails loudly instead of silently overwriting readable data.
 */
export async function syncNanfuEnvironments(options: {
  local: readonly NanfuLocalRecord[];
  client: NanfuSyncClient;
  cipher: NanfuCipher;
  userId: string;
  deviceId: string;
}): Promise<NanfuSyncResult> {
  const remote = await options.client.list(options.userId);
  const plan = planNanfuSync(options.local, remote);
  const state = new Map(options.local.map((row) => [row.id, { ...row }] as const));
  for (const row of plan.push) {
    const stored = await options.client.upsert(options.userId, options.deviceId, row);
    state.set(row.id, {
      id: row.id,
      version: stored.version,
      envelope: stored.envelope,
      dirty: false,
      ...(stored.deleted ? { deleted: true } : {}),
    });
  }
  for (const row of plan.pull) {
    if (!row.deleted) {
      const config = options.cipher.decrypt<NanfuEnvironmentConfig>(row.envelope);
      if (config?.schema !== NANFU_SYNC_SCHEMA) {
        throw new Error("This environment was written by an unsupported Nanfu version");
      }
    }
    state.set(row.id, {
      id: row.id,
      version: row.version,
      envelope: row.envelope,
      dirty: false,
      ...(row.deleted ? { deleted: true } : {}),
    });
  }
  return {
    state: [...state.values()],
    pushed: plan.push.length,
    pulled: plan.pull.length,
    conflicts: plan.conflicts,
  };
}
