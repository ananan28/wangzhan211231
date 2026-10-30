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
  const [showInvite, setShowInvite] = useState(false);
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
      // 登录名原样交给服务端：服务端会把「海拓集团技术部」这类中文名解析成账号地址，
      // 由前端拼接 @nanfu.local 会让中文名直接撞上“登录名或密码不正确”。
      const result = await nanfuAuthAction("signin", {
        email: email.trim(),
        password,
        ...(invite.trim() ? { invite: invite.trim() } : {}),
      });
      const state = result.state ?? (await refresh());
      setAccount(state);
      setPassword("");
      if (!state.authenticated) {
        setError("登录未完成，请检查登录名和密码。");
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
        <section className="onboarding-card gate-card gate-loading" aria-busy="true">
          <div className="gate-brand">
            <div className="gate-logo" aria-hidden="true">南</div>
            <div>
              <div className="gate-brand-name">南孚浏览器</div>
              <div className="gate-brand-sub">多环境指纹隔离</div>
            </div>
          </div>
          <h1>正在连接南孚账号…</h1>
          <p className="gate-note">首次启动需要几秒完成校验，请稍候。</p>
        </section>
      </main>
    );
  }

  if (!account?.authenticated) {
    return (
      <main className="onboarding">
        <section className="onboarding-card gate-card" aria-labelledby="nanfu-gate-title">
          <aside className="gate-aside" aria-hidden="true">
            <div className="gate-logo">南</div>
            <h2 className="gate-aside-title">南孚浏览器</h2>
            <p className="gate-aside-text">每个环境独立指纹、独立代理；登录态加密打包后可随环境转移到另一台机器。</p>
            <ul className="gate-feature-list">
              <li>环境指纹隔离</li>
              <li>独立代理出口</li>
              <li>云端环境转移</li>
            </ul>
          </aside>

          <div className="gate-panel">
            <header className="gate-header">
              <span className="gate-eyebrow">南孚浏览器</span>
              <h1 id="nanfu-gate-title">登录南孚账号</h1>
              <p className="gate-lede">用管理员分配给你的登录名和密码直接登录，不需要邮箱。</p>
            </header>

            <form
              className="gate-form"
              onSubmit={(event) => {
                event.preventDefault();
                void signIn();
              }}
            >
              <label className="gate-field">
                <span>登录名或邮箱</span>
                <input
                  type="text"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  value={email}
                  disabled={busy}
                  placeholder="例如：海拓集团技术部"
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>

              <label className="gate-field">
                <span>密码</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  required
                  maxLength={12}
                  value={password}
                  disabled={busy}
                  placeholder="6-12 位，字母与数字组合"
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>

              <div className="gate-invite">
                <button
                  type="button"
                  className="gate-invite-toggle"
                  aria-expanded={showInvite}
                  onClick={() => setShowInvite((open) => !open)}
                >
                  {showInvite ? "收起邀请码" : "我是新成员，有邀请码"}
                </button>
                {showInvite && (
                  <label className="gate-field">
                    <span>邀请码</span>
                    <input
                      type="text"
                      autoComplete="off"
                      value={invite}
                      disabled={busy}
                      placeholder="填写管理员给的邀请码，登录后自动加入组织"
                      onChange={(event) => setInvite(event.target.value)}
                    />
                  </label>
                )}
              </div>

              {error && <div className="gate-alert gate-alert-error" role="alert">{error}</div>}
              {notice && <div className="gate-alert gate-alert-info" role="status">{notice}</div>}

              <button className="gate-submit" type="submit" disabled={busy || !email.trim() || !password}>
                {busy ? "登录中…" : "登录"}
              </button>
            </form>

            <footer className="gate-footer">
              <span>账号由组织管理员创建</span>
              <a href="https://ananan28.github.io/nanfu-site/" target="_blank" rel="noreferrer">去官网注册</a>
            </footer>
          </div>
        </section>
      </main>
    );
  }

  return <>{children}</>;
}
