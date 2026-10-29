import { NanfuSyncClient, NanfuSyncError, type NanfuMember } from "./nanfu-sync.ts";

export const NANFU_ORGANIZATION_ACTIONS = [
  "create-organization", "create-role", "set-member", "set-quota", "create-group", "grant-group",
  "create-invite", "create-account", "set-groups", "reset-password", "redeem-invite", "remove-member",
  "request-transfer", "respond-transfer", "force-transfer",
] as const;
export type NanfuOrganizationAction = typeof NANFU_ORGANIZATION_ACTIONS[number];

export class NanfuInputError extends Error {}

/**
 * A refusal decided by the dashboard before the RPC runs. The database remains
 * the authority; these checks turn two gaps in the hosted RPCs into clear,
 * actionable messages: a manager changing their own identity/quota, and a
 * member quota that would exceed the organization's plan.
 */
export class NanfuPolicyError extends Error {
  constructor(message: string, readonly status: 403 | 409 = 409) {
    super(message);
    this.name = "NanfuPolicyError";
  }
}

export interface NanfuMutationContext {
  /** Signed-in account making the request. Supplied by the local UI route. */
  callerUserId?: string;
}

/** Identities whose assignment only the organization owner may change. */
export function assertNanfuMemberChange(input: {
  callerUserId?: string;
  callerIdentity?: string;
  requestedUserId: string;
  target?: Pick<NanfuMember, "userId" | "identity">;
  nextIdentity?: "admin" | "manager" | "member";
}): void {
  if (input.callerUserId && input.requestedUserId === input.callerUserId) {
    throw new NanfuPolicyError("不能修改自己的成员身份或权限；如需调整，请联系组织所有者。", 403);
  }
  if (input.target?.identity === "owner") {
    throw new NanfuPolicyError("所有者受保护，不能被降级、停用或移除。", 403);
  }
  if (input.callerIdentity && input.callerIdentity !== "owner") {
    if (input.target?.identity === "admin") {
      throw new NanfuPolicyError("管理员成员仅组织所有者可调整。", 403);
    }
    if (input.nextIdentity === "admin") {
      throw new NanfuPolicyError("只有组织所有者可以任命管理员，请联系组织所有者。", 403);
    }
  }
}

/**
 * Keep the sum of member quotas inside the organization plan. 0 on either side
 * means unlimited, so there is nothing to reserve; an unchanged quota is always
 * accepted so a pre-existing over-allocation can still be saved.
 */
export function assertNanfuQuotaAllocation(input: {
  planQuota: number;
  members: readonly Pick<NanfuMember, "userId" | "identity" | "quota">[];
  quota: number;
  targetUserId?: string;
}): void {
  if (input.quota === 0 || input.planQuota <= 0) return;
  const target = input.targetUserId ? input.members.find(member => member.userId === input.targetUserId) : undefined;
  if (target && target.quota === input.quota) return;
  const allocated = input.members
    .filter(member => member.identity !== "owner" && member.userId !== input.targetUserId)
    .reduce((sum, member) => sum + Math.max(0, member.quota), 0);
  const remaining = Math.max(0, input.planQuota - allocated);
  if (input.quota > remaining) {
    throw new NanfuPolicyError(
      `成员窗口配额 ${input.quota} 超过组织剩余可分配配额 ${remaining}（组织上限 ${input.planQuota}，其他成员已分配 ${allocated}）。请先调低其他成员配额。`,
      409,
    );
  }
}

