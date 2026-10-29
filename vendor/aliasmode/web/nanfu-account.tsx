import { useEffect, useMemo, useRef, useState } from "react";
import {
  nanfuAuthAction, nanfuSelfJoin, fetchNanfuEnvironments, nanfuOrganizationAction, nanfuLoginName, normalizeNanfuLogin, NanfuApiError, changeNanfuPassword,
  fetchNanfuLoginName, setNanfuLoginName, clearNanfuLoginName,
  type NanfuAccountState, type NanfuOrganization, type NanfuVisibleEnvironment, type NanfuMutations,
} from "./api.ts";
import { NANFU_MIN_PASSWORD_LENGTH } from "./nanfu-account.ts";
import { nanfuIdentityName } from "./nanfu-management.tsx";

export function NanfuAccountPage({ active, localCount, onLocal }: { active: boolean; localCount: number | null; onLocal: () => void }) {
  const [account, setAccount] = useState<NanfuAccountState>({ authenticated: false });
  const [persistent, setPersistent] = useState<boolean | null>(null);
  const [organization, setOrganization] = useState<NanfuOrganization | null>(null);
  const [environments, setEnvironments] = useState<NanfuVisibleEnvironment[]>([]);
  const [organizationName, setOrganizationName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [signInInvite, setSignInInvite] = useState("");
  const [organizationLoaded, setOrganizationLoaded] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [retry, setRetry] = useState<"restore" | "signout" | null>(null);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("all");
  const [ownedOnly, setOwnedOnly] = useState(false);
  const [loginName, setLoginNameState] = useState<string | null>(null);
  const [loginDraft, setLoginDraft] = useState("");
  const [loginManaged, setLoginManaged] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const request = useRef({ generation: 0, controller: new AbortController() });

  const begin = (clear = true) => {
    request.current.controller.abort();
    const next = { generation: request.current.generation + 1, controller: new AbortController() };
    request.current = next;
    setBusy(true);
    setError(null);
    setRetry(null);
    if (clear) {
      setOrganization(null);
      setOrganizationLoaded(false);
      setEnvironments([]);
      setQuery("");
      setGroup("all");
      setOwnedOnly(false);
    }
    return next;
  };
  const current = (generation: number) => request.current.generation === generation && !request.current.controller.signal.aborted;
  const load = async (generation: number, signal: AbortSignal, userId: string) => {
    const [result, identity] = await Promise.all([
      fetchNanfuEnvironments(signal),
      // An older server has no login-name endpoint; the card then stays hidden.
      fetchNanfuLoginName(signal).catch(() => null),
    ]);
    if (!current(generation)) return;
    if (result.userId !== userId) throw new Error("账号已切换，请重新登录");
    setOrganization(result.organization);
    setEnvironments(result.environments);
    setOrganizationLoaded(true);
    if (identity) {
      setLoginNameState(identity.name);
      setLoginDraft(identity.name ?? "");
      setLoginManaged(identity.managed);
    }
  };
  const authenticate = async (action: "signin" | "restore" | "signout") => {
    const { generation, controller } = begin();
    setNotice(null);
    setAccount({ authenticated: false });
    setPassword("");
    setOrganizationName("");
    setInviteCode("");
    let authenticated = false;
    try {
      // A bare login name becomes <name>@nanfu.local, so employees never need
      // an inbox; a full address is used as typed.
      const credentials = { email: action === "signin" ? normalizeNanfuLogin(email) : email.trim(), password };
      const result = await nanfuAuthAction(action, action === "signin"
        ? (signInInvite.trim() ? { ...credentials, invite: signInInvite.trim() } : credentials)
        : {}, controller.signal);
      if (!current(generation)) return;
      const state = result.state!;
      authenticated = state.authenticated;
      setAccount(state);
      setPersistent(result.persistent === true);
      if (result.selfJoin?.ok === false) setNotice(result.selfJoin.error ?? "加入默认组织失败，可稍后重试");
      else if (result.selfJoin?.orgId) setNotice("邀请码已兑换，已加入对应组织。");
      if (state.authenticated && state.userId) await load(generation, controller.signal, state.userId);
      if (action === "signout") setNotice("已退出南孚账号；本机环境保持不变。");
    } catch (failure) {
      if (!current(generation)) return;
      if (authenticated && failure instanceof NanfuApiError && failure.status === 401) setAccount({ authenticated: false });
      setError(failure instanceof Error ? failure.message : "南孚服务暂时不可用，请重试");
      if (!authenticated && (action === "restore" || action === "signout")) setRetry(action);
    } finally {
      if (current(generation)) { setPassword(""); setSignInInvite(""); setBusy(false); }
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
  const join = async () => {
    if (!account.userId || busy) return;
    const userId = account.userId;
    const { generation, controller } = begin();
    setNotice(null);
    try {
      const result = await nanfuSelfJoin(controller.signal);
      if (!current(generation)) return;
      if (result.userId !== userId) throw new Error("账号已切换，请重新登录");
      setNotice("已加入默认组织，可开始使用环境。");
      await load(generation, controller.signal, userId);
    } catch (failure) {
      if (!current(generation)) return;
      if (failure instanceof NanfuApiError && failure.status === 401) setAccount({ authenticated: false });
      setError(failure instanceof Error ? failure.message : "加入默认组织失败，可稍后重试");
    } finally { if (current(generation)) setBusy(false); }
  };
  const saveLoginName = async () => {
    const name = loginDraft.trim().toLowerCase();
    if (!name || busy) return;
    const { generation, controller } = begin(false);
    setNotice(null);
    try {
      const result = await setNanfuLoginName(name, controller.signal);
      if (!current(generation)) return;
      setLoginNameState(result.name);
      setLoginDraft(result.name);
      setNotice(`用户名已改为 ${result.name}，下次可用它登录。`);
    } catch (failure) {
      if (!current(generation)) return;
      if (failure instanceof NanfuApiError && failure.status === 401) setAccount({ authenticated: false });
      setError(failure instanceof Error ? failure.message : "用户名保存失败，请稍后重试");
    } finally { if (current(generation)) setBusy(false); }
  };
  const dropLoginName = async () => {
    if (busy) return;
    const { generation, controller } = begin(false);
    setNotice(null);
    try {
      await clearNanfuLoginName(controller.signal);
      if (!current(generation)) return;
      setLoginNameState(null);
      setLoginDraft("");
      setNotice("已改回用注册邮箱登录。");
    } catch (failure) {
      if (!current(generation)) return;
      if (failure instanceof NanfuApiError && failure.status === 401) setAccount({ authenticated: false });
      setError(failure instanceof Error ? failure.message : "用户名清除失败，请稍后重试");
    } finally { if (current(generation)) setBusy(false); }
  };
  const changePassword = async () => {
    if (busy) return;
    if (nextPassword.length < NANFU_MIN_PASSWORD_LENGTH) { setError(`新密码至少 ${NANFU_MIN_PASSWORD_LENGTH} 位`); return; }
    if (nextPassword !== confirmPassword) { setError("两次输入的新密码不一致"); return; }
    const { generation, controller } = begin(false);
    setNotice(null);
    try {
      const result = await changeNanfuPassword(currentPassword, nextPassword, controller.signal);
      if (!current(generation)) return;
      if (result.state) setAccount(result.state);
      setNotice("密码已修改，下次登录请使用新密码。");
    } catch (failure) {
      if (!current(generation)) return;
      if (failure instanceof NanfuApiError && failure.status === 401) setAccount({ authenticated: false });
      setError(failure instanceof Error ? failure.message : "密码修改失败，请稍后重试");
    } finally {
      if (current(generation)) { setCurrentPassword(""); setNextPassword(""); setConfirmPassword(""); setBusy(false); }
    }
  };
  const mutate = async <K extends keyof NanfuMutations,>(action: K, input: NanfuMutations[K]["input"]): Promise<void> => {
    if (!account.userId || busy) return;
    const userId = account.userId;
    const { generation, controller } = begin(false);
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
  const atOwnQuotaLimit = !!organization && organization.quota > 0 && organization.used >= organization.quota;
  const filtered = useMemo(() => environments.filter(item =>
    (!ownedOnly || item.ownerUserId === account.userId) && (group === "all" || item.groupId === group) &&
    [item.id, item.ownerUserId, item.groupId ?? ""].some(value => value.toLowerCase().includes(query.trim().toLowerCase()))
  ), [environments, ownedOnly, account.userId, group, query]);

  return <section className="workspace nanfu-account-page" hidden={!active} aria-label="南孚账号与组织">
    <div className="settingspage">
      <h2 className="sect-title">南孚账号与组织</h2>
      <p>南孚自有账号，与上游 AliasMode Cloud 独立。登录南孚账号后才能新建、启动或导入环境；本机环境不会自动上传，也不会被静默删除。</p>
      {localCount !== null && <button className="btn" type="button" onClick={onLocal}>查看本机环境（{localCount}）</button>}
      <section className="settings-card"><header><h3>南孚账号</h3></header><div className="card-body">
        {busy && <p role="status">正在处理南孚账号或读取组织列表…</p>}
        {persistent === false && <p>当前为会话内登录；无原生凭据库，关闭服务后需重新登录，不保存明文令牌。</p>}
        {persistent === true && <p>刷新令牌仅保存在系统凭据库，重启后恢复；密码不保存。</p>}
        {notice && <p role="status">{notice}</p>}
        {error && <p className="modal-err" role="alert">{error}</p>}
        {retry && <button className="btn" disabled={busy} onClick={() => void authenticate(retry)}>{retry === "restore" ? "重试恢复登录" : "重试退出账号"}</button>}
        {account.authenticated ? <>
          <p data-testid="nanfu-identity">已登录：{account.email ? nanfuLoginName(account.email) : account.userId}</p>
          <button className="btn danger" onClick={() => void authenticate("signout")}>退出南孚账号 / 切换账号</button>
        </> : <form className="nanfu-auth-form" onSubmit={event => { event.preventDefault(); void authenticate("signin"); }}>
          <label className="fld"><span>登录名或邮箱</span><input type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} required value={email} onChange={event => setEmail(event.target.value)} placeholder="姓名拼音或缩写，如 zhangsan；也可填完整邮箱" disabled={busy} /></label>
          <label className="fld"><span>密码</span><input type="password" autoComplete="current-password" minLength={6} required value={password} onChange={event => setPassword(event.target.value)} disabled={busy} /></label>
          <label className="fld"><span>邀请码（选填）</span><input maxLength={128} autoComplete="off" value={signInInvite} onChange={event => setSignInInvite(event.target.value)} disabled={busy} placeholder="填写管理员给的邀请码，登录时直接加入该组织" /></label>
          <button className="btn primary" type="submit" disabled={busy}>登录南孚账号</button>
          <p className="nanfu-hint">账号由组织管理员创建：用管理员给的登录名（拼音或缩写）直接登录，不需要邮箱。没有账号或忘记密码，请联系管理员。</p>
        </form>}
      </div></section>
      {account.authenticated && <section className="settings-card" data-testid="nanfu-login-name-card"><header><h3>登录用户名</h3></header><div className="card-body">
        {loginManaged ? <p>本账号由管理员创建，登录名由管理员分配，不能自己修改。如需更改请联系组织管理员。</p> : <>
          <p>{loginName ? <>当前用户名：<b data-testid="nanfu-login-name-value">{loginName}</b>；也可以用注册邮箱登录。</> : "当前用注册邮箱登录；设置用户名后，可只输入用户名登录。"}</p>
          <form className="nanfu-form" aria-label="设置用户名" onSubmit={event => { event.preventDefault(); void saveLoginName(); }}>
            <label className="fld"><span>用户名</span><input value={loginDraft} onChange={event => setLoginDraft(event.target.value)} placeholder="2 至 63 位字母、数字、点、下划线和横线，如 zhangsan" autoCapitalize="none" autoComplete="off" spellCheck={false} maxLength={63} disabled={busy} /></label>
            <button className="btn primary" type="submit" disabled={busy || !loginDraft.trim() || loginDraft.trim().toLowerCase() === loginName}>保存用户名</button>
            {loginName && <button className="btn" type="button" disabled={busy} onClick={() => void dropLoginName()}>改回用邮箱登录</button>}
          </form>
          <p className="nanfu-hint">用户名只用于登录，不改变组织里的显示名称；管理员创建的员工账号沿用管理员分配的登录名。</p>
        </>}
      </div></section>}
      {account.authenticated && <section className="settings-card" data-testid="nanfu-password-card"><header><h3>修改密码</h3></header><div className="card-body">
        <form className="nanfu-form" aria-label="修改登录密码" onSubmit={event => { event.preventDefault(); void changePassword(); }}>
          <label className="fld"><span>当前密码</span><input type="password" autoComplete="current-password" required value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} disabled={busy} /></label>
          <label className="fld"><span>新密码</span><input type="password" autoComplete="new-password" minLength={NANFU_MIN_PASSWORD_LENGTH} maxLength={72} required value={nextPassword} onChange={event => setNextPassword(event.target.value)} disabled={busy} /></label>
          <label className="fld"><span>再输一次新密码</span><input type="password" autoComplete="new-password" minLength={NANFU_MIN_PASSWORD_LENGTH} maxLength={72} required value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} disabled={busy} /></label>
          <button className="btn primary" type="submit" disabled={busy || !currentPassword || nextPassword.length < NANFU_MIN_PASSWORD_LENGTH || nextPassword !== confirmPassword}>保存新密码</button>
        </form>
        <p className="nanfu-hint">忘记密码不能自助找回：请联系组织管理员在「员工管理」里重置；所有者账号由平台方重置。</p>
      </div></section>}
      {account.authenticated && <section className="settings-card"><header><h3>当前组织与可见环境</h3></header><div className="card-body">
        <button className="btn" disabled={busy} onClick={() => void refresh()}>刷新组织列表</button>
        {!busy && organizationLoaded && !organization && <>
          <p>当前账号尚未加入组织；加入默认组织即可开始使用，或创建自己的组织。</p>
          <button className="btn primary" data-testid="nanfu-self-join" disabled={busy} onClick={() => void join()}>加入默认组织</button>
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
          <p className={atOwnQuotaLimit ? "modal-err" : ""} data-testid="nanfu-member-quota">本人配额：{organization.used} / {organization.quota === 0 ? "不限" : organization.quota}</p>
          {atOwnQuotaLimit && <p className="modal-err" role="alert">窗口额度已用满，新建或接收组织云端环境会被服务端拒绝；请删除不再使用的环境，或联系管理员调整额度。本机窗口不计入组织额度。</p>}
          {organization.locked || organization.status !== "active" ? <p role="alert">账号{organization.locked ? "已锁定" : "未锁定"} / {organization.status === "active" ? "启用" : "已停用"}，不能访问组织环境。请联系管理员。</p> : <>
            <p>仅显示服务端授权可见的元数据；未下载到本机的组织条目不可启动。要把整个环境连同登录态搬到另一台电脑，请到「环境转移」。</p>
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
    </div>
  </section>;
}
