/**
 * Local routes for environment transfers and `.nanfu-env` packages.
 *
 * They live behind their own `/ui/api/nanfu-transfer/` prefix so the account
 * and organization handlers stay untouched. The same local protections apply:
 * a JSON content type for mutations and an Origin check, then the Nanfu session
 * check on every request.
 */

import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  NanfuSyncError,
  exportNanfuEnvironment,
  normalizeNanfuEnvironmentId,
  normalizeNanfuEnvironmentIds,
  normalizeNanfuRecipient,
  normalizeNanfuTransferNote,
  type NanfuOrganization,
  type NanfuSyncClient,
  type NanfuVisibleEnvironment,
} from "./nanfu-sync.ts";
import {
  NanfuEnvPackageError,
  collectNanfuEnvFiles,
  createNanfuEnvPackage,
  nanfuEnvPackageFileName,
  parseNanfuEnvPackage,
  planNanfuEnvImport,
  writeNanfuEnvFiles,
  type NanfuEnvFile,
  type NanfuEnvPackage,
} from "./nanfu-env-package.ts";
import type { NanfuRuntime } from "./nanfu-service.ts";
import type { StatePaths } from "./paths.ts";
import type { ProfileStore } from "./store.ts";
import type { Profile, ProxyType } from "./types.ts";

export const NANFU_TRANSFER_ROUTE_PREFIX = "/ui/api/nanfu-transfer/";

export interface NanfuTransferRouteContext {
  nanfu?: NanfuRuntime;
  store: ProfileStore;
  paths?: StatePaths;
}

class NanfuTransferHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "NanfuTransferHttpError";
  }
}

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function failure(error: unknown): Response {
  if (error instanceof NanfuTransferHttpError) return reply({ ok: false, error: error.message }, error.status);
  if (error instanceof NanfuEnvPackageError) {
    const status = error.code === "limit" ? 413 : error.code === "signature" ? 422 : 400;
    return reply({ ok: false, error: error.message, code: error.code }, status);
  }
  if (error instanceof NanfuSyncError) return syncFailure(error);
  const message = error instanceof Error ? error.message : "转移操作失败，请重试";
  return reply({ ok: false, error: message, retryable: true }, 502);
}

function syncFailure(error: NanfuSyncError): Response {
  const code = error.code ?? "";
  const message = error.message;
  const status = (() => {
    if (code === "NANFU_FORBIDDEN" || code === "42501" || error.status === 403) return 403;
    if (code === "NANFU_MEMBER_INACTIVE" || code === "NANFU_ENV_QUOTA" || code === "NANFU_ORG_QUOTA") return 409;
    if (code === "P0002") return 404;
    if (code === "28000" || error.status === 401) return 401;
    if (/no longer pending|已被处理/i.test(message)) return 409;
    if (/expired|过期/i.test(message)) return 409;
    if (/only the recipient|addressed to you/i.test(message)) return 403;
    if (/owner can offer/i.test(message)) return 403;
    if (/cannot be transferred to its owner/i.test(message)) return 400;
    if (/not in this organization/i.test(message)) return 404;
    if (/not visible|does not exist|no longer exists/i.test(message)) return 404;
    if (error.status >= 400 && error.status < 500) return 400;
    return 502;
  })();
  const readable = (() => {
    if (code === "NANFU_FORBIDDEN" || code === "42501") return "没有权限执行此转移：只有环境所有者或组织管理员可以操作。";
    if (code === "NANFU_MEMBER_INACTIVE") return "接收成员已被禁用或锁定，无法接收环境。";
    if (code === "NANFU_ENV_QUOTA") return "接收成员的窗口配额已满，无法接收更多环境。";
    if (code === "NANFU_ORG_QUOTA") return "组织窗口总配额已满，无法继续转移。";
    if (code === "P0002") return "转移记录或环境不存在，可能已被删除。";
    if (code === "28000" || status === 401) return "登录已失效，请重新登录南孚账号。";
    if (/no longer pending|已被处理/i.test(message)) return "该转移已被处理，请刷新列表后再试。";
    if (/expired|过期/i.test(message)) return "该转移已过期，请让原所有者重新发起。";
    if (/only the recipient|addressed to you/i.test(message)) return "只有接收人可以处理这条转移。";
    if (/owner can offer/i.test(message)) return "只有环境所有者可以发起这条转移。";
    if (/cannot be transferred to its owner/i.test(message)) return "不能把环境转移给它的当前所有者。";
    if (/not in this organization/i.test(message)) return "目标成员不在当前组织中。";
    if (/not visible|does not exist|no longer exists/i.test(message)) return "环境不存在、已被删除，或不在你的管理范围内。";
    if (status === 403) return "当前账号没有执行此转移的权限。";
    if (status === 400) return message;
    return "南孚服务暂时不可用，转移结果未确认；请刷新列表后再决定是否重试。";
  })();
  return reply({ ok: false, error: readable, code: code || undefined, retryable: status === 502 }, status);
}

