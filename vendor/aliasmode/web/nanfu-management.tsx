import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { fetchNanfuEnvironments, fetchNanfuLocalWindowCounts, fetchNanfuLocalWindows, fetchNanfuMemberEnvironments, fetchNanfuOverview, nanfuLoginName, reassignNanfuWindow, type NanfuLocalWindow, type NanfuMember, type NanfuOrgOverview, type NanfuOrganization, type NanfuMutations, type NanfuVisibleEnvironment } from "./api.ts";

/** Resolves with the outcome so a dialog can stay open and show the server's reason. */
export type NanfuMutationHandler = <K extends keyof NanfuMutations>(action: K, input: NanfuMutations[K]["input"]) => Promise<{ ok: boolean; error?: string }>;

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
  ? "" : "密码需为 6 至 12 位非空白可打印字符，必须包含英文字母和数字，符号可选。";
const memberLabel = (member: NanfuMember) => member.displayName || nanfuLoginName(member.email) || member.userId;
const memberGroupNames = (overview: NanfuOrgOverview, userId: string) => overview.grants
  .filter(grant => grant.userId === userId)
  .map(grant => overview.groups.find(group => group.id === grant.groupId)?.name || grant.groupId);
const memberGroupIds = (overview: NanfuOrgOverview, userId: string) => overview.grants
  .filter(grant => grant.userId === userId).map(grant => grant.groupId);
const togglePick = (prev: Set<string>, id: string) => {
  const next = new Set(prev);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
};

/** 比特式的居中弹窗：所有账号相关操作都在这里完成，不再往表格里塞。 */
function Modal({ title, subtitle, onClose, children, footer }: {
  title: string; subtitle?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode;
}) {
  return <div className="modal-backdrop" onClick={onClose}>
    <div className="modal nanfu-dialog" role="dialog" aria-modal="true" aria-label={title} onClick={event => event.stopPropagation()}>
      <div className="modal-head">
        <div className="nanfu-dialog-title">
          <strong>{title}</strong>
          {subtitle && <small>{subtitle}</small>}
        </div>
        <button type="button" className="modal-close" aria-label="关闭" onClick={onClose}>✕</button>
      </div>
      <div className="modal-body">{children}</div>
      {footer && <div className="modal-foot">{footer}</div>}
    </div>
  </div>;
}

/**
 * Group checkboxes with a master 全选. Uncontrolled on purpose: the form reads
 * its values with FormData, and the master just flips the others.
 */
function GroupPicker({ groups, granted, legend, disabled }: {
  groups: NanfuOrgOverview["groups"]; granted: string[]; legend: string; disabled: boolean;
}) {
  const boxes = useRef<HTMLFieldSetElement>(null);
  const flip = (checked: boolean) => {
    const list = boxes.current?.querySelectorAll<HTMLInputElement>('input[name="groupIds"]');
    if (list) for (const box of Array.from(list)) box.checked = checked;
  };
  return <fieldset ref={boxes} className="nanfu-controls nanfu-groups" disabled={disabled}>
    <div className="nanfu-groups-head">
      <span>{legend}</span>
      {!!groups.length && <div className="nanfu-groups-actions">
        <button type="button" className="tlink" onClick={() => flip(true)}>全选</button>
        <button type="button" className="tlink" onClick={() => flip(false)}>清空</button>
      </div>}
    </div>
    {!groups.length ? <p className="nanfu-hint">还没有分组。在「高级：角色、分组与邀请码」里创建，再把窗口放进分组。</p>
      : <div className="nanfu-permissions">
        {groups.map(group => <label key={group.id} className="nanfu-check">
          <input type="checkbox" name="groupIds" value={group.id} defaultChecked={granted.includes(group.id)} />{group.name}
        </label>)}
      </div>}
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
    <summary>查看</summary>
    {state.loading && <p>正在读取窗口…</p>}
    {state.error && <p className="modal-err" role="alert">{state.error}</p>}
    {state.items && !state.items.length && <p>这个账号还没有窗口。</p>}
    {!!state.items?.length && <ul className="nanfu-invites">{state.items.map(env => <li key={env.id}>
      {env.id}<br /><small>{groupName(env.groupId)}{updated(env.updatedAt)}</small>
    </li>)}</ul>}
  </details>;
}