export async function mutateNanfuOrganization(
  client: NanfuSyncClient,
  action: NanfuOrganizationAction,
  raw: unknown,
  signal?: AbortSignal,
  context: NanfuMutationContext = {},
): Promise<unknown> {
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
    case "set-member": {
      const userId = uuid("userId")!;
      const identity = choice("identity", ["admin", "manager", "member"], true);
      if (context.callerUserId) {
        const organization = await client.orgMe(signal);
        const overview = organization ? await client.orgOverview(organization.orgId, signal) : null;
        assertNanfuMemberChange({
          callerUserId: context.callerUserId,
          callerIdentity: organization?.identity,
          requestedUserId: userId,
          target: overview?.members.find(member => member.userId === userId),
          nextIdentity: identity,
        });
      }
      await client.setMember({ userId, identity, roleId: uuid("roleId", true), managerUserId: uuid("managerUserId", true),
        status: choice("status", ["active", "disabled"], true),
        locked: body.locked === undefined ? undefined : boolean("locked") }, signal);
      return {};
    }
    case "set-quota": {
      const userId = uuid("userId")!;
      const quota = integer("quota");
      if (context.callerUserId === userId) {
        throw new NanfuPolicyError("不能调整自己的窗口配额；如需调整，请联系组织所有者或管理员。", 403);
      }
      if (context.callerUserId) {
        const organization = await client.orgMe(signal);
        if (organization) {
          const overview = await client.orgOverview(organization.orgId, signal);
          const target = overview.members.find(member => member.userId === userId);
          if (target?.identity === "owner") {
            throw new NanfuPolicyError("所有者配额由组织套餐决定，不能单独设置。", 403);
          }
          assertNanfuQuotaAllocation({ planQuota: organization.planQuota, members: overview.members, quota, targetUserId: userId });
        }
      }
      await client.setQuota(userId, quota, signal);
      return {};
    }
    case "create-group": return { groupId: await client.createGroup(text("name", 60), signal) };
    case "grant-group": await client.grantGroup(uuid("groupId")!, uuid("userId")!, boolean("granted"), signal); return {};
    case "create-invite": {
      const identity = choice("identity", ["admin", "manager", "member"])!;
      const quota = integer("quota");
      if (context.callerUserId && (identity === "admin" || quota > 0)) {
        const organization = await client.orgMe(signal);
        if (organization) {
          if (identity === "admin" && organization.identity !== "owner") {
            throw new NanfuPolicyError("只有组织所有者可以邀请管理员，请联系组织所有者。", 403);
          }
          if (quota > 0) {
            const overview = await client.orgOverview(organization.orgId, signal);
            assertNanfuQuotaAllocation({ planQuota: organization.planQuota, members: overview.members, quota });
          }
        }
      }
      return { code: await client.createInvite({ identity, roleId: uuid("roleId", true), managerUserId: uuid("managerUserId", true),
        quota, hours: integer("hours", 1, 8760) }, signal), uses: 1 };
    }
    case "create-account": {
      // A bare name is a login (stored as <name>@nanfu.local); anything with
      // "@" must be a complete address.
      const login = text("email", 320).toLowerCase();
      if (login.includes("@")) {
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(login)) throw new NanfuInputError("邮箱格式不正确，请输入完整邮箱");
      } else if (!/^[a-z0-9][a-z0-9._-]{1,62}$/.test(login)) {
        throw new NanfuInputError("登录名只能使用 2 至 63 位字母、数字、点、下划线和横线");
      }
      const password = body.password;
      if (typeof password !== "string" || password.length < 6 || password.length > 72) throw new NanfuInputError("密码须为 6 至 72 个字符");
      const identity = choice("identity", ["admin", "member"])!;
      const quota = integer("quota");
      const roleId = uuid("roleId", true);
      const groupIds = body.groupIds === undefined || body.groupIds === null ? [] : body.groupIds;
      if (!Array.isArray(groupIds) || groupIds.length > 200
        || groupIds.some(value => typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))) {
        throw new NanfuInputError("groupIds 必须是分组编号列表");
      }
      if (context.callerUserId) {
        const organization = await client.orgMe(signal);
        if (organization) {
          if (identity === "admin" && organization.identity !== "owner") {
            throw new NanfuPolicyError("只有组织所有者可以添加管理员，请联系组织所有者。", 403);
          }
          if (quota > 0) {
            const overview = await client.orgOverview(organization.orgId, signal);
            assertNanfuQuotaAllocation({ planQuota: organization.planQuota, members: overview.members, quota });
          }
        }
      }
      return await client.createAccount({
        email: login, password, identity, quota,
        managerUserId: uuid("managerUserId", true),
        roleId,
        groupIds: groupIds as string[],
      }, signal);
    }
    case "set-groups": {
      const userId = uuid("userId")!;
      const groupIds = body.groupIds;
      if (!Array.isArray(groupIds) || groupIds.length > 200
        || groupIds.some(value => typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))) {
        throw new NanfuInputError("请选择有效的分组");
      }
      if (context.callerUserId === userId) {
        throw new NanfuPolicyError("不能修改自己的授权分组；请联系组织所有者或管理员。", 403);
      }
      await client.setMemberGroups(userId, groupIds as string[], signal);
      return {};
    }
    case "reset-password": {
      const userId = uuid("userId")!;
      const password = body.password;
      if (typeof password !== "string" || password.length < 6 || password.length > 72) throw new NanfuInputError("密码须为 6 至 72 个字符");
      await client.resetMemberPassword(userId, password, signal);
      return {};
    }
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
    NANFU_FORBIDDEN: "当前账号无权执行此操作，请联系组织所有者或管理员。",
    ORG_ALREADY_MEMBER: "当前账号已属于组织，不能重复创建或加入组织。",
    NANFU_EMAIL_TAKEN: "这个登录名或邮箱已经注册过南孚账号，请换一个，或让本人直接登录。",
    NANFU_EMAIL_INVALID: "登录名或邮箱格式不正确：登录名用 2 至 63 位字母、数字、点、下划线和横线，邮箱要带 @。",
    NANFU_PASSWORD_INVALID: "密码须为 6 至 72 个字符。",
    NANFU_PARENT_INVALID: "所选上级账号无效或不在本组织内。",
    NANFU_ROLE_INVALID: "所选角色不属于当前组织，请刷新后重试。",
    NANFU_INPUT: "填写的信息不完整或格式不正确，请检查后重试。",
    "42501": "操作被拒绝（42501）：权限不足、账号已属于组织，或目标受保护，请刷新确认。",
    "23505": "记录已存在或发生冲突（23505），请刷新确认；角色或分组名称也可能已存在。",
    INVITE_EXPIRED: "邀请码已过期，请向管理员申请新码。",
    INVITE_USED: "邀请码已使用，每个邀请码只能兑换一次。",
    TRANSFER_EXPIRED: "转移请求已过期，请重新发起。",
    "P0002": "目标记录或邀请码不存在。",
  };
  const statuses: Record<string, number> = {
    "42501": 403, NANFU_FORBIDDEN: 403, ORG_ALREADY_MEMBER: 403, NANFU_MEMBER_INACTIVE: 403,
    NANFU_EMAIL_INVALID: 400, NANFU_PASSWORD_INVALID: 400, NANFU_PARENT_INVALID: 400, NANFU_INPUT: 400,
    NANFU_EMAIL_TAKEN: 409, NANFU_ROLE_INVALID: 409, NANFU_ORG_QUOTA: 409, NANFU_ENV_QUOTA: 409, NANFU_GROUP_INVALID: 409,
    "23505": 409, INVITE_EXPIRED: 409, INVITE_USED: 409, TRANSFER_EXPIRED: 409, "P0002": 409,
  };
  const message = error.code && messages[error.code];
  if (message) return { status: statuses[error.code!] ?? 409, body: { ok: false, error: message, code: error.code } };
  if (error.status === 401 || error.code === "28000") return { status: 401, body: { ok: false, error: "请重新登录南孚账号。" } };
  if (error.status === 403) return { status: 403, body: { ok: false, error: "当前账号没有操作权限。" } };
  if (error.status >= 400 && error.status < 500) return { status: 400, body: { ok: false, error: "服务端拒绝操作，请检查参数、目标状态或联系管理员。" } };
  return { status: 503, body: { ok: false, error: "南孚服务暂时不可用，操作结果未确认；请恢复网络后先刷新列表，再决定是否重试。", retryable: true } };
}
