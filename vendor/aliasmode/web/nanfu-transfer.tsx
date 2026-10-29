import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchNanfuTransferInbox,
  fetchProfiles,
  nanfuBatchEnvironmentTransfer,
  nanfuExportEnvironment,
  nanfuForceEnvironmentTransfer,
  nanfuImportEnvironmentText,
  nanfuRequestEnvironmentTransfer,
  nanfuRespondEnvironmentTransfer,
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

export function NanfuTransferPage({ active }: { active: boolean }) {
  const [data, setData] = useState<NanfuTransferInbox | null>(null);
  const [profiles, setProfiles] = useState<UiProfile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
  const exportable = useMemo(() => profiles.filter((profile) => profile.engine !== "firefox"), [profiles]);
  const locked = !organization || organization.locked || organization.status !== "active";
  const pending = (data?.inbox ?? []).filter((row) => row.status === "pending");
  const resolved = (data?.inbox ?? []).filter((row) => row.status !== "pending");
  const sent = data?.sent ?? [];

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

  return <section className="workspace nanfu-transfer-page" hidden={!active} aria-label="环境转移与导入导出">
    <div className="settingspage">
      <h2 className="sect-title">环境转移与导入导出</h2>
      <p>转移只改变组织内的归属，不会移动本机文件。导出包仅含指纹配置、代理配置与扩展目录，<strong>不包含登录态（Cookie、LocalStorage、令牌）</strong>，导入后需在新环境重新登录网站。导入不会覆盖同名环境，重名会自动改名。</p>
      {busy && <p role="status">正在处理转移或读取列表…</p>}
      {notice && <p role="status">{notice}</p>}
      {error && <p className="modal-err" role="alert">{error}</p>}
      <button className="btn" type="button" disabled={busy} onClick={() => void refresh()}>刷新转移列表</button>
      {!data && !error && !busy && <p>尚未读取到组织信息，请先登录南孚账号。</p>}
      {data && !organization && <p>当前账号尚未加入组织；加入组织后才能转移环境。</p>}
      {data && organization && locked && <p role="alert">账号在组织中已锁定或停用，暂不能转移环境。</p>}

      {data && organization && !locked && <>
        <section className="settings-card" aria-label="发起转移"><header><h3>发起转移</h3></header><div className="card-body">
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
            <button className="btn primary" type="button" disabled={!environmentId || !recipientId} onClick={submitRequest}>发送转移请求</button>
            <p>对方接受后生效；对方拒绝或过期则保持不变。</p>
          </fieldset>}
        </div></section>

        {isAdmin && <section className="settings-card" aria-label="管理员批量与强制转移"><header><h3>管理员：批量 / 强制转移</h3></header><div className="card-body">
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
        </div></section>}

        <section className="settings-card" aria-label="收件箱"><header><h3>收件箱（收到的转移）</h3></header><div className="card-body">
          {!pending.length ? <p>没有待处理的转移请求。</p> : <div className="nanfu-table-wrap"><table className="nanfu-table">
            <thead><tr><th>环境</th><th>发起人</th><th>备注</th><th>发起时间</th><th>处理</th></tr></thead>
            <tbody>{pending.map((row) => <tr key={row.id}>
              <td>{localNames.get(row.environmentId) ? `${localNames.get(row.environmentId)} · ` : ""}{row.environmentId}</td>
              <td>{row.fromEmail || row.fromUserId}</td>
              <td>{row.note || "无"}</td>
              <td>{row.createdAt}</td>
              <td><button className="btn primary" type="button" disabled={busy || pendingId === row.id} onClick={() => respond(row, true)}>接受</button>
                <button className="btn" type="button" disabled={busy || pendingId === row.id} onClick={() => respond(row, false)}>拒绝</button></td>
            </tr>)}</tbody></table></div>}
          {!!resolved.length && <details><summary>已处理的接收记录（{resolved.length}）</summary>
            <ul>{resolved.map((row) => <li key={row.id}>{row.environmentId} · {statusName(row.status)} · 来自 {row.fromEmail || row.fromUserId} · {row.resolvedAt ?? row.createdAt}</li>)}</ul>
          </details>}
        </div></section>

        <section className="settings-card" aria-label="已发出的转移"><header><h3>已发出的转移</h3></header><div className="card-body">
          {!sent.length ? <p>尚未发出过转移。</p> : <div className="nanfu-table-wrap"><table className="nanfu-table">
            <thead><tr><th>环境</th><th>接收人</th><th>备注</th><th>状态</th><th>时间</th></tr></thead>
            <tbody>{sent.map((row) => <tr key={row.id}>
              <td>{localNames.get(row.environmentId) ? `${localNames.get(row.environmentId)} · ` : ""}{row.environmentId}</td>
              <td>{row.toEmail || row.toUserId}</td>
              <td>{row.note || "无"}</td>
              <td>{statusName(row.status)}{row.forced ? " · 强制" : ""}</td>
              <td>{row.resolvedAt ?? row.createdAt}</td>
            </tr>)}</tbody></table></div>}
        </div></section>
      </>}

      <section className="settings-card" aria-label="导出与导入环境包"><header><h3>导出 / 导入环境包（.nanfu-env）</h3></header><div className="card-body">
        <p>导出包含：指纹与浏览器配置、代理配置、扩展目录。不包含：Cookie、LocalStorage、IndexedDB、密码与任何令牌。包内使用 SHA-256 校验完整性，仅防损坏，不代表身份签名。导入仅支持 Chromium 环境。</p>
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
      </div></section>
    </div>
  </section>;
}
