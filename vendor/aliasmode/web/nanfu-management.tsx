import { useRef, useState, type FormEvent } from "react";
import { fetchNanfuMemberEnvironments, nanfuLoginName, type NanfuMember, type NanfuOrgOverview, type NanfuOrganization, type NanfuMutations, type NanfuVisibleEnvironment } from "./api.ts";

export type NanfuMutationHandler = <K extends keyof NanfuMutations>(action: K, input: NanfuMutations[K]["input"]) => Promise<void>;

const permissions = [
  ["env.create", "创建环境"], ["env.delete", "删除环境"], ["env.transfer", "转移环境"],
  ["member.view", "查看成员"], ["member.manage", "管理成员"], ["member.quota", "调整成员配额"], ["group.manage", "管理分组"],
] as const;
const identityNames: Record<string, string> = { owner: "所有者", admin: "管理员", manager: "成员", member: "成员" };
export const nanfuIdentityName = (identity: string) => identityNames[identity] ?? identity;

/**
 * The four tiers the owner asked for. 子账号 is not a separate database
 * identity: it is a member that belongs to another member (`manager_user_id`),
 * so it inherits the existing subtree rules instead of a parallel permission
 * system.
 */
export type NanfuAccountGroup = "owner" | "admin" | "member" | "sub";
export function nanfuAccountGroup(member: Pick<NanfuMember, "identity" | "managerUserId">): NanfuAccountGroup {
  if (member.identity === "owner") return "owner";
  if (member.identity === "admin") return "admin";
  return member.managerUserId ? "sub" : "member";
}
const groupNames: Record<NanfuAccountGroup, string> = { owner: "所有者", admin: "管理员", member: "成员", sub: "子账号" };
const groupOrder: NanfuAccountGroup[] = ["owner", "admin", "member", "sub"];

const dataOf = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); return new FormData(event.currentTarget); };
const text = (data: FormData, key: string) => String(data.get(key) ?? "").trim();
const passwordProblem = (value: string) => value.length >= 6 && value.length <= 12
  && !/[^\x21-\x7e]/.test(value) && /[A-Za-z]/.test(value) && /[0-9]/.test(value)
  ? "" : "密码需为 6 至 12 位非空白 ASCII 可打印字符，必须包含英文字母和数字，符号可选。";
const memberLabel = (member: NanfuMember) => member.displayName || nanfuLoginName(member.email) || member.userId;
const memberGroupNames = (overview: NanfuOrgOverview, userId: string) => overview.grants
  .filter(grant => grant.userId === userId)
  .map(grant => overview.groups.find(group => group.id === grant.groupId)?.name || grant.groupId);
const memberGroupIds = (overview: NanfuOrgOverview, userId: string) => overview.grants
  .filter(grant => grant.userId === userId).map(grant => grant.groupId);

/**
 * Group checkboxes plus a master "全部分组" box. Uncontrolled on purpose: the
 * form reads its values with FormData, and the master box just flips the others.
 */
function GroupPicker({ groups, granted, legend, disabled }: {
  groups: NanfuOrgOverview["groups"]; granted: string[]; legend: string; disabled: boolean;
}) {
  const boxes = useRef<HTMLFieldSetElement>(null);
  return <fieldset ref={boxes} className="nanfu-controls nanfu-groups" disabled={disabled}>
    <legend>{legend}</legend>
    <div className="nanfu-permissions">
      <label className="nanfu-check"><input type="checkbox" defaultChecked={granted.length === groups.length} onChange={event => {
        const list = boxes.current?.querySelectorAll<HTMLInputElement>('input[name="groupIds"]');
        if (list) for (const box of Array.from(list)) box.checked = event.target.checked;
      }} />全部分组</label>
      {groups.map(group => <label key={group.id} className="nanfu-check">
        <input type="checkbox" name="groupIds" value={group.id} defaultChecked={granted.includes(group.id)} />{group.name}
      </label>)}
    </div>
  </fieldset>;
}