function isMutation(req: Request): boolean {
  return req.method !== "GET";
}

function checkLocalRequest(req: Request): Response | null {
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin) return reply({ ok: false, error: "禁止跨站访问转移接口" }, 403);
  if (isMutation(req) && !req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return reply({ ok: false, error: "转移接口需要 application/json" }, 415);
  }
  return null;
}

async function bodyOf(req: Request): Promise<Record<string, unknown>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new NanfuTransferHttpError(400, "请求内容不是有效 JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new NanfuTransferHttpError(400, "请求参数无效");
  return raw as Record<string, unknown>;
}

async function requireOrganization(client: NanfuSyncClient, signal?: AbortSignal): Promise<NanfuOrganization> {
  const organization = await client.orgMe(signal);
  if (!organization) throw new NanfuTransferHttpError(403, "当前账号尚未加入组织，无法转移环境。");
  if (organization.locked || organization.status !== "active") {
    throw new NanfuTransferHttpError(403, "账号在组织中已锁定或停用，不能转移环境。");
  }
  return organization;
}

function adminOnly(organization: NanfuOrganization): void {
  if (organization.identity !== "owner" && organization.identity !== "admin") {
    throw new NanfuTransferHttpError(403, "只有组织所有者或管理员可以强制/批量转移环境。");
  }
}

function visibleMap(environments: readonly NanfuVisibleEnvironment[]): Map<string, NanfuVisibleEnvironment> {
  const map = new Map<string, NanfuVisibleEnvironment>();
  for (const environment of environments) map.set(environment.id, environment);
  return map;
}

function requireVisible(map: Map<string, NanfuVisibleEnvironment>, id: string): NanfuVisibleEnvironment {
  const environment = map.get(id);
  if (!environment) throw new NanfuTransferHttpError(404, "环境不存在、已删除，或不在你的管理范围内。");
  return environment;
}

interface RecipientRow {
  userId: string;
  email: string;
  identity: string;
  status: string;
  locked: boolean;
}

/** Admins see every member; ordinary members only see themselves/subtree plus environment owners. */
async function recipientDirectory(
  client: NanfuSyncClient,
  organization: NanfuOrganization,
  visible: readonly NanfuVisibleEnvironment[],
  signal?: AbortSignal,
): Promise<RecipientRow[]> {
  const overview = await client.orgOverview(organization.orgId, signal).catch(() => null);
  const rows = new Map<string, RecipientRow>();
  for (const member of overview?.members ?? []) {
    rows.set(member.userId, {
      userId: member.userId, email: member.email, identity: member.identity,
      status: member.status, locked: member.locked,
    });
  }
  for (const environment of visible) {
    if (rows.has(environment.ownerUserId)) continue;
    rows.set(environment.ownerUserId, {
      userId: environment.ownerUserId, email: "", identity: "member", status: "active", locked: false,
    });
  }
  return [...rows.values()]
    .filter((row) => !row.locked && row.status !== "disabled")
    .sort((left, right) => (left.email || left.userId).localeCompare(right.email || right.userId));
}

function memberLookup(rows: readonly RecipientRow[]): Map<string, RecipientRow> {
  const map = new Map<string, RecipientRow>();
  for (const row of rows) map.set(row.userId, row);
  return map;
}

function environmentName(pkg: NanfuEnvPackage): string {
  return pkg.environment.name;
}

