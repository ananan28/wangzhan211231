import { useEffect, useState } from "react";
import {
  fetchFingerprintSelfCheck,
  type FingerprintSelfCheckItem,
  type FingerprintSelfCheckReport,
} from "./api.ts";

const GROUPS = [
  { key: "mismatched", title: "不一致", note: "页面读数与档案声明不同，请检查该环境的内核参数或档案设置。" },
  { key: "undetermined", title: "无法判定", note: "档案没有声明或页面没有返回该项，不能算通过。" },
  { key: "passed", title: "通过", note: "页面读数与档案声明一致。" },
] as const;

function SelfCheckRow({ item, showValues }: { item: FingerprintSelfCheckItem; showValues: boolean }) {
  return <li className={`nanfu-selfcheck-row ${item.state}`}>
    <b>{item.label}</b>
    {showValues && <span>页面读到：{item.observed || "（空）"}；档案声明：{item.declared || "（空）"}</span>}
    <small>{item.detail}</small>
  </li>;
}

/**
 * 指纹自检面板：对已启动的环境打开探针页采集，再把读数与档案声明逐项比对。
 * 采集在环境自己的浏览器里完成；这里只展示服务端返回的三类结论。
 */
export function NanfuFingerprintSelfCheck({ profile, onClose }: {
  profile: { id: string; name: string };
  onClose: () => void;
}) {
  const [report, setReport] = useState<FingerprintSelfCheckReport | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setReport(null);
    fetchFingerprintSelfCheck(profile.id, controller.signal).then(
      result => { if (!controller.signal.aborted) setReport(result); },
      (failure: unknown) => {
        if (controller.signal.aborted) return;
        setError(failure instanceof Error ? failure.message : "指纹自检失败，请重试");
      },
    ).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [profile.id]);

  return <div className="modal-backdrop" onClick={onClose}>
    <div
      className="modal nanfu-selfcheck"
      role="dialog"
      aria-modal="true"
      aria-label={`${profile.name} 指纹自检`}
      onClick={event => event.stopPropagation()}
    >
      <div className="modal-head">指纹自检 · {profile.name}</div>
      <div className="modal-body">
        {loading && <p>正在该环境自己的浏览器里采集指纹…</p>}
        {error && <div className="modal-err" role="alert">{error}</div>}
        {report && <>
          <p className="hint">
            探针版本 {report.probe.version || "未知"} · 稳定哈希 {report.probe.hash || "未生成"}
            {report.probe.capturedAt
              ? ` · 采集于 ${new Date(report.probe.capturedAt).toLocaleString("zh-CN", { hour12: false })}`
              : ""}
          </p>
          <p>通过 {report.passed.length} 项 · 不一致 {report.mismatched.length} 项 · 无法判定 {report.undetermined.length} 项</p>
          {GROUPS.map(group => {
            const items = report[group.key];
            return <section key={group.key} className={`nanfu-selfcheck-group ${group.key}`}>
              <h4>{group.title}<span className="nanfu-count">{items.length}</span></h4>
              <p className="nanfu-hint">{group.note}</p>
              {!items.length
                ? <p className="nanfu-hint">无。</p>
                : <ul>{items.map(item => <SelfCheckRow key={item.field} item={item} showValues={group.key !== "passed"} />)}</ul>}
            </section>;
          })}
          {!!report.probe.notes.length && <p className="nanfu-hint">采集备注：{report.probe.notes.join("；")}</p>}
        </>}
      </div>
      <div className="modal-foot">
        <button className="btn" type="button" onClick={onClose}>关闭</button>
      </div>
    </div>
  </div>;
}
