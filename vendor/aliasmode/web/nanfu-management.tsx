import { useState, type FormEvent } from "react";
import type { NanfuMember, NanfuOrgOverview, NanfuOrganization, NanfuMutations } from "./api.ts";

export type NanfuMutationHandler = <K extends keyof NanfuMutations>(action: K, input: NanfuMutations[K]["input"]) => Promise<void>;

const permissions = [
  ["env.create", "创建环境"], ["env.delete", "删除环境"], ["env.transfer", "转移环境"],
  ["member.view", "查看成员"], ["member.manage", "管理成员"], ["member.quota", "调整成员配额"], ["group.manage", "管理分组"],
] as const;
const identityNames: Record<string, string> = { owner: "所有者（组织管理员）", admin: "管理员", manager: "经理", member: "成员" };
export const nanfuIdentityName = (identity: string) => identityNames[identity] ?? identity;
const dataOf = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); return new FormData(event.currentTarget); };
const text = (data: FormData, key: string) => String(data.get(key) ?? "").trim();

function MemberSettings({ member, overview, owner, onMutate }: {
  member: NanfuMember; overview: NanfuOrgOverview; owner: boolean; onMutate: NanfuMutationHandler;
}) {
  if (member.identity === "owner") return <span>所有者受保护，配额由组织套餐控制。</span>;
  return <>
    <form className="nanfu-form" aria-label={`修改成员 ${member.email || member.userId}`} onSubmit={event => {
      const data = dataOf(event);
      void onMutate("set-member", {
        userId: member.userId, identity: text(data, "identity") as "admin" | "manager" | "member",
        roleId: text(data, "roleId") || undefined, managerUserId: text(data, "managerUserId") || undefined,
        status: text(data, "status") as "active" | "disabled", locked: data.has("locked"),
      });
    }}>
      <label className="fld"><span>身份</span><select name="identity" defaultValue={member.identity}>
        {(owner || member.identity === "admin") && <option value="admin">管理员</option>}
        <option value="manager">经理</option><option value="member">成员</option>
      </select></label>
      <label className="fld"><span>角色</span><select name="roleId" defaultValue={member.roleId ?? ""}>
        <option value="">保持当前角色</option>{overview.roles.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}
      </select></label>
      <label className="fld"><span>上级经理</span><select name="managerUserId" defaultValue={member.managerUserId ?? ""}>
        <option value="">保持当前上级</option>{overview.members.filter(item => item.userId !== member.userId).map(item => <option key={item.userId} value={item.userId}>{item.email || item.userId} · {nanfuIdentityName(item.identity)}</option>)}
      </select></label>
      <label className="fld"><span>账号状态</span><select name="status" defaultValue={member.status}><option value="active">启用</option><option value="disabled">停用</option></select></label>
      <label><input name="locked" type="checkbox" defaultChecked={member.locked} />锁定</label>
      <button className="btn" type="submit">保存成员</button>
    </form>
    <form className="nanfu-form" aria-label={`成员配额 ${member.email || member.userId}`} onSubmit={event => {
      const data = dataOf(event); void onMutate("set-quota", { userId: member.userId, quota: Number(text(data, "quota")) });
    }}>
      <label className="fld"><span>窗口配额（0 不限）</span><input name="quota" type="number" min="0" max="2147483647" step="1" required defaultValue={member.quota} /></label>
      <button className="btn" type="submit">保存配额</button>
    </form>
    <form className="nanfu-form" aria-label={`移除成员 ${member.email || member.userId}`} onSubmit={event => {
      const data = dataOf(event); const reclaim = data.has("reclaim");
      const consequence = reclaim ? "其组织环境将回收给所有者，并记录转移审计。" : "其环境将退出组织，仍归原账号；组织将不再拥有这些环境。";
      if (window.confirm(`移除 ${member.email || member.userId}？成员将失去组织权限。${consequence}本机数据不删除。`)) void onMutate("remove-member", { userId: member.userId, reclaim });
    }}>
      <label><input type="checkbox" name="reclaim" defaultChecked />回收环境给所有者</label><button className="btn danger" type="submit">移除成员</button>
    </form>
  </>;
}