async function exportEnvironment(
  store: ProfileStore,
  environmentId: string,
): Promise<{ fileName: string; package: NanfuEnvPackage }> {
  const profile = store.getProfile(environmentId);
  if (!profile) throw new NanfuTransferHttpError(404, "该环境不在本机，无法导出。");
  if (profile.engine === "firefox") throw new NanfuTransferHttpError(400, "当前版本只支持导出 Chromium 环境配置。");
  const names = new Map<string, string>();
  for (const extension of store.listExtensions()) names.set(extension.id, extension.name);
  const environment = exportNanfuEnvironment(profile, names, new Date().toISOString());
  const archives: Array<{ name: string; files: NanfuEnvFile[] }> = [];
  for (const extensionId of profile.extensions ?? []) {
    const extension = store.getExtension(extensionId);
    if (!extension) continue;
    let files: NanfuEnvFile[];
    try {
      files = await collectNanfuEnvFiles(extension.loadDir);
    } catch (error) {
      if (error instanceof NanfuEnvPackageError) throw error;
      throw new NanfuTransferHttpError(404, `扩展“${extension.name}”的文件不在本机，无法导出该环境。`);
    }
    archives.push({ name: extension.name, files });
  }
  const pkg = createNanfuEnvPackage({ environment, extensionArchives: archives });
  return { fileName: nanfuEnvPackageFileName(profile.name, pkg.header.createdAt), package: pkg };
}