/** 添加账号：居中弹窗、单列字段、用户名一键生成、分组全选。 */
function AddAccountDialog({ overview, owner, admin, currentUserId, busy, onMutate, onClose }: {
  overview: NanfuOrgOverview; owner: boolean; admin: boolean;
  currentUserId: string; busy: boolean; onMutate: NanfuMutationHandler; onClose: () => void;
}) {
  const scoped = !admin;
  // 服务端只保存 owner/admin/member 三种身份：这里的“经理”是不挂上级的普通
  // 成员，“成员”则是挂在某位经理名下的子账号（沿用原来的 kind 取值）。
  const [kind, setKind] = useState<"member" | "admin">("member");
  const [inputError, setInputError] = useState("");
  const [saving, setSaving] = useState(false);
  const usernameRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const self = overview.members.find(member => member.userId === currentUserId);
  const initialParent = self && self.identity !== "owner" ? currentUserId : "";
  const [parent, setParent] = useState(initialParent);
  const parents = overview.members.filter(member => member.identity !== "owner" && member.status === "active" && !member.locked
    && (!scoped || member.userId === currentUserId));
  const generateUsername = () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    if (usernameRef.current) usernameRef.current.value = `nf${suffix}`;
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || saving) return;
    const data = new FormData(event.currentTarget);
    const email = text(data, "email").toLowerCase();
    const password = String(data.get("password") ?? "");
    const validLogin = email.includes("@") ? /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)
      : Array.from(email).length >= 2 && Array.from(email).length <= 63 && !/[\s@\u0000-\u001f\u007f-\u009f]/u.test(email);
    const problem = !validLogin ? "登录名需为 2 至 63 个字符，支持中文，不能包含空白、@ 或控制字符；邮箱须填写完整。" : passwordProblem(password);
    setInputError(problem);
    if (problem) return;
    setSaving(true);
    try {
      const result = await onMutate("create-account", {
        email,
        password,
        identity: kind === "admin" ? "admin" : "member",
        quota: Math.min(100, Math.max(0, Math.trunc(Number(text(data, "quota") || "0")) || 0)),
        managerUserId: kind === "admin" ? undefined : parent || undefined,
        roleId: text(data, "roleId") || undefined,
        groupIds: data.getAll("groupIds").map(String).filter(Boolean),
        name: text(data, "name") || undefined,
      });
      if (result.ok) onClose();
      else setInputError(result.error ?? "账号创建失败，请重试");
    } catch (error) {
      setInputError(error instanceof Error ? error.message : "账号创建失败，请重试");
    } finally {
      setSaving(false);
    }
  };
  return <Modal
    title="添加账号"
    subtitle={scoped ? "只能把新账号挂在自己名下" : undefined}
    onClose={onClose}
    footer={<>
      <button className="btn" type="button" disabled={busy || saving} onClick={onClose}>取消</button>
      <button className="btn primary" type="button" disabled={busy || saving} onClick={() => formRef.current?.requestSubmit()}>确定</button>
    </>}
  >
    <form ref={formRef} id="nanfu-add-account-form" className="nanfu-dialog-form" aria-label="添加账号" onSubmit={event => void submit(event)}>
      <p className="nanfu-hint">直接填登录名和密码就能建号：不需要对方先注册，也不需要邀请码。</p>

      <label className="fld"><span>姓名 <b className="req">*</b></span>
        <input name="name" type="text" maxLength={60} autoComplete="off" required placeholder="请输入姓名" disabled={busy || saving} />
      </label>

      <label className="fld"><span>用户名 <b className="req">*</b></span>
        <div className="nanfu-input-row">
          <input ref={usernameRef} name="email" type="text" autoComplete="off" maxLength={320} required placeholder="请输入登录用户名" disabled={busy || saving} />
          <button type="button" className="tlink nanfu-generate" disabled={busy || saving} onClick={generateUsername}>一键生成</button>
        </div>
      </label>

      <label className="fld"><span>登录密码 <b className="req">*</b></span>
        <input name="password" type="password" autoComplete="new-password" minLength={6} maxLength={12} required placeholder="6-12 位，须含英文字母和数字" disabled={busy || saving} />
      </label>

      <label className="fld"><span>角色 <b className="req">*</b></span>
        <select name="roleId" defaultValue="" required={overview.roles.length > 0} disabled={busy || saving}>
          <option value="">{overview.roles.length ? "请选择角色" : "默认权限"}</option>
          {overview.roles.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}
        </select>
      </label>

      <fieldset className="nanfu-controls">
        <legend>身份</legend>
        <div className="nanfu-permissions">
          {owner && <label className="nanfu-check"><input type="radio" name="identity" value="admin" checked={kind === "admin"} onChange={() => setKind("admin")} disabled={busy || saving} />管理员</label>}
          <label className="nanfu-check"><input type="radio" name="identity" value="member" checked={kind === "member"} onChange={() => setKind("member")} disabled={busy || saving} />成员</label>
        </div>
        <p className="nanfu-hint" style={{ margin: "6px 0 0" }}>成员不具有管理权限，仅可以管理名下窗口数据；指定上级后成为对方名下的子账号。</p>
      </fieldset>

      <label className="fld"><span>上级经理（可选）</span>
        <select name="managerUserId" value={parent} onChange={event => setParent(event.target.value)} disabled={busy || saving || scoped || kind === "admin"}>
          <option value="">不指定（独立成员）</option>
          {parents.map(member => <option key={member.userId} value={member.userId}>
            {memberLabel(member)} · {nanfuIdentityName(member.identity)}{member.userId === currentUserId ? "（我）" : ""}
          </option>)}
        </select>
      </label>

      <label className="fld"><span>窗口配额（0 不限，最多 100）</span>
        <input name="quota" type="number" min="0" max="100" step="1" defaultValue={0} disabled={busy || saving} />
      </label>

      <GroupPicker key={overview.groups.length} groups={overview.groups} granted={[]} legend="授权分组（窗口）" disabled={busy || saving} />

      {inputError && <p className="modal-err" role="alert">{inputError}</p>}
      <p className="nanfu-hint">登录名可填中文姓名、用户名或完整邮箱；2 至 63 个字符，不能含空白或控制字符。添加后对方直接用用户名和密码登录。</p>
    </form>
  </Modal>;
}

