import { useEffect, useRef, useState } from "react";
import {
  fetchNanfuEnvironments, fetchNanfuOverview, nanfuLoginName, nanfuOrganizationAction, NanfuApiError,
  type NanfuOrganization, type NanfuOrgOverview, type NanfuMutations,
} from "./api.ts";
import { NanfuManagement, nanfuIdentityName } from "./nanfu-management.tsx";

/**
 * 员工管理单独成页：所有者 / 管理员 / 成员 / 子账号四层，
 * 加人是「登录名 + 密码 + 角色 + 授权分组」一次提交，不需要邀请码。
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
      if (org && !org.locked && org.status === "active"
        && (["owner", "admin"].includes(org.identity) || org.permissions.includes("member.manage"))) {
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
      setNotice(action === "create-account" && "email" in result
        ? `已添加账号 ${nanfuLoginName(result.email)}：把登录名和密码告诉对方，对方直接登录就能用。`
        : action === "reset-password" ? "密码已重置：旧密码立即失效，请把新密码告诉对方。"
        : action === "set-groups" ? "授权分组已更新。"
        : "code" in result ? `邀请码已生成：${result.code}（单次使用，请复制发给对方）`
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

  const canManage = !!organization
    && (["owner", "admin"].includes(organization.identity) || organization.permissions.includes("member.manage"))
    && !organization.locked && organization.status === "active";

  return (
    <section className="workspace nanfu-staff-page" hidden={!active} aria-label="员工管理">
      <div className="settingspage">
        <h2 className="sect-title">员工管理</h2>
        <p>账号分四层：所有者 → 管理员 → 成员 → 子账号。管理员由所有者添加、可以管理全部成员；拥有「管理成员」权限的成员只能管理自己名下的子账号。子账号用登录名直接登录。每个账号可以单独设置姓名、角色、授权分组和窗口配额，也可以重置密码、停用或移除。</p>
        {busy && <p role="status">正在读取组织成员…</p>}
        {notice && <p role="status">{notice}</p>}
        {error && <p className="modal-err" role="alert">{error}</p>}
        {loaded && !organization && !error && (
          <p className="modal-err" role="alert">当前账号还没有加入组织，无法管理员工。请先到「南孚账号」加入或创建组织。</p>
        )}
        {organization && !canManage && (
          <p className="modal-err" role="alert">
            当前账号的角色没有「管理成员」权限，不能添加或管理员工。当前身份：{nanfuIdentityName(organization.identity)}。如需子账号，请联系组织所有者或管理员。
          </p>
        )}
        {organization && canManage && overview && (
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
          <p className="modal-err" role="alert">读取不到成员列表。请确认账号仍拥有「管理成员」权限，然后刷新。</p>
        )}
      </div>
    </section>
  );
}
