/**
 * Nanfu account: our own email/password identity on our Supabase project.
 *
 * This is intentionally separate from `supabase-auth.ts` (the bundled AliasMode
 * Cloud client): different project, different redirect targets, and Nanfu must
 * never sign in to the upstream service. Only the public anon key is used; the
 * service-role key never leaves the deployment environment.
 */

import { normalizeSecureServiceUrl } from "./app-config.ts";

export type NanfuFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface NanfuUser {
  id: string;
  email?: string;
  emailConfirmedAt: string;
}

export interface NanfuSession {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  expiresAt: number;
  user: NanfuUser;
}

export type NanfuAuthFailure =
  | { kind: "transport"; retryable: true }
  | { kind: "timeout"; retryable: true }
  | { kind: "http"; status: number; retryable: boolean; code?: string };

export class NanfuAuthError extends Error {
  constructor(
    message: string,
    readonly failure: NanfuAuthFailure,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NanfuAuthError";
  }
}

export class NanfuEmailUnverifiedError extends Error {
  constructor(readonly email: string) {
    super("Verify your email address before signing in");
    this.name = "NanfuEmailUnverifiedError";
  }
}

export interface NanfuAuthClientOptions {
  baseUrl: string;
  anonKey: string;
  fetchFn?: NanfuFetch;
  requestTimeoutMs?: number;
  nowMs?: () => number;
  /** Where Supabase sends the confirmation email link, when the project needs one. */
  emailRedirectTo?: string;
  /** Where Supabase sends the password-reset email link. */
  resetRedirectTo?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidNanfuEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

export const NANFU_LOGIN_SUFFIX = "@nanfu.local";

export function isValidNanfuLoginName(value: string): boolean {
  const length = Array.from(value).length;
  return length >= 2 && length <= 63 && !/[\s@\u0000-\u001f\u007f-\u009f]/u.test(value);
}

/**
 * Sub-accounts sign in with a bare name while GoTrue needs an address, so a
 * name without "@" is expanded to <name>@nanfu.local. Sign-up bypasses this.
 */
export function normalizeNanfuLogin(value: string): string {
  const login = value.trim().toLowerCase();
  return login.includes("@") ? login : `${login}${NANFU_LOGIN_SUFFIX}`;
}

/** Supabase requires at least six characters; the product adds an upper bound. */
export const NANFU_MIN_PASSWORD_LENGTH = 6;
export const NANFU_MAX_PASSWORD_LENGTH = 12;

/** 6-12 printable ASCII characters, mixing letters and digits without whitespace. */
export function isValidNanfuPassword(value: string): boolean {
  return nanfuPasswordProblem(value) === null;
}

/** The reason a password is rejected, or null when it passes. */
export function nanfuPasswordProblem(value: string): string | null {
  if (value.length < NANFU_MIN_PASSWORD_LENGTH || value.length > NANFU_MAX_PASSWORD_LENGTH) {
    return `密码需为 ${NANFU_MIN_PASSWORD_LENGTH}-${NANFU_MAX_PASSWORD_LENGTH} 位`;
  }
  if (/[^\x21-\x7e]/.test(value)) return "密码仅支持非空白的 ASCII 可打印字符，不能包含空格或中文";
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) return "密码需同时包含英文字母和数字";
  return null;
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600);
}

export interface NanfuSignUpResult {
  email: string;
  /** True when the project requires the confirmation email before the first sign-in. */
  verificationRequired: boolean;
  session?: NanfuSession;
}

export class NanfuAuthClient {
  private readonly baseUrl: string;
  private readonly fetchFn: NanfuFetch;
  private readonly requestTimeoutMs: number;
  private readonly nowMs: () => number;

