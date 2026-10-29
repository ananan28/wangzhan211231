import { useEffect, useRef, useState } from "react";
import {
  fetchNanfuEnvironments, fetchNanfuOverview, nanfuOrganizationAction, NanfuApiError,
  type NanfuOrganization, type NanfuOrgOverview, type NanfuMutations,
} from "./api.ts";
import { NanfuManagement, nanfuIdentityName } from "./nanfu-management.tsx";

/**
 * 员工管理单独成页：成员、角色权限、分组授权与邀请子账号。
 * 之前这些卡片和账号、环境转移堆在同一个设置页里，管理员找不到添加员工的入口。
 */
export function NanfuStaffPage({ active }: { active: boolean }) {
  const [userId, setUserId] = useState("");
  const [organization, setOrganization] = useState<NanfuOrganization | null>(null);
  const [overview, setOverview] = useState<NanfuOrgOverview | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const generation = useRef(0);

  const load = async () => {
    const token = ++generation.current;
    setBusy(true);
    setError(null);
    try {
      const result = await fetchNanfuEnvironments();
      if (token !== generation.current) return;
      setUserId(result.userId);
      setOrganization(result.organization);
      const org = result.organization;
      if (org && !org.locked && org.status === "active" && ["owner", "admin"].includes(org.identity)) {
        const detail = await fetchNanfuOverview();
        if (token !== generation.current) return;
        setOverview(detail.result);
      } else {
        setOverview(null);
      }
    } catch (failure) {
      if (token !== generation.current) return;
      setError(failure instanceof Error ? failure.message : "成员列表暂时不可用，请重试");
    } finally {
      if (token === generation.current) {
        setBusy(false);
        setLoaded(true);
      }
    }
  };

  const mutate = async <K extends keyof NanfuMutations,>(action: K, input: NanfuMutations[K]["input"]): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const response = await nanfuOrganizationAction(action, input);
      const result = response.result;
      setNotice("code" in result ? `邀请码已生成：${result.code}（单次使用，请复制发给对方）`
        : "reclaimed" in result ? `成员已移除，已回收 ${result.reclaimed} 个组织环境。`
        : "操作已成功，成员列表已刷新。");
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "操作失败，请刷新后重试");
      if (failure instanceof NanfuApiError && failure.status === 401) setOrganization(null);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!active) return;
    void load();
    return () => { generation.current++; };
  }, [active]);

  const canManage = !!organization && ["owner", "admin"].includes(organization.identity)
    && !organization.locked && organization.status === "active";

  return (
    <section className="workspace nanfu-staff-page" hidden={!active} aria-label="员工管理">
      <div className="settingspage">
        <h2 className="sect-title">员工管理</h2>
        <p>在这里添加员工、添加管理账号、分配角色与窗口配额。成员列表和邀请码都由南孚服务端核验权限。</p>
        {busy && <p role="status">正在读取组织成员…</p>}
        {notice && <p role="status">{notice}</p>}
        {error && <p className="modal-err" role="alert">{error}</p>}
        {loaded && !organization && !error && (
          <p className="modal-err" role="alert">当前账号还没有加入组织，无法管理员工。请先到「南孚账号与组织」加入或创建组织。</p>
        )}
        {organization && !canManage && (
          <p className="modal-err" role="alert">
            只有组织所有者或管理员可以管理员工；当前身份：{nanfuIdentityName(organization.identity)}。
          </p>
        )}
        {organization && canManage && (
          <section className="settings-card">
            <header><h3>添加员工与管理员</h3></header>
            <div className="card-body">
              <ol className="steps">
                <li>在下方「邀请子账号」选好身份，点「生成邀请码」。</li>
                <li><b>添加员工</b>：身份选「成员」或「经理」，把邀请码发给对方。</li>
                <li><b>添加管理账号</b>：身份选「管理员」，对方用该邀请码加入后即可管理员工和强制转移环境。</li>
                <li>对方注册并确认邮箱后，在登录页填邀请码即可加入本组织；邀请码单次使用。</li>
              </ol>
            </div>
          </section>
        )}
        {organization && overview && canManage && (
          <NanfuManagement
            organization={organization}
            overview={overview}
            currentUserId={userId}
            busy={busy}
            onMutate={mutate}
            onRefresh={() => void load()}
          />
        )}
        {organization && canManage && !overview && !busy && !error && (
          <p className="modal-err" role="alert">读取不到成员列表。请确认账号仍是组织所有者或管理员，然后刷新。</p>
        )}
      </div>
    </section>
  );
}
