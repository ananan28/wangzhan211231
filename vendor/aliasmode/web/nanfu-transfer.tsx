import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchNanfuTransferInbox,
  fetchProfiles,
  nanfuAcceptCloudEnvironment,
  nanfuBatchEnvironmentTransfer,
  nanfuExportEnvironment,
  nanfuForceEnvironmentTransfer,
  nanfuImportEnvironmentText,
  nanfuRequestEnvironmentTransfer,
  nanfuRespondEnvironmentTransfer,
  nanfuRevokeCloudEnvironment,
  nanfuSendCloudEnvironment,
  type NanfuCloudTransferRow,
  type NanfuTransferInbox,
  type NanfuTransferMember,
  type NanfuTransferRow,
  type UiProfile,
} from "./api.ts";

const statusNames: Record<string, string> = {
  pending: "待处理", accepted: "已接受", rejected: "已拒绝", revoked: "已撤回", forced: "已强制转移",
};
const statusName = (status: string) => statusNames[status] ?? status;
const memberLabel = (members: NanfuTransferMember[], userId: string) => {
  const member = members.find((item) => item.userId === userId);
  return member?.email || userId;
};
const errorText = (failure: unknown) =>
  failure instanceof Error && failure.message ? failure.message : "转移操作失败，请重试";
const timeText = (value: string) => {
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toLocaleString("zh-CN", { hour12: false }) : value;
};
const packageStatus = (row: NanfuCloudTransferRow) => {
  if (row.status !== "pending") return statusName(row.status);
  return Date.parse(row.expiresAt) <= Date.now() ? "已过期" : "待接受";
};