  constructor(private readonly options: NanfuAuthClientOptions) {
    this.baseUrl = normalizeSecureServiceUrl(options.baseUrl, "Nanfu account service");
    this.fetchFn = options.fetchFn ?? ((url, init) => fetch(url, init));
    this.requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  async signUp(email: string, password: string): Promise<NanfuSignUpResult> {
    const problem = nanfuPasswordProblem(password);
    if (problem) throw new Error(problem);
    const query = this.options.emailRedirectTo
      ? `?redirect_to=${encodeURIComponent(this.options.emailRedirectTo)}`
      : "";
    const body = await this.call(`/signup${query}`, {
      method: "POST",
      body: JSON.stringify({ email: email.trim(), password }),
    });
    const user = body?.user ?? body;
    if (!user?.id) throw new Error("Nanfu account service returned no user for this sign-up");
    if (body?.access_token && user.email_confirmed_at) {
      return { email: String(user.email ?? email), verificationRequired: false, session: this.session(body) };
    }
    return { email: String(user.email ?? email), verificationRequired: true };
  }

  async resendSignUp(email: string): Promise<void> {
    const query = this.options.emailRedirectTo
      ? `?redirect_to=${encodeURIComponent(this.options.emailRedirectTo)}`
      : "";
    await this.call(`/resend${query}`, {
      method: "POST",
      body: JSON.stringify({ type: "signup", email: email.trim() }),
    });
  }

  async signIn(email: string, password: string): Promise<NanfuSession> {
    const body = await this.call("/token?grant_type=password", {
      method: "POST",
      body: JSON.stringify({ email: email.trim(), password }),
    });
    return this.session(body);
  }

  /**
   * The address behind a chosen sign-in name, so a name typed without "@" can
   * reach the account service. Returns null when no account uses that name.
   */
  async resolveLoginName(name: string): Promise<string | null> {
    const body = await this.call("/rpc/nanfu_login_resolve", {
      method: "POST",
      body: JSON.stringify({ p_name: name }),
    }, "/rest/v1");
    return typeof body === "string" && body ? body : null;
  }

  async refresh(refreshToken: string): Promise<NanfuSession> {
    const body = await this.call("/token?grant_type=refresh_token", {
      method: "POST",
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    return this.session(body);
  }

  async updatePassword(accessToken: string, password: string): Promise<void> {
    const problem = nanfuPasswordProblem(password);
    if (problem) throw new Error(problem);
    await this.call("/user", {
      method: "PUT",
      headers: { authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ password }),
    });
  }

  async requestPasswordReset(email: string): Promise<void> {
    const query = this.options.resetRedirectTo
      ? `?redirect_to=${encodeURIComponent(this.options.resetRedirectTo)}`
      : "";
    await this.call(`/recover${query}`, {
      method: "POST",
      body: JSON.stringify({ email: email.trim() }),
    });
  }

  async signOut(accessToken: string): Promise<void> {
    await this.call("/logout?scope=local", {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  private session(body: any): NanfuSession {
    const user = body?.user;
    if (!user?.id) throw new Error("Nanfu account service returned an incomplete session");
    if (!user.email_confirmed_at) throw new NanfuEmailUnverifiedError(String(user.email ?? ""));
    if (!body.access_token || !body.refresh_token || !Number.isFinite(body.expires_in)) {
      throw new Error("Nanfu account service returned an incomplete session");
    }
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresIn: body.expires_in,
      expiresAt: this.nowMs() + body.expires_in * 1_000,
      user: {
        id: String(user.id),
        ...(typeof user.email === "string" ? { email: user.email } : {}),
        emailConfirmedAt: user.email_confirmed_at,
      },
    };
  }

  private async call(path: string, init: RequestInit, prefix = "/auth/v1"): Promise<any> {
    const headers = new Headers(init.headers);
    headers.set("apikey", this.options.anonKey);
    headers.set("content-type", "application/json");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new NanfuAuthError(
          `Nanfu account request timed out after ${this.requestTimeoutMs}ms`,
          { kind: "timeout", retryable: true },
        );
        controller.abort(error);
        reject(error);
      }, this.requestTimeoutMs);
      if (timer && typeof timer === "object" && "unref" in timer) timer.unref();
    });
    try {
      const request = Promise.resolve().then(async () => {
        let response: Response;
        try {
          response = await this.fetchFn(`${this.baseUrl}${prefix}${path}`, {
            ...init,
            headers,
            signal: controller.signal,
          });
        } catch (error) {
          throw new NanfuAuthError(
            "Nanfu account service could not be reached",
            { kind: "transport", retryable: true },
            { cause: error },
          );
        }
        let text: string;
        try {
          text = await response.text();
        } catch (error) {
          throw new NanfuAuthError(
            "Nanfu account response could not be read",
            { kind: "transport", retryable: true },
            { cause: error },
          );
        }
        let body: any = {};
        if (text.trim()) {
          try {
            body = JSON.parse(text);
          } catch {
            if (response.ok) throw new Error(`Nanfu account service returned non-JSON (${response.status})`);
          }
        }
        if (!response.ok) {
          throw new NanfuAuthError(
            body?.msg ?? body?.message ?? body?.error_description ?? `Nanfu account request failed (${response.status})`,
            {
              kind: "http",
              status: response.status,
              retryable: retryableStatus(response.status),
              ...(typeof body?.error_code === "string" ? { code: body.error_code } : {}),
            },
          );
        }
        return body;
      });
      return await Promise.race([request, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** Refresh tokens are the only account secret kept between runs. */
export interface NanfuCredentialStore {
  load(): Promise<string | null>;
  save(refreshToken: string): Promise<void>;
  clear(): Promise<void>;
}

export interface NanfuAccountState {
  authenticated: boolean;
  email?: string;
  userId?: string;
  expiresAt?: number;
}

export interface NanfuAccountRuntimeOptions {
  credentials?: NanfuCredentialStore;
  nowMs?: () => number;
}

export class NanfuAccountChangedError extends Error {
  constructor() {
    super("账号已切换，请重新操作");
    this.name = "NanfuAccountChangedError";
  }
}

/**
 * Holds the live session: access tokens stay in memory, only the refresh token
 * is persisted. An expired access token is refreshed lazily and exactly once
 * per generation, so concurrent requests share one refresh.
 */
export class NanfuAccountRuntime {
  private accessTokenValue: string | undefined;
  private refreshTokenValue: string | undefined;
  private expiresAtValue: number | undefined;
  private userIdValue: string | undefined;
  private emailValue: string | undefined;
  private refreshInFlight: Promise<string | undefined> | undefined;
  private restoreInFlight: Promise<NanfuAccountState> | undefined;
  private credentialWrites: Promise<void> = Promise.resolve();
  private generation = 0;
  private readonly nowMs: () => number;

  constructor(
    private readonly auth: NanfuAuthClient,
    private readonly options: NanfuAccountRuntimeOptions = {},
  ) {
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  state(): NanfuAccountState {
    if (!this.userIdValue) return { authenticated: false };
    return {
      authenticated: true,
      ...(this.emailValue ? { email: this.emailValue } : {}),
      userId: this.userIdValue,
      ...(this.expiresAtValue ? { expiresAt: this.expiresAtValue } : {}),
    };
  }

  hasSession(): boolean {
    return !!(this.userIdValue || this.refreshTokenValue);
  }

  revision(): number {
    return this.generation;
  }

  assertCurrent(revision: number): void {
    if (revision !== this.generation) throw new NanfuAccountChangedError();
  }

  signUp(email: string, password: string): Promise<NanfuSignUpResult> {
    return this.auth.signUp(email, password);
  }

  resendSignUp(email: string): Promise<void> {
    return this.auth.resendSignUp(email);
  }

  /** A bare sign-in name becomes the account address before the password grant. */
  resolveLoginName(name: string): Promise<string | null> {
    return this.auth.resolveLoginName(name);
  }

  requestPasswordReset(email: string): Promise<void> {
    return this.auth.requestPasswordReset(email);
  }

  async signIn(email: string, password: string): Promise<NanfuAccountState> {
    if (this.hasSession()) throw new NanfuAuthError("请先退出当前南孚账号", { kind: "http", status: 409, retryable: false });
    this.clear();
    const revision = this.generation;
    const session = await this.auth.signIn(email, password);
    await this.accept(session, revision);
    return this.state();
  }

  restore(): Promise<NanfuAccountState> {
    if (this.hasSession()) return Promise.resolve(this.state());
    if (this.restoreInFlight) return this.restoreInFlight;
    const revision = this.generation;
    const pending = (async () => {
      await this.credentialWrites;
      const stored = await this.options.credentials?.load() ?? null;
      this.assertCurrent(revision);
      if (!stored) return this.state();
      try {
        const session = await this.auth.refresh(stored);
        await this.accept(session, revision);
        return this.state();
      } catch (error) {
        this.assertCurrent(revision);
        if (error instanceof NanfuAuthError && error.failure.kind === "http" && !error.failure.retryable) {
          this.clear();
          await this.persist(() => this.options.credentials?.clear());
          return this.state();
        }
        throw error;
      }
    })().finally(() => {
      if (this.restoreInFlight === pending) this.restoreInFlight = undefined;
    });
    this.restoreInFlight = pending;
    return pending;
  }

  async signOut(): Promise<void> {
    const accessToken = this.accessToken();
    this.clear();
    await this.persist(() => this.options.credentials?.clear());
    if (accessToken) {
      try {
        await this.auth.signOut(accessToken);
      } catch {
        // Local sign-out must not depend on the service being reachable.
      }
    }
  }

  async accessTokenOrRefresh(): Promise<string | undefined> {
    const current = this.accessToken();
    if (current) return current;
    if (!this.refreshTokenValue) return undefined;
    if (this.refreshInFlight) return this.refreshInFlight;

    const refreshToken = this.refreshTokenValue;
    const generation = this.generation;
    const pending = (async () => {
      try {
        const session = await this.auth.refresh(refreshToken);
        if (generation !== this.generation) return undefined;
        if (session.user.id !== this.userIdValue) throw new NanfuAuthError("账号会话不匹配，请重新登录", { kind: "http", status: 401, retryable: false });
        await this.accept(session, generation);
        return this.accessToken();
      } catch (error) {
        if (generation !== this.generation) return undefined;
        if (error instanceof NanfuAuthError && error.failure.kind === "http" && !error.failure.retryable) {
          this.clear();
          await this.persist(() => this.options.credentials?.clear());
        }
        throw error;
      }
    })().finally(() => {
      if (this.refreshInFlight === pending) this.refreshInFlight = undefined;
    });
    this.refreshInFlight = pending;
    return pending;
  }

  /**
   * Change the password after proving knowledge of the current one: Supabase
   * updates a user without it, so the current password is verified by a fresh
   * sign-in that also rotates the stored refresh token.
   */
  async changePassword(currentPassword: string, nextPassword: string): Promise<void> {
    const email = this.emailValue;
    if (!email || !this.hasSession()) throw new Error("Sign in before changing the password");
    if (!isValidNanfuPassword(nextPassword)) {
      throw new Error(nanfuPasswordProblem(nextPassword) ?? "密码不符合要求");
    }
    const revision = this.generation;
    const session = await this.auth.signIn(email, currentPassword);
    await this.accept(session, revision);
    await this.auth.updatePassword(session.accessToken, nextPassword);
    this.assertCurrent(revision);
  }

  clear(): void {
    this.generation++;
    this.refreshInFlight = undefined;
    this.restoreInFlight = undefined;
    this.accessTokenValue = undefined;
    this.refreshTokenValue = undefined;
    this.expiresAtValue = undefined;
    this.userIdValue = undefined;
    this.emailValue = undefined;
  }

  private accessToken(): string | undefined {
    if (!this.accessTokenValue || !this.expiresAtValue || this.expiresAtValue <= this.nowMs()) return undefined;
    return this.accessTokenValue;
  }

  private persist(operation: () => Promise<void> | undefined): Promise<void> {
    const pending = this.credentialWrites.then(operation);
    this.credentialWrites = pending.catch(() => {});
    return pending;
  }

  private async accept(session: NanfuSession, revision: number): Promise<void> {
    this.assertCurrent(revision);
    await this.persist(() => {
      this.assertCurrent(revision);
      return this.options.credentials?.save(session.refreshToken);
    });
    this.assertCurrent(revision);
    this.accessTokenValue = session.accessToken;
    this.refreshTokenValue = session.refreshToken;
    this.expiresAtValue = session.expiresAt;
    this.userIdValue = session.user.id;
    this.emailValue = session.user.email;
  }
}
