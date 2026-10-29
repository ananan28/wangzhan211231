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
    readonly code?: string,
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
  planQuota: number;
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

export interface NanfuMember {
  userId: string; email: string; identity: string; roleId: string | null; roleName: string | null;
  managerUserId: string | null; quota: number; used: number; status: string; locked: boolean;
  /** The name the organization calls this person; null means "use the login". */
  displayName: string | null;
}

export interface NanfuOrgOverview {
  members: NanfuMember[];
  roles: { id: string; name: string; permissions: string[] }[];
  groups: { id: string; name: string }[];
  grants: { groupId: string; userId: string }[];
  invites: { code: string; identity: string; expiresAt: string; redeemedBy: string | null }[];
}

export interface NanfuEnvTransfer {
  id: string; environmentId: string; fromUserId: string; toUserId: string; status: string;
  forced: boolean; note: string; createdAt: string; resolvedAt: string | null;
}

/** Sealed cloud packages: the database column allows 28M characters. */
export const NANFU_CLOUD_PAYLOAD_MAX = 28_000_000;
const NANFU_CLOUD_TIMEOUT_MS = 180_000;

export interface NanfuCloudTransferRow {
  id: string;
  environmentId: string;
  environmentName: string;
  senderEmail: string;
  recipientEmail: string;
  status: "pending" | "accepted" | "revoked" | string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
}

function cloudTransferRow(row: any): NanfuCloudTransferRow {
  return {
    id: String(row.id),
    environmentId: String(row.environment_id ?? ""),
    environmentName: String(row.environment_name ?? ""),
    senderEmail: String(row.sender_email ?? ""),
    recipientEmail: String(row.recipient_email ?? ""),
    status: String(row.status ?? "pending"),
    createdAt: String(row.created_at ?? ""),
    expiresAt: String(row.expires_at ?? ""),
    acceptedAt: typeof row.accepted_at === "string" ? row.accepted_at : null,
  };
}

export const NANFU_TRANSFER_MAX_BATCH = 200;
export const NANFU_TRANSFER_NOTE_MAX = 500;
export const NANFU_ENVIRONMENT_ID_MAX = 128;

const NANFU_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isNanfuUuid(value: string): boolean {
  return NANFU_UUID_RE.test(value);
}

/** Same bounds the database enforces; reject before spending a round trip. */
export function normalizeNanfuEnvironmentId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id || Array.from(id).length > NANFU_ENVIRONMENT_ID_MAX || /[\x00-\x1f\x7f]/.test(id)) {
    throw new NanfuSyncError("环境编号无效：须为1至128个可打印字符", 400);
  }
  return id;
}

export function normalizeNanfuRecipient(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!isNanfuUuid(id)) throw new NanfuSyncError("接收成员编号无效", 400);
  return id;
}

export function normalizeNanfuTransferNote(value: unknown, optional = true): string {
  if (value === undefined || value === null || value === "") {
    if (optional) return "";
    throw new NanfuSyncError("请填写转移备注", 400);
  }
  if (typeof value !== "string") throw new NanfuSyncError("备注须为文本", 400);
  const note = value.trim();
  if (Array.from(note).length > NANFU_TRANSFER_NOTE_MAX) {
    throw new NanfuSyncError(`备注最多${NANFU_TRANSFER_NOTE_MAX}个字符`, 400);
  }
  return note;
}

export function normalizeNanfuEnvironmentIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new NanfuSyncError("请选择要转移的环境", 400);
  const ids = [...new Set(value.map(normalizeNanfuEnvironmentId))];
  if (ids.length === 0) throw new NanfuSyncError("请选择要转移的环境", 400);
  if (ids.length > NANFU_TRANSFER_MAX_BATCH) {
    throw new NanfuSyncError(`一次最多转移${NANFU_TRANSFER_MAX_BATCH}个环境`, 400);
  }
  return ids;
}

export interface NanfuMemberInput {
  userId: string; identity?: "admin" | "manager" | "member"; roleId?: string;
  managerUserId?: string; status?: "active" | "disabled"; locked?: boolean;
  /** Empty string clears the name; omitted leaves it unchanged. */
  name?: string;
  /** Disabling an employee also hands their windows to the owner. */
  reclaim?: boolean;
}

export interface NanfuInviteInput {
  identity: "admin" | "manager" | "member"; roleId?: string; managerUserId?: string; quota: number; hours: number;
}