export function NanfuManagement({ organization, overview, busy, onMutate }: {
  organization: NanfuOrganization; overview: NanfuOrgOverview; busy: boolean; onMutate: NanfuMutationHandler;
}) {
  const [copyStatus, setCopyStatus] = useState("");
  if (!["owner", "admin"].includes(organization.identity) || organization.locked || organization.status !== "active") return null;
  const owner = organization.identity === "owner";
  const used = overview.members.reduce((sum, member) => sum + member.used, 0);
  const copy = async (code: string) => {
    try { await navigator.clipboard.writeText(code); setCopyStatus("邀请码已复制"); }
    catch { setCopyStatus("无法访问剪贴板，请选中邀请码手动复制"); }
  };
  return <section className="settings-card" aria-label="组织管理"><header><h3>组织管理</h3></header><div className="card-body">
    <p>组织窗口：{used} / {organization.planQuota === 0 ? "不限" : organization.planQuota}。总配额由套餐控制，当前接口仅支持调整成员配额。</p>
    <p>锁定与停用均限制组织访问，分别记录；已有角色与上级可更换，当前接口不支持清空。所有更改仍由服务端核验权限。</p>
    <fieldset disabled={busy} className="nanfu-controls"><legend>成员与权限</legend>
      {!overview.members.length && <p>暂无可见成员。</p>}
      <div className="nanfu-table-wrap"><table className="nanfu-table"><thead><tr><th>账号 / 身份</th><th>角色 / 上级</th><th>状态 / 配额</th><th>管理操作</th></tr></thead><tbody>
        {overview.members.map(member => <tr key={member.userId}>
          <td>{member.email || member.userId}<br />{nanfuIdentityName(member.identity)}<br /><small>{member.userId}</small></td>
          <td>{member.roleName ?? (member.identity === "owner" ? "所有者内置权限" : "未分配")}<br />上级：{overview.members.find(item => item.userId === member.managerUserId)?.email || member.managerUserId || "无"}</td>
          <td>{member.status === "active" ? "启用" : "停用"} · {member.locked ? "已锁定" : "未锁定"}<br />{member.used} / {member.quota === 0 ? "不限" : member.quota}</td>
          <td><MemberSettings member={member} overview={overview} owner={owner} onMutate={onMutate} /></td>
        </tr>)}
      </tbody></table></div>
      <h4>角色权限</h4>
      <ul>{overview.roles.map(role => <li key={role.id}>{role.name}：{role.permissions.map(value => permissions.find(item => item[0] === value)?.[1] ?? value).join("、") || "无附加权限"}</li>)}</ul>
      <form className="nanfu-form" aria-label="创建角色" onSubmit={event => {
        const data = dataOf(event); void onMutate("create-role", { name: text(data, "name"), permissions: data.getAll("permissions").map(String) });
      }}>
        <label className="fld"><span>新角色名称</span><input name="name" maxLength={60} required /></label>
        <div className="nanfu-permissions">{permissions.map(([value, label]) => <label key={value}><input type="checkbox" name="permissions" value={value} />{label}</label>)}</div>
        <button className="btn" type="submit">创建角色</button>
      </form>
      <h4>分组与授权</h4>
      <form className="nanfu-form" aria-label="创建组织分组" onSubmit={event => { const data = dataOf(event); void onMutate("create-group", { name: text(data, "name") }); }}>
        <label className="fld"><span>新分组名称</span><input name="name" maxLength={60} required /></label><button className="btn" type="submit">创建分组</button>
      </form>
      <form className="nanfu-form" aria-label="分组授权" onSubmit={event => { const data = dataOf(event); void onMutate("grant-group", { groupId: text(data, "groupId"), userId: text(data, "userId"), granted: text(data, "granted") === "true" }); }}>
        <label className="fld"><span>分组</span><select name="groupId" required><option value="">选择分组</option>{overview.groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
        <label className="fld"><span>授权成员</span><select name="userId" required><option value="">选择成员</option>{overview.members.map(member => <option key={member.userId} value={member.userId}>{member.email || member.userId}</option>)}</select></label>
        <label className="fld"><span>授权操作</span><select name="granted"><option value="true">授权可见</option><option value="false">撤销授权</option></select></label>
        <button className="btn" type="submit">保存分组授权</button>
      </form>
      {!overview.grants.length ? <p>暂无显式分组授权。</p> : <ul>{overview.grants.map(grant => <li key={`${grant.groupId}:${grant.userId}`}>{overview.groups.find(group => group.id === grant.groupId)?.name || grant.groupId} → {overview.members.find(member => member.userId === grant.userId)?.email || grant.userId}</li>)}</ul>}
      <h4>邀请子账号</h4><p>新成员先注册并确认邮箱，再登录兑换。邀请码单次使用，可设置过期时长；无多次使用选项。</p>
      <form className="nanfu-form" aria-label="生成邀请码" onSubmit={event => {
        const data = dataOf(event); void onMutate("create-invite", { identity: text(data, "identity") as "admin" | "manager" | "member", roleId: text(data, "roleId") || undefined,
          managerUserId: text(data, "managerUserId") || undefined, quota: Number(text(data, "quota")), hours: Number(text(data, "hours")) });
      }}>
        <label className="fld"><span>邀请身份</span><select name="identity" defaultValue="member"><option value="member">成员</option><option value="manager">经理</option>{owner && <option value="admin">管理员</option>}</select></label>
        <label className="fld"><span>邀请角色</span><select name="roleId"><option value="">不分配角色</option>{overview.roles.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label>
        <label className="fld"><span>邀请上级</span><select name="managerUserId"><option value="">无上级</option>{overview.members.map(member => <option key={member.userId} value={member.userId}>{member.email || member.userId}</option>)}</select></label>
        <label className="fld"><span>初始窗口配额（0 不限）</span><input name="quota" type="number" min="0" max="2147483647" step="1" defaultValue={0} required /></label>
        <label className="fld"><span>有效小时数</span><input name="hours" type="number" min="1" max="8760" step="1" defaultValue={168} required /></label>
        <button className="btn primary" type="submit">生成邀请码</button>
      </form>
      {copyStatus && <p role="status">{copyStatus}</p>}
      {!overview.invites.length ? <p>暂无邀请码。</p> : <ul className="nanfu-invites">{overview.invites.map(invite => <li key={invite.code}>
        <code>{invite.code}</code> · {nanfuIdentityName(invite.identity)} · {invite.redeemedBy ? "已兑换" : Date.parse(invite.expiresAt) <= Date.now() ? "已过期" : "未兑换"} · 到期：{invite.expiresAt} · 使用次数：{invite.redeemedBy ? "1/1" : "0/1"}
        <button type="button" className="btn" onClick={() => void copy(invite.code)}>复制邀请码</button>
      </li>)}</ul>}
    </fieldset>
  </div></section>;
}