/** 账号设置：独立弹窗，分组、密码、配额、移除各占一段，不再挤在表格里。 */
function MemberSettingsDialog({ member, overview, owner, currentUserId, busy, onMutate, onClose, onWindowsChanged }: {
  member: NanfuMember; overview: NanfuOrgOverview; owner: boolean;
  currentUserId: string; busy: boolean; onMutate: NanfuMutationHandler; onClose: () => void;
  onWindowsChanged?: () => void;
}) {
  const [resetError, setResetError] = useState("");
  const [error, setError] = useState("");
  const [memberWindows, setMemberWindows] = useState<NanfuLocalWindow[]>([]);
  const [myWindows, setMyWindows] = useState<NanfuLocalWindow[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pickedMine, setPickedMine] = useState<Set<string>>(new Set());
  const [windowsBusy, setWindowsBusy] = useState(false);
  const [windowsErr, setWindowsErr] = useState("");
  const loadLocalWindows = async () => {
    const [theirs, mine] = await Promise.all([
      fetchNanfuLocalWindows(member.userId).catch(() => ({ windows: [] as NanfuLocalWindow[] })),
      fetchNanfuLocalWindows(currentUserId).catch(() => ({ windows: [] as NanfuLocalWindow[] })),
    ]);
    setMemberWindows(theirs.windows);
    setMyWindows(mine.windows);
  };
  useEffect(() => { void loadLocalWindows(); }, [member.userId, currentUserId]);
  const moveWindows = async (ids: string[], toUserId: string) => {
    if (!ids.length) return;
    setWindowsBusy(true);
    setWindowsErr("");
    try {
      for (const id of ids) await reassignNanfuWindow(id, toUserId);
      setPicked(new Set());
      setPickedMine(new Set());
      await loadLocalWindows();
      onWindowsChanged?.();
    } catch (failure) {
      setWindowsErr(failure instanceof Error ? failure.message : "窗口归属修改失败，请重试");
    } finally {
      setWindowsBusy(false);
    }
  };
  const parent = overview.members.find(item => item.userId === member.managerUserId);
  const group = nanfuAccountGroup(member);
  const grantedIds = memberGroupIds(overview, member.userId);
  const run = async <K extends keyof NanfuMutations>(action: K, input: NanfuMutations[K]["input"]): Promise<boolean> => {
    setError("");
    try {
      const result = await onMutate(action, input);
      if (result.ok) return true;
      setError(result.error ?? "保存失败，请重试");
      return false;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "保存失败，请重试");
      return false;
    }
  };
  return <Modal
    title={memberLabel(member)}
    subtitle={<>{groupNames[group]}{parent ? ` · 所属 ${memberLabel(parent)}` : ""}{member.locked ? " · 已锁定" : member.status !== "active" ? " · 已停用" : ""}</>}
    onClose={onClose}
    footer={<button className="btn" type="button" onClick={onClose}>关闭</button>}
  >
    {error && <p className="modal-err" role="alert">{error}</p>}

    <section className="nanfu-dialog-section">
      <h4>身份与角色</h4>
      <form className="nanfu-dialog-form" aria-label={`设置 ${memberLabel(member)}`} onSubmit={event => {
        const data = dataOf(event);
        void run("set-member", {
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
        <div className="nanfu-checks">
          <label className="nanfu-check"><input type="checkbox" name="locked" defaultChecked={member.locked} disabled={busy} />锁定登录</label>
          <label className="nanfu-check"><input type="checkbox" name="reclaim" disabled={busy} />停用前把窗口归属改给所有者（不搬运数据）</label>
        </div>
        <div className="nanfu-dialog-actions"><button className="btn primary" type="submit" disabled={busy}>保存</button></div>
      </form>
    </section>

    <section className="nanfu-dialog-section">
      <h4>授权分组</h4>
      <form className="nanfu-dialog-form" aria-label={`授权分组 ${memberLabel(member)}`} onSubmit={event => {
        const data = dataOf(event);
        void run("set-groups", { userId: member.userId, groupIds: data.getAll("groupIds").map(String).filter(Boolean) });
      }}>
        <GroupPicker key={`${overview.groups.length}:${grantedIds.join(",")}`} groups={overview.groups} granted={grantedIds} legend="可查看的分组" disabled={busy} />
        <div className="nanfu-dialog-actions"><button className="btn" type="submit" disabled={busy || !overview.groups.length}>保存分组</button></div>
      </form>
    </section>

    <section className="nanfu-dialog-section">
      <h4>重置登录密码</h4>
      <form className="nanfu-dialog-form" aria-label={`重置密码 ${memberLabel(member)}`} onSubmit={event => {
        const data = dataOf(event);
        const password = String(data.get("password") ?? "");
        const problem = passwordProblem(password);
        setResetError(problem);
        if (problem || busy) return;
        event.currentTarget.reset();
        void run("reset-password", { userId: member.userId, password });
      }}>
        <label className="fld"><span>新密码</span><input name="password" type="password" autoComplete="new-password" minLength={6} maxLength={12} required placeholder="6–12 位英文和数字，符号可选" disabled={busy} /></label>
        <div className="nanfu-dialog-actions"><button className="btn" type="submit" disabled={busy}>重置密码</button></div>
        {resetError && <p className="modal-err" role="alert">{resetError}</p>}
      </form>
    </section>

    <section className="nanfu-dialog-section">
      <h4>窗口配额</h4>
      <form className="nanfu-dialog-form" aria-label={`配额 ${memberLabel(member)}`} onSubmit={event => {
        const data = dataOf(event);
        void run("set-quota", { userId: member.userId, quota: Number(text(data, "quota")) });
      }}>
        <label className="fld"><span>窗口配额（0 不限）</span><input name="quota" type="number" min="0" max="2147483647" step="1" required defaultValue={member.quota} disabled={busy} /></label>
        <div className="nanfu-dialog-actions"><button className="btn" type="submit" disabled={busy}>保存配额</button></div>
      </form>
    </section>

    <section className="nanfu-dialog-section">
      <h4>窗口归属（本机）</h4>
      <p className="nanfu-hint">账号隔离后，每个账号只在自己的浏览器窗口列表里看到名下窗口。这里直接把本机窗口的归属改到对方，窗口数据不搬家。</p>
      {windowsErr && <p className="modal-err" role="alert">{windowsErr}</p>}
      <div className="nanfu-window-cols">
        <div className="nanfu-window-col">
          <h5>{memberLabel(member)} 名下（{memberWindows.length}）</h5>
          {!!memberWindows.length && <div className="nanfu-pick-actions">
            <button type="button" className="tlink" onClick={() => setPicked(new Set(memberWindows.map((w) => w.id)))}>全选</button>
            <button type="button" className="tlink" onClick={() => setPicked(new Set())}>清空</button>
          </div>}
          {!memberWindows.length ? <p className="nanfu-hint">他名下在本机没有窗口。</p>
            : <ul className="nanfu-picklist">{memberWindows.map(w => <li key={w.id}>
              <label className="nanfu-check"><input type="checkbox" checked={picked.has(w.id)} onChange={() => setPicked(prev => togglePick(prev, w.id))} disabled={windowsBusy} />
                <span>{w.name || w.id}{w.group ? ` · ${w.group}` : ""}</span></label>
            </li>)}</ul>}
          <button className="btn" type="button" disabled={windowsBusy || !picked.size} onClick={() => void moveWindows([...picked], currentUserId)}>收回给我（{picked.size}）</button>
        </div>
        <div className="nanfu-window-col">
          <h5>我名下（{myWindows.length}）</h5>
          {!!myWindows.length && <div className="nanfu-pick-actions">
            <button type="button" className="tlink" onClick={() => setPickedMine(new Set(myWindows.map((w) => w.id)))}>全选</button>
            <button type="button" className="tlink" onClick={() => setPickedMine(new Set())}>清空</button>
          </div>}
          {!myWindows.length ? <p className="nanfu-hint">我名下在本机没有窗口。</p>
            : <ul className="nanfu-picklist">{myWindows.map(w => <li key={w.id}>
              <label className="nanfu-check"><input type="checkbox" checked={pickedMine.has(w.id)} onChange={() => setPickedMine(prev => togglePick(prev, w.id))} disabled={windowsBusy} />
                <span>{w.name || w.id}{w.group ? ` · ${w.group}` : ""}</span></label>
            </li>)}</ul>}
          <button className="btn primary" type="button" disabled={windowsBusy || !pickedMine.size} onClick={() => void moveWindows([...pickedMine], member.userId)}>分配给他（{pickedMine.size}）</button>
        </div>
      </div>
    </section>

    <section className="nanfu-dialog-section nanfu-danger-zone">
      <h4>移除账号</h4>
      <p className="nanfu-hint">这里只回收窗口归属，不搬运本机文件，也不解密原账号的云端包。请先完成所需数据转移，再移除账号；本机数据不会删除。</p>
      <div className="nanfu-dialog-actions">
        <button className="btn danger" type="button" disabled={busy} onClick={() => {
          if (window.confirm(`移除 ${memberLabel(member)}？只会把组织内窗口归属改给所有者，不会搬运本机文件或恢复云端加密包。本机数据不删除。`)) {
            void run("remove-member", { userId: member.userId, reclaim: true }).then((ok) => { if (ok) onClose(); });
          }
        }}>移除账号</button>
      </div>
    </section>
  </Modal>;
}

function MemberRow({ member, overview, currentUserId, localCount, onSettings }: {
  member: NanfuMember; overview: NanfuOrgOverview; currentUserId: string; localCount: number; onSettings: () => void;
}) {
  const self = member.userId === currentUserId;
  const parent = overview.members.find(item => item.userId === member.managerUserId);
  const group = nanfuAccountGroup(member);
  const quotaFull = member.quota > 0 && member.used >= member.quota;
  const granted = memberGroupNames(overview, member.userId);
  const editable = group !== "owner" && !self;
  return <tr>
    <td className="nanfu-col-account">
      <span className="nanfu-account-name">{memberLabel(member)}{self && <span className="nanfu-tag">我</span>}</span>
      {member.displayName && <small>{nanfuLoginName(member.email)}</small>}
      {group === "sub" && <small>所属：{parent ? memberLabel(parent) : member.managerUserId}</small>}
    </td>
    <td><span className="nanfu-chip">{member.roleName ?? (group === "owner" ? "全部权限" : "默认权限")}</span></td>
    <td className="nanfu-col-groups">{granted.length ? granted.join("、") : <small>{group === "owner" || group === "admin" ? "全部窗口" : "未授权"}</small>}</td>
    <td className={quotaFull ? "modal-err" : ""}>
      <span className="nanfu-win-counts">本机 {localCount} · 云端 {member.used}</span>
      <small>上限 {member.quota === 0 ? "不限" : member.quota}{quotaFull && " · 已满"}</small>
      <MemberWindows member={member} groups={overview.groups} />
    </td>
    <td>{member.status === "active" ? <span className="nanfu-chip ok">启用</span> : <span className="nanfu-chip off">停用</span>}{member.locked && <small> · 已锁定</small>}</td>
    <td>{!editable ? <small>{group === "owner" ? "受保护" : "本人"}</small>
      : <button type="button" className="btn" onClick={onSettings}>设置</button>}</td>
  </tr>;
}

export function NanfuManagement({ organization, overview, currentUserId, busy, onMutate, onRefresh }: {
  organization: NanfuOrganization; overview: NanfuOrgOverview; currentUserId: string; busy: boolean;
  onMutate: NanfuMutationHandler; onRefresh?: () => void;
}) {
  const [copyStatus, setCopyStatus] = useState("");
  const [adding, setAdding] = useState(false);
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const [localCounts, setLocalCounts] = useState<Record<string, number>>({});
  const refreshLocalCounts = () => {
    void fetchNanfuLocalWindowCounts()
      .then(result => setLocalCounts(result.counts))
      .catch(() => undefined);
  };
  useEffect(() => { refreshLocalCounts(); }, [overview, busy]);
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
  // member 身份登录时只看自己与自己的子账号：把所有者和管理员从成员列表里过滤掉；
  // owner/admin 登录仍查看完整列表。
  const scoped = !admin;
  const roster = scoped ? overview.members.filter(member => member.identity !== "owner" && member.identity !== "admin") : overview.members;
  const visibleGroups = scoped ? groupOrder.filter(group => group !== "owner" && group !== "admin") : groupOrder;
  const groups: Record<NanfuAccountGroup, NanfuMember[]> = { owner: [], admin: [], member: [], sub: [] };
  for (const member of roster) groups[nanfuAccountGroup(member)].push(member);
  const sorted = groupOrder.flatMap(group => groups[group].sort((a, b) => memberLabel(a).localeCompare(memberLabel(b))));
  const settingsMember = settingsFor ? overview.members.find(member => member.userId === settingsFor) ?? null : null;
  const copy = async (code: string) => {
    try { await navigator.clipboard.writeText(code); setCopyStatus("邀请码已复制"); }
    catch { setCopyStatus("无法访问剪贴板，请选中邀请码手动复制"); }
  };
  return <>
    {adding && <AddAccountDialog overview={overview} owner={owner} admin={admin} currentUserId={currentUserId}
      busy={busy} onMutate={onMutate} onClose={() => setAdding(false)} />}
    {settingsMember && <MemberSettingsDialog key={settingsMember.userId} member={settingsMember} overview={overview}
      owner={owner} currentUserId={currentUserId} busy={busy} onMutate={onMutate} onWindowsChanged={refreshLocalCounts}
      onClose={() => setSettingsFor(null)} />}

    <section className="settings-card" aria-label="员工管理">
      <header>
        <h3>员工管理</h3>
        <div className="nanfu-head-actions">
          {onRefresh && <button type="button" className="btn" disabled={busy} onClick={onRefresh}>刷新成员</button>}
          <button type="button" className="btn primary" onClick={() => { setSettingsFor(null); setAdding(true); }}>添加账号</button>
        </div>
      </header>
      <div className="card-body">
        <p className="nanfu-staff-counts">
          {visibleGroups.map(group => <span key={group}>{groupNames[group]} {groups[group].length}</span>)}
          <span>组织窗口 {used} / {organization.planQuota === 0 ? "不限" : organization.planQuota}</span>
        </p>
        {overAllocated && <p className="modal-err" role="alert">成员配额合计 {allocated} 已超过组织窗口 {organization.planQuota}：服务端按实际用量拦截，新建环境会失败。请下调成员配额。</p>}
        {!overAllocated && orgQuotaFull && <p className="modal-err" role="alert">组织窗口已用满（{used} / {organization.planQuota}），新建或接收环境会被服务端拒绝；本机窗口不计入组织额度。</p>}
        {!sorted.length ? <p className="nanfu-empty">还没有成员。</p> : <div className="nanfu-table-wrap"><table className="nanfu-table nanfu-roster">
          <thead><tr><th>账号</th><th>角色</th><th>授权分组</th><th>窗口</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>{sorted.map(member => <MemberRow key={member.userId} member={member} overview={overview}
            currentUserId={currentUserId} localCount={localCounts[member.userId] ?? 0}
            onSettings={() => { setAdding(false); setSettingsFor(member.userId); }} />)}</tbody>
        </table></div>}
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
          {!overview.grants.length ? <p className="nanfu-empty">暂无显式分组授权。</p> : <ul>{overview.grants.map(grant => {
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
          {!overview.invites.length ? <p className="nanfu-empty">暂无邀请码。</p> : <ul className="nanfu-invites">{overview.invites.map(invite => <li key={invite.code}>
            <code>{invite.code}</code> · {nanfuIdentityName(invite.identity)} · {invite.redeemedBy ? "已兑换" : Date.parse(invite.expiresAt) <= Date.now() ? "已过期" : "未兑换"} · 到期：{invite.expiresAt}
            <button type="button" className="btn" onClick={() => void copy(invite.code)}>复制邀请码</button>
          </li>)}</ul>}
        </fieldset>
      </div>
    </details>
  </>;
}

/**
 * 浏览器窗口页的「转移 / 回收」：一次弹窗里同时做两件事——把自己的窗口分配给
 * 某个成员，或把那名成员名下的本机窗口收回来。账号隔离保持不变：双方只在
 * 自己的浏览器窗口列表里看到各自名下的窗口。
 */
export function NanfuWindowTransferDialog({ onClose, onChanged }: { onClose: () => void; onChanged?: () => void }) {
  const [currentUserId, setCurrentUserId] = useState("");
  const [members, setMembers] = useState<NanfuMember[]>([]);
  const [targetId, setTargetId] = useState("");
  const [myWindows, setMyWindows] = useState<NanfuLocalWindow[]>([]);
  const [theirWindows, setTheirWindows] = useState<NanfuLocalWindow[]>([]);
  const [pickedMine, setPickedMine] = useState<Set<string>>(new Set());
  const [pickedTheirs, setPickedTheirs] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const loadMine = async () => {
    const result = await fetchNanfuLocalWindows().catch(() => ({ windows: [] as NanfuLocalWindow[] }));
    setMyWindows(result.windows);
  };
  const loadTheirs = async (userId: string) => {
    if (!userId) { setTheirWindows([]); return; }
    const result = await fetchNanfuLocalWindows(userId).catch(() => ({ windows: [] as NanfuLocalWindow[] }));
    setTheirWindows(result.windows);
  };
  useEffect(() => {
    void (async () => {
      try {
        const state = await fetchNanfuEnvironments();
        setCurrentUserId(state.userId);
        await loadMine();
        const organization = state.organization;
        if (!organization || (organization.identity !== "owner" && organization.identity !== "admin")) {
          setError("只有所有者或管理员可以转移或回收窗口");
          return;
        }
        const overview = await fetchNanfuOverview();
        setMembers(overview.result.members.filter(member => member.userId !== state.userId && member.identity !== "owner"));
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : "读取成员失败，请重试");
      }
    })();
  }, []);
  useEffect(() => { void loadTheirs(targetId); }, [targetId]);

  const move = async (ids: string[], toUserId: string) => {
    if (!ids.length || !toUserId) return;
    setBusy(true);
    setError("");
    try {
      for (const id of ids) await reassignNanfuWindow(id, toUserId);
      setPickedMine(new Set());
      setPickedTheirs(new Set());
      await Promise.all([loadMine(), loadTheirs(targetId)]);
      onChanged?.();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "窗口归属修改失败，请重试");
    } finally {
      setBusy(false);
    }
  };
  const target = members.find(member => member.userId === targetId);
  return <Modal title="转移 / 回收窗口" subtitle="同一台电脑上直接改窗口归属，窗口数据不搬家" onClose={onClose}
    footer={<button className="btn" type="button" onClick={onClose}>关闭</button>}>
    {error && <p className="modal-err" role="alert">{error}</p>}
    <label className="fld"><span>目标成员</span>
      <select value={targetId} onChange={event => setTargetId(event.target.value)} disabled={busy}>
        <option value="">请选择成员</option>
        {members.map(member => <option key={member.userId} value={member.userId}>{memberLabel(member)} · {nanfuIdentityName(member.identity)}</option>)}
      </select>
    </label>
    <div className="nanfu-window-cols">
      <div className="nanfu-window-col">
        <h5>我的窗口（{myWindows.length}）</h5>
        {!myWindows.length ? <p className="nanfu-hint">本机没有我的窗口。</p> : <>
          <div className="nanfu-pick-actions">
            <button type="button" className="tlink" onClick={() => setPickedMine(new Set(myWindows.map(w => w.id)))}>全选</button>
            <button type="button" className="tlink" onClick={() => setPickedMine(new Set())}>清空</button>
          </div>
          <ul className="nanfu-picklist">{myWindows.map(w => <li key={w.id}>
            <label className="nanfu-check"><input type="checkbox" checked={pickedMine.has(w.id)} onChange={() => setPickedMine(prev => togglePick(prev, w.id))} disabled={busy} />
              <span>{w.name || w.id}{w.group ? ` · ${w.group}` : ""}</span></label>
          </li>)}</ul>
        </>}
        <button className="btn primary" type="button" disabled={busy || !pickedMine.size || !targetId} onClick={() => void move([...pickedMine], targetId)}>分配给他（{pickedMine.size}）</button>
      </div>
      <div className="nanfu-window-col">
        <h5>{target ? `${memberLabel(target)} 的窗口` : "对方窗口"}（{theirWindows.length}）</h5>
        {!targetId ? <p className="nanfu-hint">先选择成员，才能回收他名下的窗口。</p>
          : !theirWindows.length ? <p className="nanfu-hint">他名下在本机没有窗口。</p>
          : <>
            <div className="nanfu-pick-actions">
              <button type="button" className="tlink" onClick={() => setPickedTheirs(new Set(theirWindows.map(w => w.id)))}>全选</button>
              <button type="button" className="tlink" onClick={() => setPickedTheirs(new Set())}>清空</button>
            </div>
            <ul className="nanfu-picklist">{theirWindows.map(w => <li key={w.id}>
              <label className="nanfu-check"><input type="checkbox" checked={pickedTheirs.has(w.id)} onChange={() => setPickedTheirs(prev => togglePick(prev, w.id))} disabled={busy} />
                <span>{w.name || w.id}{w.group ? ` · ${w.group}` : ""}</span></label>
            </li>)}</ul>
          </>}
        <button className="btn" type="button" disabled={busy || !pickedTheirs.size || !currentUserId} onClick={() => void move([...pickedTheirs], currentUserId)}>收回给我（{pickedTheirs.size}）</button>
      </div>
    </div>
    <p className="nanfu-hint">跨电脑转移请用转移页的「带登录态的转移」；这里只改本机归属。</p>
  </Modal>;
}
