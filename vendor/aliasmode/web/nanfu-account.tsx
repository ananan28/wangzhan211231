import { useEffect, useMemo, useRef, useState } from "react";
import {
  nanfuAuthAction, fetchNanfuEnvironments, fetchNanfuOverview, nanfuOrganizationAction, NanfuApiError,
  type NanfuAccountState, type NanfuOrganization, type NanfuVisibleEnvironment, type NanfuOrgOverview, type NanfuMutations,
} from "./api.ts";
import { NanfuManagement, nanfuIdentityName } from "./nanfu-management.tsx";

export function NanfuAccountPage({ active, localCount, onLocal }: { active: boolean; localCount: number | null; onLocal: () => void }) {
  const [account, setAccount] = useState<NanfuAccountState>({ authenticated: false });
  const [persistent, setPersistent] = useState<boolean | null>(null);
  const [organization, setOrganization] = useState<NanfuOrganization | null>(null);
  const [environments, setEnvironments] = useState<NanfuVisibleEnvironment[]>([]);
  const [overview, setOverview] = useState<NanfuOrgOverview | null>(null);
  const [organizationName, setOrganizationName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [organizationLoaded, setOrganizationLoaded] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signup, setSignup] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [retry, setRetry] = useState<"restore" | "signout" | null>(null);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("all");
  const [ownedOnly, setOwnedOnly] = useState(false);
  const request = useRef({ generation: 0, controller: new AbortController() });

  const begin = () => {
    request.current.controller.abort();
    const next = { generation: request.current.generation + 1, controller: new AbortController() };
    request.current = next;
    setBusy(true);
    setError(null);
    setRetry(null);
    setOrganization(null);
    setOrganizationLoaded(false);
    setOverview(null);
    setEnvironments([]);
    setQuery("");
    setGroup("all");
    setOwnedOnly(false);
    return next;
  };
  const current = (generation: number) => request.current.generation === generation && !request.current.controller.signal.aborted;
  const load = async (generation: number, signal: AbortSignal, userId: string) => {
    const result = await fetchNanfuEnvironments(signal);
    if (!current(generation)) return;
    if (result.userId !== userId) throw new Error("账号已切换，请重新登录");
    setOrganization(result.organization);
    setEnvironments(result.environments);
    setOrganizationLoaded(true);
    const org = result.organization;
    if (org && !org.locked && org.status === "active" && ["owner", "admin"].includes(org.identity)) {
      const detail = await fetchNanfuOverview(signal);
      if (!current(generation)) return;
      if (detail.userId !== userId) throw new Error("账号已切换，请重新登录");
      setOverview(detail.result);
    }
  };
  const authenticate = async (action: "signin" | "signup" | "restore" | "signout") => {
    const { generation, controller } = begin();
    setNotice(null);
    setAccount({ authenticated: false });
    setPassword("");
    setOrganizationName("");
    setInviteCode("");
    let authenticated = false;
    try {
      const result = await nanfuAuthAction(action, action === "signin" || action === "signup" ? { email, password } : {}, controller.signal);
      if (!current(generation)) return;
      if (action === "signup") {
        setSignup(false);
        setNotice(result.verificationRequired ? `已向 ${result.email} 发送确认邮件；请确认邮箱后再登录。` : "注册成功，请登录南孚账号。");
      } else {
        const state = result.state!;
        authenticated = state.authenticated;
        setAccount(state);
        setPersistent(result.persistent === true);
        if (state.authenticated && state.userId) await load(generation, controller.signal, state.userId);
        if (action === "signout") setNotice("已退出南孚账号；本机环境保持不变。");
      }
    } catch (failure) {
      if (!current(generation)) return;
      if (authenticated && failure instanceof NanfuApiError && failure.status === 401) setAccount({ authenticated: false });
      setError(failure instanceof Error ? failure.message : "南孚服务暂时不可用，请重试");
      if (!authenticated && (action === "restore" || action === "signout")) setRetry(action);
    } finally {
      if (current(generation)) { setPassword(""); setBusy(false); }
    }
  };
  const refresh = async () => {
    if (!account.userId) return;
    const { generation, controller } = begin();
    setNotice(null);
    try { await load(generation, controller.signal, account.userId); }
    catch (failure) {
      if (!current(generation)) return;
      if (failure instanceof NanfuApiError && failure.status === 401) setAccount({ authenticated: false });
      setError(failure instanceof Error ? failure.message : "组织列表暂时不可用");
    } finally { if (current(generation)) setBusy(false); }
  };
  const mutate = async <K extends keyof NanfuMutations,>(action: K, input: NanfuMutations[K]["input"]): Promise<void> => {
    if (!account.userId || busy) return;
    const userId = account.userId;
    const { generation, controller } = begin();
    setNotice(null);
    let confirmed = false;
    try {
      const response = await nanfuOrganizationAction(action, input, controller.signal);
      if (!current(generation)) return;
      if (response.userId !== userId) throw new Error("账号已切换，请重新登录");
      confirmed = true;
      const result = response.result;
      setNotice("code" in result ? `邀请码已生成：${result.code}（单次使用）`
        : "reclaimed" in result ? `成员已移除，已回收 ${result.reclaimed} 个组织环境。`
        : action === "create-organization" ? "组织已创建，你已成为所有者（组织管理员）。"
        : action === "redeem-invite" ? "邀请码已兑换，已加入组织。" : "操作已成功，列表已刷新。");
      setOrganizationName(""); setInviteCode("");
      await load(generation, controller.signal, userId);
    } catch (failure) {
      if (!current(generation)) return;
      if (failure instanceof NanfuApiError && failure.status === 401) setAccount({ authenticated: false });
      setError(`${confirmed ? "操作已成功，但列表刷新失败；请勿重复提交。" : ""}${failure instanceof Error ? failure.message : "操作失败，请先刷新确认"}`);
    } finally { if (current(generation)) setBusy(false); }
  };
  useEffect(() => {
    void authenticate("restore");
    return () => { request.current.generation++; request.current.controller.abort(); };
  }, []);
  const groups = [...new Set(environments.map(item => item.groupId).filter((id): id is string => !!id))];
  const filtered = useMemo(() => environments.filter(item =>
    (!ownedOnly || item.ownerUserId === account.userId) && (group === "all" || item.groupId === group) &&
    [item.id, item.ownerUserId, item.groupId ?? ""].some(value => value.toLowerCase().includes(query.trim().toLowerCase()))
  ), [environments, ownedOnly, account.userId, group, query]);

  return <section className="workspace nanfu-account-page" hidden={!active} aria-label="南孚账号与组织">
    <div className="settingspage">
      <h2 className="sect-title">南孚账号与组织</h2>
      <p>南孚自有账号，与上游 AliasMode Cloud 独立。本机环境不会自动上传或转移。</p>
      {localCount !== null && <button className="btn" type="button" onClick={onLocal}>查看本机环境（{localCount}）</button>}
      <section className="settings-card"><header><h3>南孚账号</h3></header><div className="card-body">
        {busy && <p role="status">正在处理南孚账号或读取组织列表…</p>}
        {persistent === false && <p>当前为会话内登录；无原生凭据库，关闭服务后需重新登录，不保存明文令牌。</p>}
        {persistent === true && <p>刷新令牌仅保存在系统凭据库，重启后恢复；密码不保存。</p>}
        {notice && <p role="status">{notice}</p>}
        {error && <p className="modal-err" role="alert">{error}</p>}
        {retry && <button className="btn" disabled={busy} onClick={() => void authenticate(retry)}>{retry === "restore" ? "重试恢复登录" : "重试退出账号"}</button>}
        {account.authenticated ? <>
          <p data-testid="nanfu-identity">已登录：{account.email ?? account.userId}</p>
          <button className="btn danger" onClick={() => void authenticate("signout")}>退出南孚账号 / 切换账号</button>
        </> : <form className="nanfu-auth-form" onSubmit={event => { event.preventDefault(); void authenticate(signup ? "signup" : "signin"); }}>
          <label className="fld"><span>南孚邮箱</span><input type="email" autoComplete="username" required value={email} onChange={event => setEmail(event.target.value)} disabled={busy} /></label>
          <label className="fld"><span>南孚密码</span><input type="password" autoComplete={signup ? "new-password" : "current-password"} minLength={6} required value={password} onChange={event => setPassword(event.target.value)} disabled={busy} /></label>
          <button className="btn primary" type="submit" disabled={busy}>{signup ? "注册南孚账号" : "登录南孚账号"}</button>
          <button className="btn" type="button" disabled={busy} onClick={() => { setSignup(!signup); setPassword(""); setError(null); }}>{signup ? "已有账号，去登录" : "没有账号，去注册"}</button>
        </form>}
      </div></section>
      {account.authenticated && <section className="settings-card"><header><h3>当前组织与可见环境</h3></header><div className="card-body">
        <button className="btn" disabled={busy} onClick={() => void refresh()}>刷新组织列表</button>
        {!busy && organizationLoaded && !organization && <>
          <p>当前账号尚未加入组织；本机环境仍可使用。</p>
          <form className="nanfu-form" aria-label="创建组织" onSubmit={event => { event.preventDefault(); void mutate("create-organization", { name: organizationName.trim() }); }}>
            <label className="fld"><span>组织名称</span><input required maxLength={120} value={organizationName} onChange={event => setOrganizationName(event.target.value)} /></label>
            <button className="btn primary" disabled={!organizationName.trim()} type="submit">创建组织（我成为管理员）</button>
          </form>
          <form className="nanfu-form" aria-label="兑换邀请码" onSubmit={event => { event.preventDefault(); void mutate("redeem-invite", { code: inviteCode.trim() }); }}>
            <label className="fld"><span>邀请码</span><input required maxLength={128} value={inviteCode} onChange={event => setInviteCode(event.target.value)} autoComplete="off" /></label>
            <button className="btn" disabled={!inviteCode.trim()} type="submit">兑换邀请码加入组织</button>
          </form>
        </>}
        {organization && <>
          <p data-testid="nanfu-organization">组织：{organization.name} · 身份：{nanfuIdentityName(organization.identity)} · 角色：{organization.roleName ?? (organization.identity === "owner" ? "所有者内置权限" : "未分配")}</p>
          <p className={organization.quota > 0 && organization.used > organization.quota ? "modal-err" : ""}>本人配额：{organization.used} / {organization.quota === 0 ? "不限" : organization.quota}</p>
          {organization.locked || organization.status !== "active" ? <p role="alert">账号{organization.locked ? "已锁定" : "未锁定"} / {organization.status === "active" ? "启用" : "已停用"}，不能访问组织环境。请联系管理员。</p> : <>
            <p>仅显示服务端授权可见的元数据；未下载到本机的组织条目不可启动，本批不包含登录态迁移。</p>
            <div className="nanfu-filters">
              <label className="fld"><span>搜索组织环境</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="环境编号、归属人或分组" /></label>
              <label className="fld"><span>可见分组</span><select value={group} onChange={event => setGroup(event.target.value)}><option value="all">全部可见分组</option>{groups.map(id => <option key={id} value={id}>{id}</option>)}</select></label>
              <label><input type="checkbox" checked={ownedOnly} onChange={event => setOwnedOnly(event.target.checked)} />仅本人拥有</label>
            </div>
            {!environments.length && <p>暂无可见组织环境；组织可能为空，或尚未向你授权分组。</p>}
            {!!environments.length && !filtered.length && <p>当前筛选条件下没有环境。</p>}
            {!!filtered.length && <div className="nanfu-table-wrap"><table className="nanfu-table"><thead><tr><th>环境编号</th><th>来源</th><th>归属</th><th>分组</th><th>状态</th></tr></thead><tbody>{filtered.map(item => <tr key={`${item.orgId}:${item.ownerUserId}:${item.id}`}>
              <td>{item.id}</td><td>组织云端</td><td>{item.ownerUserId === account.userId ? "本人" : item.ownerUserId}</td><td>{item.groupId ?? "未分组"}</td><td>仅元数据 · 不可启动</td>
            </tr>)}</tbody></table></div>}
          </>}
        </>}
      </div></section>}
      {account.authenticated && organization && overview && <NanfuManagement organization={organization} overview={overview} busy={busy} onMutate={mutate} />}
    </div>
  </section>;
}
