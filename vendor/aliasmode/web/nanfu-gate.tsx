import { type ReactNode, useCallback, useEffect, useState } from "react";
import { fetchNanfuState, nanfuAuthAction, nanfuSelfJoin, NanfuApiError, type NanfuAccountState } from "./api.ts";

/**
 * Mandatory sign-in for the 南孚 build. The workspace stays local, while the
 * account, quota and transfer features talk to the 南孚 service; nothing renders
 * before the account is signed in, so no one runs the browser anonymously.
 */
export function NanfuGate({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<NanfuAccountState | null>(null);
  const [busy, setBusy] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [invite, setInvite] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const result = await fetchNanfuState();
    setAccount(result.state);
    return result.state;
  }, []);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 账号服务偶发超时时要多试几次：一次读不到状态就把已登录用户丢回登录框，
    // 用户再输密码只会撞上“请先退出当前南孚账号”。
    const probe = async (attempt: number): Promise<void> => {
      try {
        await refresh();
      } catch {
        if (active && attempt < 4) {
          timer = setTimeout(() => void probe(attempt + 1), 1500 * (attempt + 1));
          return;
        }
      }
      if (active) setBusy(false);
    };
    void probe(0);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [refresh]);

  const signIn = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await nanfuAuthAction("signin", {
        email: email.trim(),
        password,
        ...(invite.trim() ? { invite: invite.trim() } : {}),
      });
      const state = result.state ?? (await refresh());
      setAccount(state);
      setPassword("");
      if (!state.authenticated) {
        setError("登录未完成，请检查邮箱和密码。");
        return;
      }
      if (result.selfJoin?.ok === false) setNotice(result.selfJoin.error ?? "还未加入组织，请联系管理员获取邀请码。");
      else if (result.selfJoin?.orgId) setNotice("已加入组织。");
      else await nanfuSelfJoin().catch(() => undefined);
    } catch (failure) {
      if (failure instanceof NanfuApiError && (failure.status === 409 || /退出当前南孚账号/.test(failure.message))) {
        // 本机已有有效会话：直接进工作区，绝不把它当成密码错误。
        try {
          const state = await refresh();
          if (state.authenticated) {
            setPassword("");
            return;
          }
        } catch {
          // 刷新失败时保留服务端给出的提示。
        }
      }
      setError(
        failure instanceof NanfuApiError
          ? failure.message
          : failure instanceof Error
            ? failure.message
            : "南孚服务暂时不可用，请重试。",
      );
    } finally {
      setBusy(false);
    }
  };

  if (busy && !account) {
    return (
      <main className="onboarding">
        <section className="onboarding-card" aria-busy="true">
          <div className="onboarding-brand">南孚浏览器</div>
          <h1>正在连接南孚账号…</h1>
        </section>
      </main>
    );
  }

  if (!account?.authenticated) {
    return (
      <main className="onboarding">
        <section className="onboarding-card" aria-labelledby="nanfu-gate-title">
          <div className="onboarding-brand">南孚浏览器</div>
          <h1 id="nanfu-gate-title">登录南孚账号</h1>
          <p>账号由管理员分配。没有账号或忘记密码，请联系管理员。</p>
          <form
            className="auth-form"
            onSubmit={(event) => {
              event.preventDefault();
              void signIn();
            }}
          >
            <label>
              邮箱
              <input
                type="email"
                autoComplete="email"
                required
                value={email}
                disabled={busy}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <label>
              密码
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                disabled={busy}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <label>
              邀请码（首次加入组织时填写）
              <input
                type="text"
                autoComplete="off"
                value={invite}
                disabled={busy}
                onChange={(event) => setInvite(event.target.value)}
              />
            </label>
            {error && <div className="mode-error" role="alert">{error}</div>}
            {notice && <div className="auth-notice" role="status">{notice}</div>}
            <button className="mode-primary" type="submit" disabled={busy}>
              {busy ? "登录中…" : "登录"}
            </button>
          </form>
        </section>
      </main>
    );
  }

  return <>{children}</>;
}