export function NanfuTransferPage({ active }: { active: boolean }) {
  const [data, setData] = useState<NanfuTransferInbox | null>(null);
  const [profiles, setProfiles] = useState<UiProfile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cloudEnvironmentId, setCloudEnvironmentId] = useState("");
  const [cloudRecipientId, setCloudRecipientId] = useState("");
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [environmentId, setEnvironmentId] = useState("");
  const [recipientId, setRecipientId] = useState("");
  const [note, setNote] = useState("");
  const [batchIds, setBatchIds] = useState<string[]>([]);
  const [forceId, setForceId] = useState("");
  const [confirm, setConfirm] = useState<"batch" | "force" | null>(null);
  const [exportId, setExportId] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const request = useRef({ generation: 0, controller: new AbortController() });

  const load = async (signal: AbortSignal) => {
    const result = await fetchNanfuTransferInbox(signal);
    const roster = await fetchProfiles().catch(() => null);
    if (signal.aborted) return;
    setData(result);
    if (roster) setProfiles(roster.profiles);
  };

  const begin = () => {
    request.current.controller.abort();
    const next = { generation: request.current.generation + 1, controller: new AbortController() };
    request.current = next;
    setBusy(true);
    setError(null);
    return next;
  };

  const refresh = async () => {
    const next = begin();
    setNotice(null);
    setConfirm(null);
    try { await load(next.controller.signal); }
    catch (failure) { if (!next.controller.signal.aborted) setError(errorText(failure)); }
    finally { if (request.current.generation === next.generation) setBusy(false); }
  };

  const run = async (task: (signal: AbortSignal) => Promise<string>) => {
    const next = begin();
    setNotice(null);
    setConfirm(null);
    try {
      const done = await task(next.controller.signal);
      if (next.controller.signal.aborted) return;
      setNotice(done);
      await load(next.controller.signal);
    } catch (failure) {
      if (!next.controller.signal.aborted) setError(errorText(failure));
    } finally {
      if (request.current.generation === next.generation) setBusy(false);
    }
  };

  useEffect(() => {
    if (!active) return;
    void refresh();
    return () => { request.current.generation++; request.current.controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const userId = data?.userId ?? "";
  const organization = data?.organization ?? null;
  const members = data?.members ?? [];
  const visible = data?.visibleEnvironments ?? [];
  const mine = useMemo(() => visible.filter((item) => item.ownerUserId === userId), [visible, userId]);
  const recipients = useMemo(() => members.filter((member) => member.userId !== userId), [members, userId]);
  const isAdmin = organization?.identity === "owner" || organization?.identity === "admin";
  const localNames = useMemo(() => new Map(profiles.map((profile) => [profile.id, profile.name])), [profiles]);
  const localById = useMemo(() => new Map(profiles.map((profile) => [profile.id, profile])), [profiles]);
  const exportable = useMemo(() => profiles.filter((profile) => profile.engine !== "firefox"), [profiles]);
  // Only an environment that is both owned here and present on this machine can
  // be sealed and sent; a metadata-only row has no files to move.
  const sendable = useMemo(() => mine.filter((item) => localById.has(item.id)), [mine, localById]);
  const locked = !organization || organization.locked || organization.status !== "active";
  const pending = (data?.inbox ?? []).filter((row) => row.status === "pending");
  const resolved = (data?.inbox ?? []).filter((row) => row.status !== "pending");
  const sent = data?.sent ?? [];
  const packages = data?.packages;
  const incomingPackages = packages?.inbox ?? [];
  const sentPackages = packages?.sent ?? [];

  const sendToCloud = () => {
    if (!cloudEnvironmentId || !cloudRecipientId) return;
    void run(async (signal) => {
      const result = await nanfuSendCloudEnvironment({ environmentId: cloudEnvironmentId, toUserId: cloudRecipientId }, signal);
      setCloudEnvironmentId("");
      const parts = [
        result.hasLoginState ? `登录态已打包（${result.cookies} 个 Cookie、${result.origins} 个站点存储）` : "该环境还没有保存登录态，对方打开后需自行登录",
        result.extensions ? `${result.extensions} 个扩展` : "",
      ].filter(Boolean);
      return `已发送到 ${result.recipientEmail} 的云端收件箱：${parts.join("，")}。对方在「环境转移」页点“接受并导入”，打开就是已登录状态。`;
    });
  };

  const acceptFromCloud = (row: NanfuCloudTransferRow) => {
    setAcceptingId(row.id);
    void run(async (signal) => {
      const result = await nanfuAcceptCloudEnvironment(row.id, signal);
      return `已导入“${result.name}”${result.renamed ? "（与本机重名，已自动改名，未覆盖原有环境）" : ""}，`
        + `${result.hasLoginState ? `登录态一并恢复（${result.cookies} 个 Cookie、${result.origins} 个站点存储）` : "但发送方未包含登录态，请自行登录网站"}，直接启动即可。`;
    }).finally(() => setAcceptingId(null));
  };

  const revokeCloud = (row: NanfuCloudTransferRow) => {
    setRevokingId(row.id);
    void run(async (signal) => {
      await nanfuRevokeCloudEnvironment(row.id, signal);
      return `已撤回发给 ${row.recipientEmail || "对方"} 的“${row.environmentName || row.environmentId}”，对方不能再接受。`;
    }).finally(() => setRevokingId(null));
  };

  const submitRequest = () => {
    if (!environmentId || !recipientId) return;
    void run(async (signal) => {
      await nanfuRequestEnvironmentTransfer({ environmentId, toUserId: recipientId }, signal);
      setEnvironmentId("");
      setNote("");
      return "转移请求已发出；对方在“收件箱”接受后生效。";
    });
  };

  const runBatch = () => {
    if (!batchIds.length || !recipientId) return;
    void run(async (signal) => {
      const result = await nanfuBatchEnvironmentTransfer({ environmentIds: batchIds, toUserId: recipientId, note }, signal);
      setBatchIds([]);
      setNote("");
      return `已批量转移 ${result.moved} 个环境，列表已刷新。`;
    });
  };

  const runForce = () => {
    if (!forceId || !recipientId) return;
    void run(async (signal) => {
      const result = await nanfuForceEnvironmentTransfer({ environmentId: forceId, toUserId: recipientId, note }, signal);
      setForceId("");
      setNote("");
      return `已强制转移 ${result.moved} 个环境，列表已刷新。`;
    });
  };

  const respond = (row: NanfuTransferRow, accept: boolean) => {
    setPendingId(row.id);
    void run(async (signal) => {
      await nanfuRespondEnvironmentTransfer({ transferId: row.id, accept }, signal);
      return accept ? "已接受转移，环境已转到你的账号。" : "已拒绝该转移。";
    }).finally(() => setPendingId(null));
  };

  const exportEnvironment = (id: string) => {
    void run(async (signal) => {
      const result = await nanfuExportEnvironment(id, signal);
      const blob = new Blob([JSON.stringify(result.package, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.fileName;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      return `已导出 ${result.fileName}；包内不含登录态，导入后需重新登录网站。`;
    });
  };

  const importPackage = async (file: File) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const text = await file.text();
      const result = await nanfuImportEnvironmentText(text);
      await refresh();
      setNotice(`已导入环境“${result.name}”${result.renamed ? "（与本机重名，已自动改名，未覆盖原有环境）" : ""}。登录态未包含，请重新登录网站。`);
    } catch (failure) {
      setError(errorText(failure));
      setBusy(false);
    }
  };

  const toggleBatch = (id: string, checked: boolean) => {
    setBatchIds((current) => checked ? [...new Set([...current, id])] : current.filter((item) => item !== id));
  };

  return <section className="workspace nanfu-transfer-page" hidden={!active} aria-label="环境转移">
    <div className="settingspage">
      <h2 className="sect-title">环境转移</h2>
      <p>把整个环境搬到云端：指纹、代理、扩展文件和登录态一起加密上传，只有接收人能解开。对方点“接受并导入”后直接启动，网站已是登录状态，不需要导出文件。</p>
      {busy && <p role="status">正在处理转移或读取列表…</p>}
      {notice && <p role="status">{notice}</p>}
      {error && <p className="modal-err" role="alert">{error}</p>}
      <button className="btn" type="button" disabled={busy} onClick={() => void refresh()}>刷新转移列表</button>
      {!data && !error && !busy && <p>尚未读取到组织信息，请先登录南孚账号。</p>}
      {data && !organization && <p>当前账号尚未加入组织；加入组织后才能转移环境。</p>}
      {data && organization && locked && <p role="alert">账号在组织中已锁定或停用，暂不能转移环境。</p>}

      {data && organization && !locked && <>
        <section className="settings-card" aria-label="云端转移"><header><h3>云端转移（含登录态）</h3></header><div className="card-body">
          {!sendable.length ? <p>你在本机没有可转移的环境。只有同时属于你本人、且已下载到本机的 Chromium 环境可以云端转移。</p> : <>
            <fieldset disabled={busy} className="nanfu-form">
              <label className="fld"><span>选择本机环境</span><select value={cloudEnvironmentId} onChange={(event) => setCloudEnvironmentId(event.target.value)}>
                <option value="">请选择要转移的环境</option>
                {sendable.map((item) => <option key={item.id} value={item.id}>{localNames.get(item.id) ?? item.id} · {item.id}</option>)}
              </select></label>
              <label className="fld"><span>接收成员</span><select value={cloudRecipientId} onChange={(event) => setCloudRecipientId(event.target.value)}>
                <option value="">请选择接收成员</option>
                {recipients.map((member) => <option key={member.userId} value={member.userId}>{member.email || member.userId}</option>)}
              </select></label>
              <button className="btn primary" type="button" disabled={!cloudEnvironmentId || !cloudRecipientId} onClick={sendToCloud}>发送到对方云端</button>
              <p>发送前会自动保存当前登录态（环境正在运行时直接抓取，不用先关闭窗口）。对方不需要你给任何密码或文件，接受后即可使用。</p>
            </fieldset>
          </>}
        </div></section>

        <section className="settings-card" aria-label="云端收件箱"><header><h3>待接收（云端）</h3></header><div className="card-body">
          {packages && !packages.keyPublished && <p className="modal-err" role="alert">本机转移密钥尚未上传到南孚服务，别人暂时无法向你发送；请检查网络后点“刷新转移列表”。</p>}
          {packages?.error && <p role="alert">{packages.error}</p>}
          {!incomingPackages.length ? <p>暂无可接收的云端转移。</p> : <div className="nanfu-table-wrap"><table className="nanfu-table">
            <thead><tr><th>环境</th><th>发送人</th><th>发送时间</th><th>有效期至</th><th>操作</th></tr></thead>
            <tbody>{incomingPackages.map((row) => <tr key={row.id}>
              <td>{row.environmentName || localNames.get(row.environmentId) || row.environmentId}<br /><small>{row.environmentId}</small></td>
              <td>{row.senderEmail || "同组织成员"}</td>
              <td>{timeText(row.createdAt)}</td>
              <td>{packageStatus(row) === "已过期" ? <span className="modal-err">已过期</span> : timeText(row.expiresAt)}</td>
              <td><button className="btn primary" type="button" disabled={busy || acceptingId === row.id || packageStatus(row) === "已过期"} onClick={() => acceptFromCloud(row)}>
                {acceptingId === row.id ? "正在导入…" : "接受并导入"}
              </button></td>
            </tr>)}</tbody></table></div>}
          <p>接受后会在本机新增一个环境，并与现有环境重名时自动改名；不会覆盖任何已有环境。</p>
        </div></section>

        <section className="settings-card" aria-label="我发出的云端转移"><header><h3>我发出的云端转移</h3></header><div className="card-body">
          {!sentPackages.length ? <p>还没有发出过云端转移。</p> : <div className="nanfu-table-wrap"><table className="nanfu-table">
            <thead><tr><th>环境</th><th>接收人</th><th>状态</th><th>发送时间</th><th>操作</th></tr></thead>
            <tbody>{sentPackages.map((row) => <tr key={row.id}>
              <td>{row.environmentName || row.environmentId}<br /><small>{row.environmentId}</small></td>
              <td>{row.recipientEmail}</td>
              <td className={packageStatus(row) === "已过期" ? "modal-err" : ""}>{packageStatus(row)}</td>
              <td>{timeText(row.createdAt)}</td>
              <td>{row.status === "pending" && <button className="btn" type="button" disabled={busy || revokingId === row.id} onClick={() => revokeCloud(row)}>
                {revokingId === row.id ? "正在撤回…" : "撤回"}
              </button>}</td>
            </tr>)}</tbody></table></div>}
        </div></section>

        <details className="settings-card nanfu-advanced">
          <summary>组织内归属调整（只改归属，不搬数据）</summary>
          <div className="card-body">
            <p>这里的操作只改变环境在组织里的归属，不会把本机文件或登录态送到对方电脑。需要把整个环境搬过去时，请用上面的“云端转移”。</p>
            <section aria-label="发起转移"><header><h4>发起归属转移</h4></header>
              {!mine.length ? <p>你在当前组织中没有可转移的环境。</p> : <fieldset disabled={busy} className="nanfu-form">
                <label className="fld"><span>选择环境</span><select value={environmentId} onChange={(event) => setEnvironmentId(event.target.value)}>
                  <option value="">请选择你拥有的环境</option>
                  {mine.map((item) => <option key={item.id} value={item.id}>{localNames.get(item.id) ? `${localNames.get(item.id)} · ` : ""}{item.id}</option>)}
                </select></label>
                <label className="fld"><span>接收成员</span><select value={recipientId} onChange={(event) => setRecipientId(event.target.value)}>
                  <option value="">请选择接收成员</option>
                  {recipients.map((member) => <option key={member.userId} value={member.userId}>{member.email || member.userId}</option>)}
                </select></label>
                <label className="fld"><span>备注（可选，最多500字）</span><input maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} /></label>
                <button className="btn" type="button" disabled={!environmentId || !recipientId} onClick={submitRequest}>发送归属转移请求</button>
                <p>对方接受后生效；对方拒绝或过期则保持不变。</p>
              </fieldset>}
            </section>

            {isAdmin && <section aria-label="管理员批量与强制转移"><header><h4>管理员：批量 / 强制转移</h4></header>
              {!visible.length ? <p>组织中暂无可管理的环境。</p> : <fieldset disabled={busy} className="nanfu-form">
                <p>批量与强制转移立即生效并逐条记录审计，无需对方接受，请确认接收人无误。</p>
                <label className="fld"><span>接收成员</span><select value={recipientId} onChange={(event) => setRecipientId(event.target.value)}>
                  <option value="">请选择接收成员</option>
                  {recipients.map((member) => <option key={member.userId} value={member.userId}>{member.email || member.userId}</option>)}
                </select></label>
                <label className="fld"><span>备注（可选，最多500字）</span><input maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} /></label>
                <fieldset className="nanfu-env-picks"><legend>批量选择环境（{batchIds.length} 个）</legend>
                  {visible.map((item) => <label key={item.id}>
                    <input type="checkbox" checked={batchIds.includes(item.id)} onChange={(event) => toggleBatch(item.id, event.target.checked)} />
                    {localNames.get(item.id) ? `${localNames.get(item.id)} · ` : ""}{item.id}{item.ownerUserId === userId ? "（本人）" : `（${item.ownerUserId}）`}
                  </label>)}
                </fieldset>
                {confirm === "batch" ? <div role="alertdialog" aria-label="确认批量转移">
                  <p>确认将 {batchIds.length} 个环境立即转移给 {memberLabel(members, recipientId)}？该操作立即生效，无法撤回。</p>
                  <button className="btn danger" type="button" onClick={runBatch}>确认批量转移</button>
                  <button className="btn" type="button" onClick={() => setConfirm(null)}>取消</button>
                </div> : <button className="btn danger" type="button" disabled={!batchIds.length || !recipientId} onClick={() => setConfirm("batch")}>批量转移所选环境</button>}

                <label className="fld"><span>强制转移单个环境</span><select value={forceId} onChange={(event) => setForceId(event.target.value)}>
                  <option value="">请选择环境</option>
                  {visible.map((item) => <option key={item.id} value={item.id}>{localNames.get(item.id) ? `${localNames.get(item.id)} · ` : ""}{item.id}</option>)}
                </select></label>
                {confirm === "force" ? <div role="alertdialog" aria-label="确认强制转移">
                  <p>确认将环境 {forceId} 立即转移给 {memberLabel(members, recipientId)}？原所有者不会收到请求，操作立即生效并记录审计。</p>
                  <button className="btn danger" type="button" onClick={runForce}>确认强制转移</button>
                  <button className="btn" type="button" onClick={() => setConfirm(null)}>取消</button>
                </div> : <button className="btn danger" type="button" disabled={!forceId || !recipientId} onClick={() => setConfirm("force")}>强制转移该环境</button>}
              </fieldset>}
            </section>}

            <section aria-label="收件箱"><header><h4>归属转移收件箱</h4></header>
              {!pending.length ? <p>没有待处理的归属转移请求。</p> : <div className="nanfu-table-wrap"><table className="nanfu-table">
                <thead><tr><th>环境</th><th>发起人</th><th>备注</th><th>发起时间</th><th>处理</th></tr></thead>
                <tbody>{pending.map((row) => <tr key={row.id}>
                  <td>{localNames.get(row.environmentId) ? `${localNames.get(row.environmentId)} · ` : ""}{row.environmentId}</td>
                  <td>{row.fromEmail || row.fromUserId}</td>
                  <td>{row.note || "无"}</td>
                  <td>{timeText(row.createdAt)}</td>
                  <td><button className="btn primary" type="button" disabled={busy || pendingId === row.id} onClick={() => respond(row, true)}>接受</button>
                    <button className="btn" type="button" disabled={busy || pendingId === row.id} onClick={() => respond(row, false)}>拒绝</button></td>
                </tr>)}</tbody></table></div>}
              {!!resolved.length && <details><summary>已处理的接收记录（{resolved.length}）</summary>
                <ul>{resolved.map((row) => <li key={row.id}>{row.environmentId} · {statusName(row.status)} · 来自 {row.fromEmail || row.fromUserId} · {row.resolvedAt ?? row.createdAt}</li>)}</ul>
              </details>}
            </section>

            <section aria-label="已发出的转移"><header><h4>已发出的归属转移</h4></header>
              {!sent.length ? <p>尚未发出过归属转移。</p> : <div className="nanfu-table-wrap"><table className="nanfu-table">
                <thead><tr><th>环境</th><th>接收人</th><th>备注</th><th>状态</th><th>时间</th></tr></thead>
                <tbody>{sent.map((row) => <tr key={row.id}>
                  <td>{localNames.get(row.environmentId) ? `${localNames.get(row.environmentId)} · ` : ""}{row.environmentId}</td>
                  <td>{row.toEmail || row.toUserId}</td>
                  <td>{row.note || "无"}</td>
                  <td>{statusName(row.status)}{row.forced ? " · 强制" : ""}</td>
                  <td>{timeText(row.resolvedAt ?? row.createdAt)}</td>
                </tr>)}</tbody></table></div>}
            </section>
          </div>
        </details>

        <details className="settings-card nanfu-advanced">
          <summary>离线备份（.nanfu-env，不含登录态）</summary>
          <div className="card-body">
            <p>只有在对方没有南孚账号、或需要留一份纯配置备份时才用。包内只有指纹配置、代理与扩展文件，不含 Cookie、LocalStorage、密码或令牌，导入后必须重新登录网站。日常转移请用上面的“云端转移”。</p>
            {!exportable.length ? <p>本机暂无可导出的环境。</p> : <fieldset disabled={busy} className="nanfu-form">
              <label className="fld"><span>选择本机环境</span><select value={exportId} onChange={(event) => setExportId(event.target.value)}>
                <option value="">请选择本机环境</option>
                {exportable.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.id}</option>)}
              </select></label>
              <button className="btn" type="button" disabled={!exportId} onClick={() => exportEnvironment(exportId)}>导出为 .nanfu-env</button>
            </fieldset>}
            <fieldset disabled={busy} className="nanfu-form">
              <label className="fld"><span>导入 .nanfu-env 文件</span><input type="file" accept=".nanfu-env,application/json" onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importPackage(file);
                event.target.value = "";
              }} /></label>
              <p>导入会新增一个环境；若与现有环境重名会自动改名，原有环境不会被覆盖。导入后请打开环境重新登录网站。</p>
            </fieldset>
          </div>
        </details>
      </>}
    </div>
  </section>;
}