/** Reads one employee's windows on demand, so opening the roster stays cheap. */
function MemberWindows({ member, groups }: { member: NanfuMember; groups: NanfuOrgOverview["groups"] }) {
  const [state, setState] = useState<{ loading?: boolean; error?: string; items?: NanfuVisibleEnvironment[] }>({});
  const load = () => {
    if (state.loading || state.items) return;
    setState({ loading: true });
    void fetchNanfuMemberEnvironments(member.userId).then(
      result => setState({ items: result.environments }),
      (error: unknown) => setState({ error: error instanceof Error ? error.message : "窗口列表读取失败，请重试" }),
    );
  };
  const groupName = (id: string | null) => (id ? groups.find(group => group.id === id)?.name || "已删除的分组" : "未分组");
  const updated = (value: string) => {
    const date = new Date(value);
    return value && !Number.isNaN(date.getTime()) ? ` · 更新于 ${date.toLocaleString("zh-CN", { hour12: false })}` : "";
  };
  return <details className="nanfu-row-actions nanfu-windows" onToggle={event => { if (event.currentTarget.open) load(); }}>
    <summary>查看窗口（{member.used}）</summary>
    {state.loading && <p>正在读取窗口…</p>}
    {state.error && <p className="modal-err" role="alert">{state.error}</p>}
    {state.items && !state.items.length && <p>这个账号还没有窗口。</p>}
    {!!state.items?.length && <ul className="nanfu-invites">{state.items.map(env => <li key={env.id}>
      {env.id}<br /><small>{groupName(env.groupId)}{updated(env.updatedAt)}</small>
    </li>)}</ul>}
  </details>;
}

function AddAccount({ members, overview, owner, admin, currentUserId, busy, onMutate }: {
  members: NanfuMember[]; overview: NanfuOrgOverview; owner: boolean; admin: boolean;
  currentUserId: string; busy: boolean; onMutate: NanfuMutationHandler;
}) {
  const scoped = !admin;
  const [kind, setKind] = useState<"member" | "sub" | "admin">(scoped ? "sub" : "member");
  const [inputError, setInputError] = useState("");
  const self = members.find(member => member.userId === currentUserId);
  const [parent, setParent] = useState(self && self.identity !== "owner" ? currentUserId : "");
  const parents = members.filter(member => member.identity !== "owner" && member.status === "active" && !member.locked
    && (!scoped || member.userId === currentUserId));
  return <form className="nanfu-form nanfu-add-account" aria-label="添加账号" onSubmit={event => {
    const data = dataOf(event);
    const email = text(data, "email").toLowerCase();
    const password = String(data.get("password") ?? "");
    const validLogin = email.includes("@") ? /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)
      : Array.from(email).length >= 2 && Array.from(email).length <= 63 && !/[\s@\u0000-\u001f\u007f-\u009f]/u.test(email);
    const problem = !validLogin ? "登录名需为 2 至 63 个字符，支持中文，不能包含空白、@ 或控制字符；邮箱须填写完整。" : passwordProblem(password);
    setInputError(problem);
    if (problem || busy) return;
    void onMutate("create-account", {
      email,
      password,
      identity: kind === "admin" ? "admin" : "member",
      quota: Math.max(0, Math.trunc(Number(text(data, "quota") || "0")) || 0),
      managerUserId: kind === "sub" ? parent || undefined : undefined,
      roleId: text(data, "roleId") || undefined,
      groupIds: data.getAll("groupIds").map(String).filter(Boolean),
      name: text(data, "name") || undefined,
    });
  }}>
    <label className="fld"><span>登录名</span><input name="email" type="text" autoComplete="off" maxLength={320} required placeholder="支持中文姓名，如 张三、zhangsan、zs01" /></label>
    <label className="fld"><span>姓名</span><input name="name" type="text" maxLength={60} autoComplete="off" placeholder="选填，例如 张三" disabled={busy} /></label>
    <label className="fld"><span>密码</span><input name="password" type="password" autoComplete="new-password" minLength={6} maxLength={12} required placeholder="6–12 位英文和数字，符号可选，不含空格" /></label>
    <label className="fld"><span>账号类型</span><select value={kind} onChange={event => setKind(event.target.value as "member" | "sub" | "admin")} disabled={busy}>
      {!scoped && <option value="member">成员</option>}
      <option value="sub">子账号（挂在某个账号名下）</option>
      {owner && <option value="admin">管理员</option>}
    </select></label>
    {kind === "sub" && <label className="fld"><span>所属账号</span><select value={parent} onChange={event => setParent(event.target.value)} required disabled={busy || scoped}>
      <option value="">请选择所属账号</option>
      {parents.map(member => <option key={member.userId} value={member.userId}>
        {memberLabel(member)} · {nanfuIdentityName(member.identity)}{member.userId === currentUserId ? "（我）" : ""}
      </option>)}
    </select></label>}
    <label className="fld"><span>角色</span><select name="roleId" disabled={busy}>
      <option value="">默认权限</option>
      {overview.roles.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}
    </select></label>
    <label className="fld"><span>窗口配额（0 不限）</span><input name="quota" type="number" min="0" step="1" defaultValue={0} disabled={busy} /></label>
    {!!overview.groups.length && <GroupPicker key={overview.groups.length} groups={overview.groups} granted={[]} legend="授权分组" disabled={busy} />}
    <button className="btn primary" type="submit" disabled={busy || (kind === "sub" && !parent)}>添加账号</button>
    {inputError && <p className="modal-err" role="alert">{inputError}</p>}
    <p className="nanfu-hint">登录名支持中文姓名（2 至 63 个字符，不能包含空白、@ 或控制字符），不需要邮箱；添加后对方用这个登录名和密码登录，账号已激活。授权分组决定对方在云端能看到哪些窗口，不勾选只能看到自己的窗口。{scoped && "你只能把子账号挂在自己名下。"}</p>
  </form>;
}