/**
 * A directly created account. `email` also accepts a bare login name for
 * sub-accounts; the database stores it as <name>@nanfu.local.
 */
export interface NanfuAccountInput {
  email: string;
  password: string;
  identity: "admin" | "member";
  quota: number;
  /** Set for a sub-account: the member or administrator it belongs to. */
  managerUserId?: string;
  /** Role permission set; omitted means the organization defaults. */
  roleId?: string;
  /** Window groups the account may see; omitted or empty means none. */
  groupIds?: string[];
  /** Display name; omitted means the roster shows the login. */
  name?: string;
}

export interface NanfuCreatedAccount {
  userId: string;
  email: string;
  identity: string;
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

  async createOrg(name: string, signal?: AbortSignal): Promise<string> {
    const orgId = await this.visibleRequest("/rpc/nanfu_org_create", { method: "POST", body: JSON.stringify({ p_name: name }), signal });
    if (typeof orgId !== "string" || !orgId) throw new NanfuSyncError("Invalid organization creation response", 502);
    return orgId;
  }

  /** Joins the default organization, or hands back the one already held. */
  selfJoinOrg(signal?: AbortSignal): Promise<string> {
    return this.rpcValue("nanfu_org_self_join", {}, "string", signal);
  }

  async orgMe(signal?: AbortSignal): Promise<NanfuOrganization | null> {
    const rows = await this.visibleRequest("/rpc/nanfu_org_me", { method: "POST", body: "{}", signal });
    if (!Array.isArray(rows)) throw new NanfuSyncError("Invalid organization response", 502);
    const row = rows[0];
    if (!row) return null;
    if (typeof row.org_id !== "string" || typeof row.identity !== "string" || typeof row.status !== "string" || typeof row.locked !== "boolean") {
      throw new NanfuSyncError("Invalid organization response", 502);
    }
    const query = new URLSearchParams({ select: "id,name,plan_env_max", id: `eq.${row.org_id}` });
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
      planQuota: Number(organizations[0]?.plan_env_max ?? 0),
      status: row.status,
      locked: row.locked,
    };
  }

  async orgOverview(orgId: string, signal?: AbortSignal): Promise<NanfuOrgOverview> {
    const [members, roles, groups, grants, invites] = await Promise.all([
      this.readMembers(signal),
      this.readOrgTable("nanfu_org_roles", "id,name,permissions", orgId, signal),
      this.readOrgTable("nanfu_org_groups", "id,name", orgId, signal),
      this.readOrgTable("nanfu_org_group_grants", "group_id,user_id", orgId, signal, "group_id.asc,user_id.asc"),
      this.readOrgTable("nanfu_org_invites", "code,identity,expires_at,redeemed_by", orgId, signal, "code.asc"),
    ]);
    if (!Array.isArray(members)) throw new NanfuSyncError("Invalid member response", 502);
    return {
      members: members.map(row => ({
        userId: String(row.user_id), email: String(row.email ?? ""), identity: String(row.identity),
        roleId: typeof row.role_id === "string" ? row.role_id : null, roleName: typeof row.role_name === "string" ? row.role_name : null,
        managerUserId: typeof row.manager_user_id === "string" ? row.manager_user_id : null,
        displayName: typeof row.display_name === "string" && row.display_name ? row.display_name : null,
        quota: Number(row.env_quota), used: Number(row.used), status: String(row.status), locked: row.locked === true,
      })),
      roles: roles.map(row => ({ id: String(row.id), name: String(row.name), permissions: Array.isArray(row.permissions) ? row.permissions.filter((p: unknown) => typeof p === "string") : [] })),
      groups: groups.map(row => ({ id: String(row.id), name: String(row.name) })),
      grants: grants.map(row => ({ groupId: String(row.group_id), userId: String(row.user_id) })),
      invites: invites.map(row => ({ code: String(row.code), identity: String(row.identity), expiresAt: String(row.expires_at), redeemedBy: typeof row.redeemed_by === "string" ? row.redeemed_by : null })),
    };
  }

  async transfers(orgId: string, signal?: AbortSignal): Promise<NanfuEnvTransfer[]> {
    const rows = await this.readOrgTable("nanfu_env_transfers", "id,environment_id,from_user_id,to_user_id,status,forced,note,created_at,resolved_at", orgId, signal);
    return rows.map(row => ({ id: String(row.id), environmentId: String(row.environment_id), fromUserId: String(row.from_user_id),
      toUserId: String(row.to_user_id), status: String(row.status), forced: row.forced === true, note: String(row.note ?? ""),
      createdAt: String(row.created_at), resolvedAt: typeof row.resolved_at === "string" ? row.resolved_at : null }));
  }

  /** Register this device's public transfer key so others can seal packages to it. */
  async publishTransferKey(userId: string, publicKey: string, signal?: AbortSignal): Promise<void> {
    if (!isNanfuUuid(userId)) throw new NanfuSyncError("账号编号无效", 400);
    if (typeof publicKey !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(publicKey)) {
      throw new NanfuSyncError("转移公钥无效", 400);
    }
    await this.request("/nanfu_transfer_keys?on_conflict=user_id", {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([{ user_id: userId, public_key: publicKey }]),
      signal,
    });
  }

  /** The recipient's published transfer key, or null when they never opened the app. */
  async transferPublicKey(userId: string, signal?: AbortSignal): Promise<string | null> {
    if (!isNanfuUuid(userId)) throw new NanfuSyncError("接收成员编号无效", 400);
    const query = new URLSearchParams({ select: "public_key", user_id: `eq.${userId}` });
    const rows = await this.request(`/nanfu_transfer_keys?${query}`, { method: "GET", signal });
    if (!Array.isArray(rows)) throw new NanfuSyncError("Invalid transfer key response", 502);
    const key = rows[0]?.public_key;
    return typeof key === "string" && key ? key : null;
  }

  /** Store one sealed package for a recipient; the payload is already ciphertext. */
  async sendCloudTransfer(input: {
    id: string; senderId: string; senderEmail: string; recipientEmail: string;
    environmentId: string; environmentName: string; payload: string;
  }, signal?: AbortSignal): Promise<string> {
    if (!isNanfuUuid(input.id)) throw new NanfuSyncError("转移编号无效", 400);
    if (!isNanfuUuid(input.senderId)) throw new NanfuSyncError("发送账号编号无效", 400);
    const email = typeof input.recipientEmail === "string" ? input.recipientEmail.trim().toLowerCase() : "";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 320) {
      throw new NanfuSyncError("接收成员没有可用邮箱，无法定向发送", 400);
    }
    if (!input.payload || input.payload.length > NANFU_CLOUD_PAYLOAD_MAX) {
      throw new NanfuSyncError("转移数据超过云端上限，请移除较大的扩展后再发送", 413);
    }
    const rows = await this.request("/nanfu_transfers", {
      method: "POST",
      headers: { prefer: "return=representation" },
      body: JSON.stringify([{
        id: input.id,
        sender_id: input.senderId,
        sender_email: input.senderEmail.slice(0, 320),
        recipient_email: email,
        environment_id: normalizeNanfuEnvironmentId(input.environmentId),
        environment_name: input.environmentName.slice(0, 200),
        payload: input.payload,
      }]),
      signal,
    }, NANFU_CLOUD_TIMEOUT_MS);
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row || typeof row.id !== "string") throw new NanfuSyncError("南孚服务没有返回转移记录", 502);
    return row.id;
  }

  /** Pending packages addressed to this account. */
  async incomingCloudTransfers(signal?: AbortSignal): Promise<NanfuCloudTransferRow[]> {
    const query = new URLSearchParams({
      select: "id,environment_id,environment_name,sender_email,status,created_at,expires_at,accepted_at",
      status: "eq.pending", order: "created_at.desc", limit: "100",
    });
    const rows = await this.request(`/nanfu_transfers?${query}`, { method: "GET", signal });
    if (!Array.isArray(rows)) throw new NanfuSyncError("Invalid transfer list response", 502);
    return rows.map(cloudTransferRow);
  }

  /** Every package this account sent, with its current status. */
  async sentCloudTransfers(userId: string, signal?: AbortSignal): Promise<NanfuCloudTransferRow[]> {
    const query = new URLSearchParams({
      select: "id,environment_id,environment_name,recipient_email,status,created_at,expires_at,accepted_at",
      sender_id: `eq.${userId}`, order: "created_at.desc", limit: "100",
    });
    const rows = await this.request(`/nanfu_transfers?${query}`, { method: "GET", signal });
    if (!Array.isArray(rows)) throw new NanfuSyncError("Invalid transfer list response", 502);
    return rows.map(cloudTransferRow);
  }

  /** The sealed payload of one pending package addressed to this account. */
  async cloudTransferPayload(id: string, signal?: AbortSignal): Promise<{ row: NanfuCloudTransferRow; payload: string }> {
    if (!isNanfuUuid(id)) throw new NanfuSyncError("转移编号无效", 400);
    const query = new URLSearchParams({
      select: "id,environment_id,environment_name,sender_email,status,created_at,expires_at,accepted_at,payload",
      id: `eq.${id}`,
    });
    const rows = await this.request(`/nanfu_transfers?${query}`, { method: "GET", signal }, NANFU_CLOUD_TIMEOUT_MS);
    if (!Array.isArray(rows)) throw new NanfuSyncError("Invalid transfer response", 502);
    const row = rows[0];
    if (!row) throw new NanfuSyncError("this transfer no longer exists", 404, false, "P0002");
    if (typeof row.payload !== "string" || !row.payload) throw new NanfuSyncError("Invalid transfer payload", 502);
    return { row: cloudTransferRow(row), payload: row.payload };
  }

  /** Accept through the database function: the only path that pins the recipient. */
  async acceptCloudTransfer(id: string, signal?: AbortSignal): Promise<NanfuCloudTransferRow> {
    if (!isNanfuUuid(id)) throw new NanfuSyncError("转移编号无效", 400);
    const rows = await this.request("/rpc/nanfu_accept_transfer", {
      method: "POST", body: JSON.stringify({ p_id: id }), signal,
    }, NANFU_CLOUD_TIMEOUT_MS);
    if (!Array.isArray(rows) || !rows[0]) throw new NanfuSyncError("Invalid transfer response", 502);
    const row = rows[0];
    return cloudTransferRow({
      id,
      environment_id: row.environment_id,
      environment_name: row.environment_name,
      sender_email: row.sender_email,
      status: "accepted",
      created_at: row.accepted_at,
      expires_at: row.accepted_at,
      accepted_at: row.accepted_at,
    });
  }

  async revokeCloudTransfer(id: string, signal?: AbortSignal): Promise<void> {
    if (!isNanfuUuid(id)) throw new NanfuSyncError("转移编号无效", 400);
    await this.request(`/nanfu_transfers?id=eq.${id}`, {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ status: "revoked" }),
      signal,
    });
  }

  createRole(name: string, permissions: string[], signal?: AbortSignal): Promise<string> {
    return this.rpcValue("nanfu_org_create_role", { p_name: name, p_permissions: permissions }, "string", signal);
  }

  async setMember(input: NanfuMemberInput, signal?: AbortSignal): Promise<void> {
    await this.visibleRequest("/rpc/nanfu_org_set_member", { method: "POST", signal, body: JSON.stringify({
      p_user: input.userId, p_identity: input.identity ?? null, p_role: input.roleId ?? null,
      p_manager: input.managerUserId ?? null, p_status: input.status ?? null, p_locked: input.locked ?? null,
      p_name: input.name ?? null, p_reclaim: input.reclaim === true,
    }) });
  }

  async setQuota(userId: string, quota: number, signal?: AbortSignal): Promise<void> {
    await this.visibleRequest("/rpc/nanfu_org_set_quota", { method: "POST", signal, body: JSON.stringify({ p_user: userId, p_quota: quota }) });
  }

  createGroup(name: string, signal?: AbortSignal): Promise<string> {
    return this.rpcValue("nanfu_org_create_group", { p_name: name }, "string", signal);
  }

  async grantGroup(groupId: string, userId: string, granted: boolean, signal?: AbortSignal): Promise<void> {
    await this.visibleRequest("/rpc/nanfu_org_grant_group", { method: "POST", signal, body: JSON.stringify({ p_group: groupId, p_user: userId, p_granted: granted }) });
  }

  async createAccount(input: NanfuAccountInput, signal?: AbortSignal): Promise<NanfuCreatedAccount> {
    const rows = await this.visibleRequest("/rpc/nanfu_org_create_account", {
      method: "POST",
      body: JSON.stringify({
        p_email: input.email,
        p_password: input.password,
        p_identity: input.identity,
        p_quota: input.quota,
        p_parent: input.managerUserId ?? null,
        p_role: input.roleId ?? null,
        p_groups: input.groupIds?.length ? input.groupIds : null,
        p_name: input.name?.trim() || null,
      }),
      signal,
    });
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row || typeof row.user_id !== "string" || typeof row.email !== "string") {
      throw new NanfuSyncError("Invalid account response", 502);
    }
    return { userId: row.user_id, email: row.email, identity: String(row.identity ?? input.identity) };
  }

  /** Replaces the employee's password; the old one stops working immediately. */
  async resetMemberPassword(userId: string, password: string, signal?: AbortSignal): Promise<void> {
    if (!isNanfuUuid(userId)) throw new NanfuSyncError("账号编号无效", 400);
    if (typeof password !== "string" || password.length < 6 || password.length > 72) {
      throw new NanfuSyncError("密码须为 6 至 72 个字符", 400);
    }
    await this.visibleRequest("/rpc/nanfu_org_reset_password", {
      method: "POST", signal, body: JSON.stringify({ p_user: userId, p_password: password }),
    });
  }

  /** Replaces the set of window groups the employee is authorized to see. */
  async setMemberGroups(userId: string, groupIds: string[], signal?: AbortSignal): Promise<void> {
    if (!isNanfuUuid(userId)) throw new NanfuSyncError("账号编号无效", 400);
    if (!Array.isArray(groupIds) || groupIds.some(id => !isNanfuUuid(id))) {
      throw new NanfuSyncError("分组编号无效", 400);
    }
    await this.visibleRequest("/rpc/nanfu_org_set_member_groups", {
      method: "POST", signal,
      body: JSON.stringify({ p_user: userId, p_groups: groupIds.length ? [...new Set(groupIds)] : null }),
    });
  }

  createInvite(input: NanfuInviteInput, signal?: AbortSignal): Promise<string> {
    return this.rpcValue("nanfu_org_create_invite", { p_identity: input.identity, p_role: input.roleId ?? null, p_manager: input.managerUserId ?? null, p_quota: input.quota, p_hours: input.hours }, "string", signal);
  }

  /** The name this account signs in with, or null when it uses its address. */
  async loginName(signal?: AbortSignal): Promise<string | null> {
    const value = await this.visibleRequest("/rpc/nanfu_login_name_me", { method: "POST", body: "{}", signal });
    return typeof value === "string" && value ? value : null;
  }

  /** Chooses the sign-in name; the service refuses sub-accounts and collisions. */
  setLoginName(name: string, signal?: AbortSignal): Promise<string> {
    return this.rpcValue("nanfu_login_set_name", { p_name: name }, "string", signal);
  }

  async clearLoginName(signal?: AbortSignal): Promise<void> {
    await this.visibleRequest("/rpc/nanfu_login_clear_name", { method: "POST", body: "{}", signal });
  }

  redeemInvite(code: string, signal?: AbortSignal): Promise<string> {
    return this.rpcValue("nanfu_org_redeem_invite", { p_code: code }, "string", signal);
  }

  removeMember(userId: string, reclaim: boolean, signal?: AbortSignal): Promise<number> {
    return this.rpcValue("nanfu_org_remove_member", { p_user: userId, p_reclaim: reclaim }, "number", signal);
  }

  async requestTransfer(environmentId: string, toUserId: string, signal?: AbortSignal): Promise<string> {
    return this.rpcValue("nanfu_env_transfer_request", {
      p_environment_id: normalizeNanfuEnvironmentId(environmentId),
      p_to: normalizeNanfuRecipient(toUserId),
    }, "string", signal);
  }

  async respondTransfer(id: string, accept: boolean, signal?: AbortSignal): Promise<"accepted" | "rejected"> {
    if (!isNanfuUuid(id)) throw new NanfuSyncError("转移记录编号无效", 400);
    if (typeof accept !== "boolean") throw new NanfuSyncError("请选择接受或拒绝", 400);
    const status = await this.rpcValue("nanfu_env_transfer_respond", { p_id: id, p_accept: accept }, "string", signal);
    if (status !== "accepted" && status !== "rejected") throw new NanfuSyncError("Invalid transfer response", 502);
    return status;
  }

  async forceTransfer(environmentId: string, toUserId: string, note: string, signal?: AbortSignal): Promise<number> {
    return this.rpcValue("nanfu_env_transfer_force", {
      p_environment_id: normalizeNanfuEnvironmentId(environmentId),
      p_to: normalizeNanfuRecipient(toUserId),
      p_note: normalizeNanfuTransferNote(note),
    }, "number", signal);
  }

  async batchTransfer(environmentIds: readonly string[], toUserId: string, note = "", signal?: AbortSignal): Promise<number> {
    return this.rpcValue("nanfu_env_transfer_batch", {
      p_environment_ids: normalizeNanfuEnvironmentIds(environmentIds),
      p_to: normalizeNanfuRecipient(toUserId),
      p_note: normalizeNanfuTransferNote(note),
    }, "number", signal);
  }

  private async rpcValue<T extends "string" | "number">(rpc: string, body: object, kind: T, signal?: AbortSignal): Promise<T extends "string" ? string : number> {
    const value = await this.visibleRequest(`/rpc/${rpc}`, { method: "POST", body: JSON.stringify(body), signal });
    if (typeof value !== kind || (kind === "string" ? !value : !Number.isSafeInteger(value) || value < 0)) throw new NanfuSyncError("Invalid operation response", 502);
    return value;
  }

  private async readMembers(signal?: AbortSignal): Promise<any[]> {
    const all: any[] = [];
    for (let offset = 0; ; offset += 500) {
      const query = new URLSearchParams({ order: "user_id.asc", limit: "500", offset: String(offset) });
      const rows = await this.visibleRequest(`/rpc/nanfu_org_overview?${query}`, { method: "POST", body: "{}", signal });
      if (!Array.isArray(rows)) throw new NanfuSyncError("Invalid member response", 502);
      all.push(...rows);
      if (rows.length < 500) return all;
    }
  }

  private async readOrgTable(table: string, select: string, orgId: string, signal?: AbortSignal, order = "id.asc"): Promise<any[]> {
    const all: any[] = [];
    for (let offset = 0; ; offset += 500) {
      const query = new URLSearchParams({ select, org_id: `eq.${orgId}`, order, limit: "500", offset: String(offset) });
      const rows = await this.visibleRequest(`/${table}?${query}`, { method: "GET", signal });
      if (!Array.isArray(rows)) throw new NanfuSyncError("Invalid organization table response", 502);
      all.push(...rows);
      if (rows.length < 500) return all;
    }
  }

  async visibleEnvironments(orgId: string, signal?: AbortSignal): Promise<NanfuVisibleEnvironment[]> {
    return this.readEnvironments(orgId, { order: "environment_id.asc,owner_user_id.asc" }, signal);
  }

  /** One employee's windows. Row-level security still decides what the caller may see. */
  async memberEnvironments(orgId: string, userId: string, signal?: AbortSignal): Promise<NanfuVisibleEnvironment[]> {
    if (!isNanfuUuid(userId)) throw new NanfuSyncError("账号编号无效", 400);
    return this.readEnvironments(orgId, { ownerUserId: userId, order: "environment_id.asc" }, signal);
  }

  private async readEnvironments(orgId: string, filter: { ownerUserId?: string; order: string }, signal?: AbortSignal): Promise<NanfuVisibleEnvironment[]> {
    const result: NanfuVisibleEnvironment[] = [];
    for (let offset = 0; ; offset += 500) {
      const query = new URLSearchParams({
        select: "environment_id,owner_user_id,org_id,group_id,version,updated_at",
        org_id: `eq.${orgId}`, deleted: "eq.false", order: filter.order,
        limit: "500", offset: String(offset),
      });
      if (filter.ownerUserId) query.set("owner_user_id", `eq.${filter.ownerUserId}`);
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

  private async request(path: string, init: RequestInit, timeoutMs = this.requestTimeoutMs): Promise<any> {
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
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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
        let code: string | undefined;
        try {
          const body = JSON.parse(text);
          if (typeof body?.code === "string") code = body.code;
          if (typeof body?.message === "string") {
            code = /^(NANFU_[A-Z_]+):/.exec(body.message)?.[1] ?? code;
            if (body.message === "NANFU_FORBIDDEN: this account already belongs to an organization") code = "ORG_ALREADY_MEMBER";
            if (body.message === "this invite has expired") code = "INVITE_EXPIRED";
            if (body.message === "this invite has already been used") code = "INVITE_USED";
            if (body.message === "this invite does not exist") code = "P0002";
            if (body.message === "this transfer has expired") code = "TRANSFER_EXPIRED";
          }
        } catch {}
        throw new NanfuSyncError(
          text.trim() || `Nanfu sync request failed (${response.status})`,
          response.status,
          undefined,
          code,
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
