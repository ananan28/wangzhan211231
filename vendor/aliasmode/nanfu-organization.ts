import { NanfuSyncClient, NanfuSyncError } from "./nanfu-sync.ts";

export const NANFU_ORGANIZATION_ACTIONS = [
  "create-organization", "create-role", "set-member", "set-quota", "create-group", "grant-group",
  "create-invite", "redeem-invite", "remove-member", "request-transfer", "respond-transfer", "force-transfer",
] as const;
export type NanfuOrganizationAction = typeof NANFU_ORGANIZATION_ACTIONS[number];

export class NanfuInputError extends Error {}

export async function mutateNanfuOrganization(client: NanfuSyncClient, action: NanfuOrganizationAction, raw: unknown, signal?: AbortSignal): Promise<unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new NanfuInputError("请输入有效的操作参数");
  const body = raw as Record<string, unknown>;
  const text = (key: string, max: number, optional = false): string => {
    const value = body[key];
    if (optional && (value === undefined || value === null || value === "")) return "";
    if (typeof value !== "string" || !value.trim() || Array.from(value.trim()).length > max) throw new NanfuInputError(`${key} 须为1至${max}个字符`);
    return value.trim();
  };
  const uuid = (key: string, optional = false): string | undefined => {
    const value = text(key, 36, optional);
    if (!value && optional) return undefined;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new NanfuInputError(`${key} 必须是有效账号或记录编号`);
    return value;
  };
  const integer = (key: string, min = 0, max = 2_147_483_647): number => {
    const value = body[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new NanfuInputError(`${key} 必须是${min}至${max}的整数`);
    return value;
  };
  const boolean = (key: string): boolean => {
    if (typeof body[key] !== "boolean") throw new NanfuInputError(`${key} 必须是布尔值`);
    return body[key];
  };
  const choice = <T extends string>(key: string, values: readonly T[], optional = false): T | undefined => {
    const value = text(key, 32, optional);
    if (!value && optional) return undefined;
    if (!values.includes(value as T)) throw new NanfuInputError(`${key} 选项无效`);
    return value as T;
  };
  switch (action) {
    case "create-organization": return { orgId: await client.createOrg(text("name", 120), signal) };
    case "create-role": {
      const permissions = body.permissions;
      const allowed = ["env.create", "env.delete", "env.transfer", "member.view", "member.manage", "member.quota", "group.manage"];
      if (!Array.isArray(permissions) || permissions.length > allowed.length || permissions.some(p => typeof p !== "string" || !allowed.includes(p))) throw new NanfuInputError("权限列表无效");
      return { roleId: await client.createRole(text("name", 60), [...new Set(permissions)] as string[], signal) };
    }
    case "set-member":
      await client.setMember({ userId: uuid("userId")!, identity: choice("identity", ["admin", "manager", "member"], true),
        roleId: uuid("roleId", true), managerUserId: uuid("managerUserId", true), status: choice("status", ["active", "disabled"], true),
        locked: body.locked === undefined ? undefined : boolean("locked") }, signal);
      return {};
    case "set-quota": await client.setQuota(uuid("userId")!, integer("quota"), signal); return {};
    case "create-group": return { groupId: await client.createGroup(text("name", 60), signal) };
    case "grant-group": await client.grantGroup(uuid("groupId")!, uuid("userId")!, boolean("granted"), signal); return {};
    case "create-invite": return { code: await client.createInvite({ identity: choice("identity", ["admin", "manager", "member"])!,
      roleId: uuid("roleId", true), managerUserId: uuid("managerUserId", true), quota: integer("quota"), hours: integer("hours", 1, 8760) }, signal), uses: 1 };
    case "redeem-invite": return { orgId: await client.redeemInvite(text("code", 128), signal) };
    case "remove-member": return { reclaimed: await client.removeMember(uuid("userId")!, boolean("reclaim"), signal) };
    case "request-transfer": return { transferId: await client.requestTransfer(text("environmentId", 128), uuid("toUserId")!, signal) };
    case "respond-transfer": return { status: await client.respondTransfer(uuid("id")!, boolean("accept"), signal) };
    case "force-transfer": return { moved: await client.forceTransfer(text("environmentId", 128), uuid("toUserId")!, text("note", 500, true), signal) };
  }
}

export function nanfuOrganizationError(error: NanfuSyncError): { status: number; body: { ok: false; error: string; code?: string; retryable?: boolean } } {
  const messages: Record<string, string> = {
    NANFU_ORG_QUOTA: "组织窗口总配额不足，操作被拒绝。",
    NANFU_ENV_QUOTA: "目标成员窗口配额不足，操作被拒绝。",
    NANFU_MEMBER_INACTIVE: "成员已锁定或停用，不能写入或接收环境。",
    NANFU_GROUP_INVALID: "分组或成员不属于当前组织。",
    NANFU_FORBIDDEN: "当前账号无权执行此操作（42501）。",
    ORG_ALREADY_MEMBER: "当前账号已属于组织，不能重复创建或加入组织（42501）。",
    "42501": "操作被拒绝（42501）：权限不足、账号已属于组织，或目标受保护，请刷新确认。",
    "23505": "记录已存在或发生冲突（23505），请刷新确认；角色或分组名称也可能已存在。",
    INVITE_EXPIRED: "邀请码已过期，请向管理员申请新码。",
    INVITE_USED: "邀请码已使用，每个邀请码只能兑换一次。",
    "P0002": "目标记录或邀请码不存在。",
  };
  const message = error.code && messages[error.code];
  if (message) return { status: error.code === "42501" || error.code === "NANFU_FORBIDDEN" || error.code === "ORG_ALREADY_MEMBER" ? 403 : 409, body: { ok: false, error: message, code: error.code } };
  if (error.status === 401 || error.code === "28000") return { status: 401, body: { ok: false, error: "请重新登录南孚账号。" } };
  if (error.status === 403) return { status: 403, body: { ok: false, error: "当前账号没有操作权限。" } };
  if (error.status >= 400 && error.status < 500) return { status: 400, body: { ok: false, error: "服务端拒绝操作，请检查参数、目标状态或联系管理员。" } };
  return { status: 503, body: { ok: false, error: "南孚服务暂时不可用，操作结果未确认；请恢复网络后先刷新列表，再决定是否重试。", retryable: true } };
}