function MemberRow({ member, overview, owner, currentUserId, busy, onMutate }: {
  member: NanfuMember; overview: NanfuOrgOverview; owner: boolean; admin: boolean;
  currentUserId: string; busy: boolean; onMutate: NanfuMutationHandler;
}) {
  const self = member.userId === currentUserId;
  const [resetError, setResetError] = useState("");
  const parent = overview.members.find(item => item.userId === member.managerUserId);
  const group = nanfuAccountGroup(member);
  const quotaFull = member.quota > 0 && member.used >= member.quota;
  const granted = memberGroupNames(overview, member.userId);
  const grantedIds = memberGroupIds(overview, member.userId);
  const editable = group !== "owner" && !self;
  return <tr>
    <td>
      {memberLabel(member)}{self && <span className="nanfu-tag">我</span>}
      {member.displayName && <><br /><small>{nanfuLoginName(member.email)}</small></>}
      {group === "sub" && <><br /><small>所属：{parent ? memberLabel(parent) : member.managerUserId}</small></>}
    </td>
    <td>{member.roleName ?? <small>{group === "owner" ? "全部权限" : "默认权限"}</small>}</td>
    <td>{granted.length ? granted.join("、") : <small>{group === "owner" || group === "admin" ? "全部窗口" : "未授权"}</small>}</td>
    <td className={quotaFull ? "modal-err" : ""}>{member.used} / {member.quota === 0 ? "不限" : member.quota}{quotaFull && <small> · 已满</small>}
      <MemberWindows member={member} groups={overview.groups} />
    </td>
    <td>{member.status === "active" ? "启用" : "停用"}{member.locked ? " · 已锁定" : ""}</td>
    <td>{!editable ? <small>{group === "owner" ? "受保护，不可移除" : "本人"}</small> : <details className="nanfu-row-actions">
      <summary>设置</summary>
      <h5>身份与角色</h5>
      <form className="nanfu-form nanfu-row-form" aria-label={`设置 ${memberLabel(member)}`} onSubmit={event => {
        const data = dataOf(event);
        void onMutate("set-member", {
          userId: member.userId,
          identity: text(data, "identity") as "admin" | "member",
          roleId: text(data, "roleId") || undefined,
          status: text(data, "status") as "active" | "disabled",
          locked: data.has("locked"),
          managerUserId: text(data, "managerUserId") || undefined,
          name: text(data, "name"),
          reclaim: data.has("reclaim"),
        });
      }}>
        <label className="fld"><span>姓名</span><input name="name" type="text" maxLength={60} autoComplete="off" defaultValue={member.displayName ?? ""} placeholder="留空则不显示姓名" disabled={busy} /></label>
        <label className="fld"><span>身份</span><select name="identity" defaultValue={member.identity === "admin" ? "admin" : "member"} disabled={busy}>
          {owner && <option value="admin">管理员</option>}
          <option value="member">成员 / 子账号</option>
        </select></label>
        <label className="fld"><span>角色</span><select name="roleId" defaultValue={member.roleId ?? ""} disabled={busy}>
          <option value="">保持不变</option>
          <option value="00000000-0000-0000-0000-000000000000">无角色（清除）</option>
          {overview.roles.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}
        </select></label>
        <label className="fld"><span>所属账号</span><select name="managerUserId" defaultValue={member.managerUserId ?? ""} disabled={busy}>
          <option value="">保持不变</option>
          <option value="00000000-0000-0000-0000-000000000000">无（改为普通成员）</option>
          {overview.members.filter(item => item.identity !== "owner" && item.userId !== member.userId)
            .map(item => <option key={item.userId} value={item.userId}>{memberLabel(item)} · {nanfuIdentityName(item.identity)}</option>)}
        </select></label>
        <label className="fld"><span>状态</span><select name="status" defaultValue={member.status} disabled={busy}>
          <option value="active">启用</option><option value="disabled">停用</option>
        </select></label>
        <label className="nanfu-check"><input type="checkbox" name="locked" defaultChecked={member.locked} disabled={busy} />锁定登录</label>
        <label className="nanfu-check"><input type="checkbox" name="reclaim" disabled={busy} />停用前把窗口回收给所有者</label>
        <button className="btn" type="submit" disabled={busy}>保存</button>
      </form>
      <h5>授权分组</h5>
      <form className="nanfu-form nanfu-row-form" aria-label={`授权分组 ${memberLabel(member)}`} onSubmit={event => {
        const data = dataOf(event);
        void onMutate("set-groups", { userId: member.userId, groupIds: data.getAll("groupIds").map(String).filter(Boolean) });
      }}>
        {!overview.groups.length ? <p>还没有分组。在下方「高级：角色、分组与邀请码」里创建，再把窗口放进分组。</p>
          : <GroupPicker key={`${overview.groups.length}:${grantedIds.join(",")}`} groups={overview.groups} granted={grantedIds} legend="可查看的分组" disabled={busy} />}
        <button className="btn" type="submit" disabled={busy || !overview.groups.length}>保存分组</button>
      </form>
      <h5>重置登录密码</h5>
      <form className="nanfu-form nanfu-row-form" aria-label={`重置密码 ${memberLabel(member)}`} onSubmit={event => {
        const data = dataOf(event);
        const password = String(data.get("password") ?? "");
        const problem = passwordProblem(password);
        setResetError(problem);
        if (problem || busy) return;
        event.currentTarget.reset();
        void onMutate("reset-password", { userId: member.userId, password });
      }}>
        <label className="fld"><span>新密码</span><input name="password" type="password" autoComplete="new-password" minLength={6} maxLength={12} required placeholder="6–12 位英文和数字，符号可选，不含空格" disabled={busy} /></label>
        <button className="btn" type="submit" disabled={busy}>重置密码</button>
        {resetError && <p className="modal-err" role="alert">{resetError}</p>}
      </form>
      <h5>窗口配额</h5>
      <form className="nanfu-form nanfu-row-form" aria-label={`配额 ${memberLabel(member)}`} onSubmit={event => {
        const data = dataOf(event);
        void onMutate("set-quota", { userId: member.userId, quota: Number(text(data, "quota")) });
      }}>
        <label className="fld"><span>窗口配额（0 不限）</span><input name="quota" type="number" min="0" max="2147483647" step="1" required defaultValue={member.quota} disabled={busy} /></label>
        <button className="btn" type="submit" disabled={busy}>保存配额</button>
      </form>
      <h5>移除</h5>
      <form className="nanfu-form nanfu-row-form" aria-label={`移除 ${memberLabel(member)}`} onSubmit={event => {
        event.preventDefault();
        if (window.confirm(`移除 ${memberLabel(member)}？其组织内窗口会先回收给所有者。本机数据不删除。`)) {
          void onMutate("remove-member", { userId: member.userId, reclaim: true });
        }
      }}>
        <p className="nanfu-hint">移除前会先把这个账号名下的窗口回收给组织所有者，不会删除任何本机数据。</p>
        <button className="btn danger" type="submit" disabled={busy}>移除账号</button>
      </form>
    </details>}</td>
  </tr>;
}