async function importEnvironment(
  store: ProfileStore,
  paths: StatePaths,
  pkg: NanfuEnvPackage,
): Promise<{ profileId: string; name: string; renamed: boolean }> {
  const environment = pkg.environment;
  if (environment.engine !== "chromium") throw new NanfuTransferHttpError(400, "当前版本只支持导入 Chromium 环境配置。");
  const profiles = store.listProfiles();
  const plan = planNanfuEnvImport(pkg, {
    takenIds: [...profiles.map((profile) => profile.id), ...store.listTrashed().map((row) => row.id)],
    takenNames: [...profiles.map((profile) => profile.name), ...store.listTrashed().map((row) => row.name)],
  });
  await mkdir(paths.extensions, { recursive: true });
  const installed: Array<{ id: string; dir: string }> = [];
  const extensionIds: string[] = [];
  try {
    for (const archive of pkg.extensionArchives) {
      const id = `ext${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const dir = resolve(paths.extensions, id);
      await writeNanfuEnvFiles(dir, archive.files);
      installed.push({ id, dir });
      store.addExtension({ id, name: archive.name, loadDir: dir });
      extensionIds.push(id);
    }
    const profile: Profile = {
      id: plan.id,
      engine: "chromium",
      accId: "",
      name: plan.name,
      group: environment.group,
      platform: environment.platform,
      username: "",
      password: "",
      twofa: "",
      proxy: environment.proxy
        ? {
            type: environment.proxy.type as ProxyType,
            host: environment.proxy.host, port: environment.proxy.port,
            user: environment.proxy.user, pass: environment.proxy.pass,
          }
        : null,
      extensions: extensionIds,
      tags: [...environment.tags],
      ua: environment.ua,
      timezone: environment.timezone,
      locale: environment.locale,
      screenWidth: environment.screen.width,
      screenHeight: environment.screen.height,
      fingerprintSeed: environment.fingerprint.seed,
      ...(environment.fingerprint.platformOs ? { platformOs: environment.fingerprint.platformOs } : {}),
      ...(environment.fingerprint.hardwareCores ? { hardware: { cores: environment.fingerprint.hardwareCores } } : {}),
      cookies: [],
      seeded: false,
    };
    store.upsertProfile(profile);
    return { profileId: plan.id, name: plan.name, renamed: plan.renamed };
  } catch (error) {
    for (const extension of installed) {
      store.deleteExtension(extension.id);
      await rm(extension.dir, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }
}

export async function handleNanfuTransferRequest(
  req: Request,
  context: NanfuTransferRouteContext,
): Promise<Response> {
  const guarded = checkLocalRequest(req);
  if (guarded) return guarded;
  const nanfu = context.nanfu;
  if (!nanfu) return reply({ ok: false, error: "南孚账号服务未配置" }, 503);
  const { account, client } = nanfu;
  const userId = account.state().userId;
  if (!account.state().authenticated || !userId) return reply({ ok: false, error: "请先登录南孚账号" }, 401);
  const { pathname } = new URL(req.url);
  const action = pathname.slice(NANFU_TRANSFER_ROUTE_PREFIX.length);
  try {
    const signal = req.signal;
    if (req.method === "GET" && action === "inbox") {
      const organization = await requireOrganization(client, signal);
      const [transfers, visible] = await Promise.all([
        client.transfers(organization.orgId, signal),
        client.visibleEnvironments(organization.orgId, signal),
      ]);
      const members = await recipientDirectory(client, organization, visible, signal);
      const byId = memberLookup(members);
      const rows = transfers.map((transfer) => ({
        ...transfer,
        fromEmail: byId.get(transfer.fromUserId)?.email ?? "",
        toEmail: byId.get(transfer.toUserId)?.email ?? "",
      }));
      return reply({
        ok: true, userId, organization, members, visibleEnvironments: visible,
        inbox: rows.filter((row) => row.toUserId === userId),
        sent: rows.filter((row) => row.fromUserId === userId),
      });
    }

    if (req.method === "POST" && action === "request") {
      const body = await bodyOf(req);
      const environmentId = normalizeNanfuEnvironmentId(body.environmentId);
      const toUserId = normalizeNanfuRecipient(body.toUserId);
      if (toUserId === userId) throw new NanfuTransferHttpError(400, "不能把环境转移给自己。");
      const organization = await requireOrganization(client, signal);
      const visible = await client.visibleEnvironments(organization.orgId, signal);
      const environment = requireVisible(visibleMap(visible), environmentId);
      if (environment.ownerUserId !== userId) throw new NanfuTransferHttpError(403, "只能转移自己拥有的环境。");
      const transferId = await client.requestTransfer(environmentId, toUserId, signal);
      return reply({ ok: true, transferId });
    }

    if (req.method === "POST" && action === "batch") {
      const body = await bodyOf(req);
      const environmentIds = normalizeNanfuEnvironmentIds(body.environmentIds);
      const toUserId = normalizeNanfuRecipient(body.toUserId);
      const note = normalizeNanfuTransferNote(body.note);
      const organization = await requireOrganization(client, signal);
      adminOnly(organization);
      const visible = visibleMap(await client.visibleEnvironments(organization.orgId, signal));
      for (const id of environmentIds) requireVisible(visible, id);
      const moved = await client.batchTransfer(environmentIds, toUserId, note, signal);
      return reply({ ok: true, moved });
    }

    if (req.method === "POST" && action === "force") {
      const body = await bodyOf(req);
      const environmentId = normalizeNanfuEnvironmentId(body.environmentId);
      const toUserId = normalizeNanfuRecipient(body.toUserId);
      const note = normalizeNanfuTransferNote(body.note);
      const organization = await requireOrganization(client, signal);
      adminOnly(organization);
      requireVisible(visibleMap(await client.visibleEnvironments(organization.orgId, signal)), environmentId);
      const moved = await client.forceTransfer(environmentId, toUserId, note, signal);
      return reply({ ok: true, moved });
    }

    if (req.method === "POST" && action === "respond") {
      const body = await bodyOf(req);
      if (typeof body.accept !== "boolean") throw new NanfuTransferHttpError(400, "请选择接受或拒绝。");
      const status = await client.respondTransfer(String(body.transferId ?? ""), body.accept, signal);
      return reply({ ok: true, status });
    }

    if (req.method === "POST" && action === "export") {
      const body = await bodyOf(req);
      const environmentId = normalizeNanfuEnvironmentId(body.environmentId);
      const result = await exportEnvironment(context.store, environmentId);
      return reply({ ok: true, ...result });
    }

    if (req.method === "POST" && action === "import") {
      const body = await bodyOf(req);
      const text = typeof body.package === "string" ? body.package : JSON.stringify(body.package ?? null);
      const pkg = parseNanfuEnvPackage(text);
      if (!context.paths) throw new NanfuTransferHttpError(503, "当前运行模式没有可用的本机扩展目录，无法导入。");
      const result = await importEnvironment(context.store, context.paths, pkg);
      return reply({ ok: true, ...result, environmentName: environmentName(pkg) });
    }

    return reply({ ok: false, error: "未知转移接口" }, 404);
  } catch (error) {
    return failure(error);
  }
}
