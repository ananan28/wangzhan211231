import { type ReactNode, useCallback, useEffect, useState } from "react";
import {
  fetchNanfuState,
  nanfuAuthAction,
  nanfuSelfJoin,
  openNanfuGoogleOAuth,
  startNanfuGoogleOAuth,
  NanfuApiError,
  type NanfuAccountState,
} from "./api.ts";

/**
 * Mandatory sign-in for the 南孚 build. The workspace stays local, while the
 * account, quota and transfer features talk to the 南孚 service; nothing renders
 * before the account is signed in, so no one runs the browser anonymously.
 */
export function NanfuGate({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<NanfuAccountState | null>(null);
  const [busy, setBusy] = useState(true);
  const [googleBusy, setGoogleBusy] = useState(false);
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

  // Google 授权在系统浏览器里完成，客户端拿不到回调事件，只能轮询本机登录态；
  // 回调换到会话后 fetchNanfuState 会变成已登录，随即放行工作区。
  useEffect(() => {
    if (!googleBusy) return;
    let active = true;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      void (async () => {
        try {
          const state = await refresh();
          if (!active) return;
          if (state.authenticated) {
            setGoogleBusy(false);
            setNotice(null);
            return;
          }
        } catch {
          // 授权期间账号服务偶发抖动不打断等待。
        }
        if (active && Date.now() - startedAt > 10 * 60_000) {
          setGoogleBusy(false);
          setNotice(null);
          setError("未检测到 Google 授权结果，请重试。");
        }
      })();
    }, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [googleBusy, refresh]);

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

  const signInWithGoogle = async () => {
    setError(null);
    setNotice(null);
    setGoogleBusy(true);
    try {
      const started = await startNanfuGoogleOAuth();
      // 桌面端 Tauri 只允许白名单外链走系统浏览器，交给本机 sidecar 代开更稳；
      // 普通浏览器调试时直接新开标签页即可。
      const desktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
      if (desktop) {
        const opened = await openNanfuGoogleOAuth(started.state);
        if (!opened.opened) {
          setGoogleBusy(false);
          setError("系统浏览器未能打开，请检查默认浏览器设置后重试。");
          return;
        }
      } else {
        window.open(started.url, "_blank", "noopener,noreferrer");
      }
      setNotice("已打开 Google 授权页，完成授权后会自动登录。");
    } catch (failure) {
      setGoogleBusy(false);
      setError(failure instanceof NanfuApiError ? failure.message : "无法启动 Google 登录，请重试。");
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

            <div style={{ display: "grid", gap: 10, marginTop: 18 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, color: "#8d99ad", fontSize: 12.5 }}>
                <span style={{ flex: 1, height: 1, background: "#edf0f6" }} />
                <span>或</span>
                <span style={{ flex: 1, height: 1, background: "#edf0f6" }} />
              </div>
              <button
                type="button"
                className="gate-submit"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 10,
                  background: "#fff",
                  color: "#25395f",
                  border: "1px solid #d7deea",
                  boxShadow: "none",
                }}
                disabled={busy || googleBusy}
                onClick={() => void signInWithGoogle()}
              >
                <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                  <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.57 2.7-3.88 2.7-6.62z" />
                  <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.83.86-3.06.86-2.35 0-4.34-1.58-5.05-3.71H.96v2.33A9 9 0 0 0 9 18z" />
                  <path fill="#FBBC05" d="M3.95 10.71a5.4 5.4 0 0 1 0-3.42V4.96H.96a9 9 0 0 0 0 8.08l2.99-2.33z" />
                  <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.42 0 9 0A9 9 0 0 0 .96 4.96l2.99 2.33C4.66 5.16 6.65 3.58 9 3.58z" />
                </svg>
                {googleBusy ? "正在等待 Google 授权…" : "使用 Google 登录 / 注册"}
              </button>
              {googleBusy && (
                <button
                  type="button"
                  className="gate-invite-toggle"
                  style={{ justifySelf: "center" }}
                  onClick={() => {
                    setGoogleBusy(false);
                    setNotice("已取消等待；如已在浏览器完成授权，请刷新页面。");
                  }}
                >
                  取消等待
                </button>
              )}
            </div>

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