function MemberGroup({ group, members, ...rest }: {
  group: NanfuAccountGroup; members: NanfuMember[]; overview: NanfuOrgOverview; owner: boolean; admin: boolean;
  currentUserId: string; busy: boolean; onMutate: NanfuMutationHandler;
}) {
  return <section className="nanfu-group" aria-label={groupNames[group]}>
    <h4>{groupNames[group]}<span className="nanfu-count">{members.length}</span></h4>
    {!members.length ? <p>暂无{groupNames[group]}。</p> : <div className="nanfu-table-wrap"><table className="nanfu-table">
      <thead><tr><th>账号</th><th>角色</th><th>授权分组</th><th>窗口</th><th>状态</th><th>操作</th></tr></thead>
      <tbody>{members.map(member => <MemberRow key={member.userId} member={member} {...rest} />)}</tbody>
    </table></div>}
  </section>;
}

export function NanfuManagement({ organization, overview, currentUserId, busy, onMutate, onRefresh }: {
  organization: NanfuOrganization; overview: NanfuOrgOverview; currentUserId: string; busy: boolean;
  onMutate: NanfuMutationHandler; onRefresh?: () => void;
}) {
  const [copyStatus, setCopyStatus] = useState("");
  // Members with member.manage open the same page, scoped to their own subtree.
  const staff = ["owner", "admin"].includes(organization.identity) || organization.permissions.includes("member.manage");
  if (!staff || organization.locked || organization.status !== "active") return null;
  const owner = organization.identity === "owner";
  const admin = owner || organization.identity === "admin";
  const used = overview.members.reduce((sum, member) => sum + member.used, 0);
  const allocated = overview.members.filter(member => member.identity !== "owner").reduce((sum, member) => sum + member.quota, 0);
  const inviteQuotaMax = organization.planQuota > 0 ? Math.max(0, organization.planQuota - allocated) : 2147483647;
  const orgQuotaFull = organization.planQuota > 0 && used >= organization.planQuota;
  const overAllocated = organization.planQuota > 0 && allocated > organization.planQuota;
  const groups: Record<NanfuAccountGroup, NanfuMember[]> = { owner: [], admin: [], member: [], sub: [] };
  for (const member of overview.members) groups[nanfuAccountGroup(member)].push(member);
  for (const key of groupOrder) groups[key].sort((a, b) => memberLabel(a).localeCompare(memberLabel(b)));
  const copy = async (code: string) => {
    try { await navigator.clipboard.writeText(code); setCopyStatus("邀请码已复制"); }
    catch { setCopyStatus("无法访问剪贴板，请选中邀请码手动复制"); }
  };
  const memberProps = { overview, owner, admin, currentUserId, busy, onMutate };
  return <>
    <section className="settings-card" aria-label="添加账号">
      <header><h3>添加账号</h3>{onRefresh && <button type="button" className="btn" disabled={busy} onClick={onRefresh}>刷新成员</button>}</header>
      <div className="card-body">
        <p>直接填登录名和密码就能建号：不需要对方先注册，也不需要邀请码。登录名用用户名或完整邮箱都可以。</p>
        <AddAccount key={overview.members.length} members={overview.members} overview={overview} owner={owner} admin={admin} currentUserId={currentUserId} busy={busy} onMutate={onMutate} />
      </div>
    </section>

    <section className="settings-card" aria-label="成员与层级">
      <header><h3>成员与层级</h3></header>
      <div className="card-body">
        <p className="nanfu-staff-counts">
          <span>所有者 {groups.owner.length}</span><span>管理员 {groups.admin.length}</span>
          <span>成员 {groups.member.length}</span><span>子账号 {groups.sub.length}</span>
          <span>组织窗口 {used} / {organization.planQuota === 0 ? "不限" : organization.planQuota}</span>
        </p>
        {overAllocated && <p className="modal-err" role="alert">成员配额合计 {allocated} 已超过组织窗口 {organization.planQuota}：服务端按实际用量拦截，新建环境会失败。请下调成员配额。</p>}
        {!overAllocated && orgQuotaFull && <p className="modal-err" role="alert">组织窗口已用满（{used} / {organization.planQuota}），新建或接收环境会被服务端拒绝；本机窗口不计入组织额度。</p>}
        {groupOrder.map(group => <MemberGroup key={group} group={group} members={groups[group]} {...memberProps} />)}
      </div>
    </section>

    <details className="settings-card nanfu-advanced">
      <summary>高级：角色、分组与邀请码</summary>
      <div className="card-body">
        <p>角色给账号附加细项权限；分组决定成员在组织云端能看到哪些窗口；邀请码给需要自行注册的人。</p>
        <fieldset disabled={busy} className="nanfu-controls">
          <h4>角色权限</h4>
          <ul>{overview.roles.map(role => <li key={role.id}>{role.name}：{role.permissions.map(value => permissions.find(item => item[0] === value)?.[1] ?? value).join("、") || "无附加权限"}</li>)}</ul>
          <form className="nanfu-form" aria-label="创建角色" onSubmit={event => {
            const data = dataOf(event);
            void onMutate("create-role", { name: text(data, "name"), permissions: data.getAll("permissions").map(String) });
          }}>
            <label className="fld"><span>新角色名称</span><input name="name" maxLength={60} required /></label>
            <div className="nanfu-permissions">{permissions.map(([value, label]) => <label key={value}><input type="checkbox" name="permissions" value={value} />{label}</label>)}</div>
            <button className="btn" type="submit">创建角色</button>
          </form>

          <h4>分组与授权</h4>
          <form className="nanfu-form" aria-label="创建组织分组" onSubmit={event => { const data = dataOf(event); void onMutate("create-group", { name: text(data, "name") }); }}>
            <label className="fld"><span>新分组名称</span><input name="name" maxLength={60} required /></label><button className="btn" type="submit">创建分组</button>
          </form>
          <form className="nanfu-form" aria-label="分组授权" onSubmit={event => {
            const data = dataOf(event);
            void onMutate("grant-group", { groupId: text(data, "groupId"), userId: text(data, "userId"), granted: text(data, "granted") === "true" });
          }}>
            <label className="fld"><span>分组</span><select name="groupId" required><option value="">选择分组</option>{overview.groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
            <label className="fld"><span>授权成员</span><select name="userId" required><option value="">选择成员</option>{overview.members.map(member => <option key={member.userId} value={member.userId}>{memberLabel(member)}</option>)}</select></label>
            <label className="fld"><span>授权操作</span><select name="granted"><option value="true">授权可见</option><option value="false">撤销授权</option></select></label>
            <button className="btn" type="submit">保存分组授权</button>
          </form>
          {!overview.grants.length ? <p>暂无显式分组授权。</p> : <ul>{overview.grants.map(grant => {
            const member = overview.members.find(item => item.userId === grant.userId);
            return <li key={`${grant.groupId}:${grant.userId}`}>
              {overview.groups.find(group => group.id === grant.groupId)?.name || grant.groupId} → {member ? memberLabel(member) : grant.userId}
            </li>;
          })}</ul>}

          <h4>邀请码（给自行注册的人）</h4>
          <p>邀请码单次使用；对方先注册并确认邮箱，再在登录页填邀请码即可加入本组织。</p>
          <form className="nanfu-form" aria-label="生成邀请码" onSubmit={event => {
            const data = dataOf(event);
            void onMutate("create-invite", {
              identity: text(data, "identity") as "admin" | "manager" | "member",
              roleId: text(data, "roleId") || undefined,
              managerUserId: text(data, "managerUserId") || undefined,
              quota: Number(text(data, "quota")),
              hours: Number(text(data, "hours")),
            });
          }}>
            <label className="fld"><span>邀请身份</span><select name="identity" defaultValue="member"><option value="member">成员</option>{owner && <option value="admin">管理员</option>}</select></label>
            <label className="fld"><span>邀请角色</span><select name="roleId"><option value="">不分配角色</option>{overview.roles.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label>
            <label className="fld"><span>邀请上级</span><select name="managerUserId"><option value="">无上级</option>{overview.members.filter(member => member.identity !== "owner").map(member => <option key={member.userId} value={member.userId}>{memberLabel(member)}</option>)}</select></label>
            <label className="fld"><span>初始窗口配额（0 不限）</span><input name="quota" type="number" min="0" max={inviteQuotaMax} step="1" defaultValue={0} required /></label>
            <label className="fld"><span>有效小时数</span><input name="hours" type="number" min="1" max="8760" step="1" defaultValue={168} required /></label>
            <button className="btn" type="submit">生成邀请码</button>
          </form>
          {copyStatus && <p role="status">{copyStatus}</p>}
          {!overview.invites.length ? <p>暂无邀请码。</p> : <ul className="nanfu-invites">{overview.invites.map(invite => <li key={invite.code}>
            <code>{invite.code}</code> · {nanfuIdentityName(invite.identity)} · {invite.redeemedBy ? "已兑换" : Date.parse(invite.expiresAt) <= Date.now() ? "已过期" : "未兑换"} · 到期：{invite.expiresAt}
            <button type="button" className="btn" onClick={() => void copy(invite.code)}>复制邀请码</button>
          </li>)}</ul>}
        </fieldset>
      </div>
    </details>
  </>;
}
