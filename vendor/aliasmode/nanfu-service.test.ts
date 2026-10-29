import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NANFU_DEFAULT_SERVICE,
  NanfuServiceConfigError,
  loadNanfuService,
  normalizeNanfuPublishableKey,
  normalizeNanfuService,
  saveNanfuService,
  createNanfuRuntime,
} from "./nanfu-service.ts";
import { handleUiRequest } from "./ui.ts";
import type { NanfuCredentialStore } from "./nanfu-account.ts";
import { fetchNanfuState, fetchNanfuEnvironments, nanfuAuthAction, NanfuApiError, isNanfuSignInRequired } from "./web/api.ts";

function serviceRoleJwt(): string {
  const payload = Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url");
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.signature`;
}

describe("Nanfu service configuration", () => {
  test("ships working defaults but keeps them replaceable", () => {
    const fromDefaults = normalizeNanfuService({ ...NANFU_DEFAULT_SERVICE });
    expect(fromDefaults.url).toBe("https://zojqxzaqumrtykcufqzg.supabase.co");
    expect(fromDefaults.publishableKey.startsWith("sb_publishable_")).toBe(true);

    const replaced = normalizeNanfuService({
      url: "https://example.supabase.co",
      publishableKey: NANFU_DEFAULT_SERVICE.publishableKey,
    });
    expect(replaced.url).toBe("https://example.supabase.co");
  });

  test("refuses a service-role key in any shape", () => {
    expect(() => normalizeNanfuPublishableKey("sb_secret_abcdefghijklmnopqrstuvwxyz")).toThrow(NanfuServiceConfigError);
    expect(() => normalizeNanfuPublishableKey(serviceRoleJwt())).toThrow(NanfuServiceConfigError);
    expect(() => normalizeNanfuPublishableKey("eyJhbGciOiJIUzI1NiJ9.notjson.sig")).toThrow(NanfuServiceConfigError);
  });

  test("refuses plaintext transport outside loopback", () => {
    expect(() =>
      normalizeNanfuService({ url: "http://example.supabase.co", publishableKey: NANFU_DEFAULT_SERVICE.publishableKey }),
    ).toThrow(NanfuServiceConfigError);
  });

  test("file and environment override the defaults, environment last", () => {
    const dir = mkdtempSync(join(tmpdir(), "nanfu-service-"));
    const file = join(dir, "nanfu-service.json");
    writeFileSync(
      file,
      JSON.stringify({ url: "https://file.supabase.co", publishableKey: NANFU_DEFAULT_SERVICE.publishableKey }),
    );
    expect(loadNanfuService({ file, env: {} }).url).toBe("https://file.supabase.co");
    expect(
      loadNanfuService({
        file,
        env: { NANFU_SUPABASE_URL: "https://env.supabase.co" },
      }).url,
    ).toBe("https://env.supabase.co");
  });

  test("a malformed file fails loudly instead of silently using defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "nanfu-service-"));
    const file = join(dir, "nanfu-service.json");
    writeFileSync(file, "{not json");
    expect(() => loadNanfuService({ file, env: {} })).toThrow(NanfuServiceConfigError);
  });

  test("save writes a private file that loads back unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "nanfu-service-"));
    const file = join(dir, "nanfu-service.json");
    const saved = saveNanfuService(file, {
      url: "https://saved.supabase.co",
      publishableKey: NANFU_DEFAULT_SERVICE.publishableKey,
    });
    expect(readFileSync(file, "utf8")).toContain("saved.supabase.co");
    expect(loadNanfuService({ file, env: {} })).toEqual(saved);
  });
});

function accountFixture() {
  let token: string | null = null;
  let locked = false;
  let disabled = false;
  let verificationRequired = false;
  let emptyOrg = false;
  let joinFails = false;
  let offline = false;
  let rejectRefresh = false;
  let canViewMembers = false;
  let pauseEnvironments: (() => Promise<void>) | undefined;
  const requests: URL[] = [];
  const credentials: NanfuCredentialStore = {
    load: async () => token,
    save: async value => { token = value; },
    clear: async () => { token = null; },
  };
  const session = (id: string) => ({
    access_token: `synthetic-access-${id}`, refresh_token: `synthetic-refresh-${id}`,
    expires_in: 3600, user: { id, email: `${id}@fixture.test`, email_confirmed_at: "2026-10-29T00:00:00Z" },
  });
  const supabase = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      requests.push(url);
      if (offline) return Response.json({}, { status: 503 });
      if (url.pathname === "/auth/v1/signup") return Response.json(verificationRequired
        ? { id: "registered", email: "registered@fixture.test", email_confirmed_at: null } : session("registered"));
      if (url.pathname === "/auth/v1/token") {
        if (verificationRequired) return Response.json({ error_code: "email_not_confirmed" }, { status: 400 });
        const body = await req.json() as any;
        if (url.searchParams.get("grant_type") === "refresh_token") {
          if (rejectRefresh) return Response.json({}, { status: 400 });
          return Response.json(session(String(body.refresh_token).replace("synthetic-refresh-", "")));
        }
        if (body.password !== "synthetic-password") return Response.json({ message: "do not expose upstream errors" }, { status: 400 });
        return Response.json(session(body.email.split("@")[0]));
      }
      if (url.pathname === "/auth/v1/logout") return new Response(null, { status: 204 });
      const id = req.headers.get("authorization")?.replace("Bearer synthetic-access-", "");
      if (!id || id.startsWith("Bearer")) return Response.json({}, { status: 401 });
      if (url.pathname === "/rest/v1/rpc/nanfu_org_me") return Response.json(emptyOrg ? [] : [{
        org_id: "org-1", identity: "member", role_name: "成员", permissions: canViewMembers ? ["env.create", "member.view"] : ["env.create"],
        env_quota: 2, used: 1, status: disabled ? "disabled" : "active", locked,
      }]);
      if (url.pathname === "/rest/v1/rpc/nanfu_org_self_join") {
        if (joinFails) return Response.json({ code: "P0001", message: "NANFU_GROUP_INVALID: the default organization is not provisioned" }, { status: 400 });
        return Response.json("org-1");
      }
      if (url.pathname === "/rest/v1/rpc/nanfu_org_redeem_invite") {
        const body = await req.json() as any;
        if (body.p_code === "EXPIRED") return Response.json({ code: "P0001", message: "this invite has expired" }, { status: 400 });
        if (body.p_code === "MEMBER") return Response.json({ code: "42501", message: "NANFU_FORBIDDEN: this account already belongs to an organization" }, { status: 400 });
        return Response.json("org-7");
      }
      if (url.pathname === "/rest/v1/nanfu_orgs") return Response.json([{ id: "org-1", name: "Synthetic organization" }]);
      if (url.pathname === "/rest/v1/rpc/nanfu_org_create") {
        const body = await req.json() as any;
        if (body.p_name === "已存在") return Response.json({ code: "P0001", message: "NANFU_FORBIDDEN: this account already belongs to an organization" }, { status: 400 });
        return Response.json(`org-${String(body.p_name).length}`);
      }
      if (url.pathname === "/rest/v1/rpc/nanfu_org_overview") {
        return Response.json([{ user_id: "a", email: "a@fixture.test", identity: "member", role_id: null, role_name: null,
          env_quota: 2, used: 1, status: "active", locked: false, manager_user_id: null }]);
      }
      if (["/rest/v1/nanfu_org_roles", "/rest/v1/nanfu_org_groups", "/rest/v1/nanfu_org_group_grants", "/rest/v1/nanfu_org_invites"].includes(url.pathname)) return Response.json([]);
      if (url.pathname === "/rest/v1/nanfu_environments") {
        await pauseEnvironments?.();
        return Response.json([{
          environment_id: `visible-${id}`, owner_user_id: "group-owner", org_id: "org-1", group_id: "granted-group",
          version: 1, updated_at: "2026-10-29T00:00:00Z", payload: "must-not-reach-the-ui",
        }]);
      }
      return Response.json({}, { status: 404 });
    },
  });
  const root = mkdtempSync(join(tmpdir(), "nanfu-routes-"));
  const file = join(root, "nanfu-service.json");
  writeFileSync(file, JSON.stringify({ url: `http://127.0.0.1:${supabase.port}`, publishableKey: "sb_publishable_synthetic_public_fixture_12345" }));
  let runtime = createNanfuRuntime({ file, env: {}, credentials });
  const ui = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      return await handleUiRequest(req, null as any, null as any, undefined, { nanfu: runtime }) ?? new Response(null, { status: 404 });
    },
  });
  const call = async (action: string, body?: object, headers?: HeadersInit) => {
    const requestHeaders = new Headers(headers);
    if (!requestHeaders.has("content-type")) requestHeaders.set("Content-Type", "application/json");
    const response = await fetch(`http://127.0.0.1:${ui.port}/ui/api/nanfu/${action}`, {
      method: body ? "POST" : "GET", headers: requestHeaders,
      body: body ? JSON.stringify(body) : undefined,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    return { status: response.status, body: await response.json() as any };
  };
  return {
    call, requests, credentials, token: () => token, baseUrl: `http://127.0.0.1:${ui.port}`,
    callUi: async (path: string, body?: object) => {
      const response = await fetch(`http://127.0.0.1:${ui.port}${path}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, body: await response.json() as any };
    },
    restart: () => { runtime = createNanfuRuntime({ file, env: {}, credentials }); },
    lock: () => { locked = true; }, noOrg: () => { emptyOrg = true; },
    failJoin: (value: boolean) => { joinFails = value; },
    disable: () => { disabled = true; }, verifyEmail: () => { verificationRequired = true; },
    offline: (value: boolean) => { offline = value; }, rejectRefresh: () => { rejectRefresh = true; },
    viewMembers: () => { canViewMembers = true; },
    pause: (fn: () => Promise<void>) => { pauseEnvironments = fn; },
    close: () => { ui.stop(true); supabase.stop(true); },
  };
}

test("real HTTP routes use the configured Nanfu runtime and never expose signup sessions", async () => {
  const f = accountFixture();
  try {
    const signup = await f.call("signup", { email: "registered@fixture.test", password: "synthetic-password" });
    expect(signup.body).toEqual({ ok: true, email: "registered@fixture.test", verificationRequired: false });
    expect(f.token()).toBeNull();
    expect((await f.call("environments")).status).toBe(401);
    expect((await f.call("signin", { email: "a@fixture.test", password: "incorrect" })).body.error).not.toContain("upstream");
    const signedIn = await f.call("signin", { email: "a@fixture.test", password: "synthetic-password" });
    expect(signedIn.body.state.userId).toBe("a");
    expect(signedIn.body.persistent).toBe(true);
    expect(JSON.stringify(signedIn.body)).not.toContain("synthetic-access");
    expect(JSON.stringify(signedIn.body)).not.toContain("synthetic-refresh");
    expect((await f.call("organization")).body.organization.orgId).toBe("org-1");
    const roster = await f.call("environments");
    expect(roster.body.environments[0]).toMatchObject({ id: "visible-a", ownerUserId: "group-owner", groupId: "granted-group" });
    expect(JSON.stringify(roster.body)).not.toContain("must-not-reach");
    const query = f.requests.find(url => url.pathname.endsWith("/nanfu_environments"))!;
    expect(query.searchParams.has("owner_user_id")).toBe(false);
    expect(query.searchParams.get("select")).not.toContain("payload");
    expect(f.requests.some(url => url.pathname.includes("bootstrap"))).toBe(false);
    // A second sign-in while a session is live is refused with 409, not 401:
    // the gate shows "already signed in" and opens the workspace.
    const second = await f.call("signin", { email: "b@fixture.test", password: "synthetic-password" });
    expect(second.status).toBe(409);
    expect(second.body.alreadySignedIn).toBe(true);
    expect(second.body.state.userId).toBe("a");
    expect((await f.call("signout", {})).body.state.authenticated).toBe(false);
    expect(f.token()).toBeNull();
  } finally { f.close(); }
});

test("HTTP restore uses only the stored refresh token and preserves it on network failure", async () => {
  const f = accountFixture();
  try {
    await f.call("signin", { email: "a@fixture.test", password: "synthetic-password" });
    f.restart();
    expect((await f.call("state")).body.state.authenticated).toBe(false);
    f.offline(true);
    expect((await f.call("restore", {})).body.retryable).toBe(true);
    expect(f.token()).toBe("synthetic-refresh-a");
    f.offline(false);
    expect((await f.call("restore", {})).body.state.userId).toBe("a");
    f.restart();
    f.rejectRefresh();
    expect((await f.call("restore", {})).body.state.authenticated).toBe(false);
    expect(f.token()).toBeNull();
  } finally { f.close(); }
});

test("locked and organization-free accounts do not request environment payloads", async () => {
  const f = accountFixture();
  try {
    await f.call("signin", { email: "a@fixture.test", password: "synthetic-password" });
    f.lock();
    const locked = await f.call("environments");
    expect(locked.body.organization.locked).toBe(true);
    expect(locked.body.environments).toEqual([]);
    f.noOrg();
    expect((await f.call("environments")).body.organization).toBeNull();
    expect(f.requests.some(url => url.pathname.endsWith("/nanfu_environments"))).toBe(false);
    expect((await f.call("signout", {}, { Origin: "https://untrusted.test" })).status).toBe(403);
    expect(f.token()).not.toBeNull();
  } finally { f.close(); }
});

test("late organization responses cannot cross logout and another account's login", async () => {
  const f = accountFixture();
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    await f.call("signin", { email: "a@fixture.test", password: "synthetic-password" });
    f.pause(async () => { started(); await gate; });
    const previous = f.call("environments");
    await waiting;
    await f.call("signout", {});
    await f.call("signin", { email: "b@fixture.test", password: "synthetic-password" });
    release();
    const stale = await previous;
    expect(stale.status).not.toBe(200);
    expect(JSON.stringify(stale.body)).not.toContain("visible-a");
    expect((await f.call("environments")).body.environments[0].id).toBe("visible-b");
  } finally { release?.(); f.close(); }
});

test("HTTP registration explains email verification and refuses an unverified login", async () => {
  const f = accountFixture();
  try {
    f.verifyEmail();
    expect((await f.call("signup", { email: "registered@fixture.test", password: "synthetic-password" })).body)
      .toEqual({ ok: true, email: "registered@fixture.test", verificationRequired: true });
    const login = await f.call("signin", { email: "registered@fixture.test", password: "synthetic-password" });
    expect(login.status).toBe(401);
    expect(login.body.code).toBe("email_not_confirmed");
    expect(login.body.error).toContain("确认邮箱");
    expect(f.token()).toBeNull();
  } finally { f.close(); }
});

test("disabled organizations and non-JSON mutations fail closed", async () => {
  const f = accountFixture();
  try {
    expect((await f.call("signin", { email: "invalid", password: "x" })).status).toBe(400);
    expect((await f.call("signin", {}, { "Content-Type": "text/plain" })).status).toBe(415);
    expect(f.requests).toHaveLength(0);
    await f.call("signin", { email: "a@fixture.test", password: "synthetic-password" });
    const afterSignIn = f.requests.length;
    f.disable();
    const list = await f.call("environments");
    expect(list.body.organization).toMatchObject({ status: "disabled", quota: 2, used: 1 });
    expect(list.body.environments).toEqual([]);
    expect(f.requests.slice(afterSignIn).some(url => url.pathname.endsWith("/nanfu_environments") || url.pathname.endsWith("/nanfu_orgs"))).toBe(false);
  } finally { f.close(); }
});

test("the frontend Nanfu client reaches real local routes with no-store and cancellation", async () => {
  const f = accountFixture();
  const originalFetch = globalThis.fetch;
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const path = String(input);
    if (!path.startsWith("/ui/api/nanfu/")) return originalFetch(input, init);
    requests.push({ path, init });
    return originalFetch(new URL(path, f.baseUrl), init);
  }) as unknown as typeof fetch);
  try {
    expect((await fetchNanfuState()).state.authenticated).toBe(false);
    await expect(nanfuAuthAction("signin", { email: "a@fixture.test", password: "wrong-password" })).rejects.toBeInstanceOf(NanfuApiError);
    expect((await nanfuAuthAction("signin", { email: "a@fixture.test", password: "synthetic-password" })).state?.userId).toBe("a");
    expect((await fetchNanfuEnvironments()).environments[0]?.id).toBe("visible-a");
    const controller = new AbortController();
    controller.abort();
    await expect(fetchNanfuEnvironments(controller.signal)).rejects.toThrow();
    expect(requests.at(-1)?.init?.signal).toBe(controller.signal);
    await nanfuAuthAction("signout");
    expect((await fetchNanfuState()).state.authenticated).toBe(false);
    expect(requests.every(request => request.init?.cache === "no-store")).toBe(true);
    const logout = requests.find(request => request.path.endsWith("/signout"))!;
    expect(logout.init?.body).toBe("{}");
    expect(new Headers(logout.init?.headers).get("content-type")).toBe("application/json");
  } finally { fetchSpy.mockRestore(); f.close(); }
});

test("organization management routes need a session, validate input and map refusals", async () => {
  const f = accountFixture();
  try {
    expect((await f.call("create-organization", { name: "合成组织" })).status).toBe(401);
    await f.call("signin", { email: "a@fixture.test", password: "synthetic-password" });
    const created = await f.call("create-organization", { name: "synthetic" });
    expect(created.body).toEqual({ ok: true, result: { orgId: "org-9" }, userId: "a" });
    expect(JSON.stringify(created.body)).not.toContain("synthetic-access");
    expect((await f.call("create-organization", { name: "" })).body.error).toContain("name");
    expect((await f.call("create-organization", { name: "" })).status).toBe(400);
    const refusal = await f.call("create-organization", { name: "已存在" });
    expect(refusal.status).toBe(403);
    expect(refusal.body).toMatchObject({ ok: false, code: "ORG_ALREADY_MEMBER", error: "当前账号已属于组织，不能重复创建或加入组织。" });
    expect(JSON.stringify(refusal.body)).not.toContain("NANFU_FORBIDDEN");
    const overview = await f.call("organization-overview");
    expect(overview.status).toBe(200);
    expect(overview.body.result.members[0]).toMatchObject({ userId: "a", email: "a@fixture.test", quota: 2, used: 1 });
    expect((await f.call("set-quota", { userId: "not-a-uuid", quota: 3 })).status).toBe(400);
    const missing = await f.call("set-quota", { userId: "00000000-0000-4000-8000-000000000002", quota: 3 });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe("服务端拒绝操作，请检查参数、目标状态或联系管理员。");
    await f.call("signout", {});
    expect((await f.call("organization-overview")).status).toBe(401);
  } finally { f.close(); }
});

test("an employee's windows are readable only with member.view and stay owner-filtered", async () => {
  const f = accountFixture();
  const memberId = "11111111-1111-4111-8111-111111111111";
  try {
    expect((await f.call(`member-environments?userId=${memberId}`)).status).toBe(401);
    await f.call("signin", { email: "a@fixture.test", password: "synthetic-password" });
    expect((await f.call(`member-environments?userId=${memberId}`)).status).toBe(403);
    f.viewMembers();
    expect((await f.call("member-environments?userId=not-a-uuid")).status).toBe(400);
    const list = await f.call(`member-environments?userId=${memberId}`);
    expect(list.status).toBe(200);
    expect(list.body.environments[0]).toMatchObject({ id: "visible-a", ownerUserId: "group-owner" });
    expect(JSON.stringify(list.body)).not.toContain("must-not-reach");
    const query = f.requests.filter(url => url.pathname.endsWith("/nanfu_environments")).at(-1)!;
    expect(query.searchParams.get("owner_user_id")).toBe(`eq.${memberId}`);
    expect(query.searchParams.get("org_id")).toBe("eq.org-1");
    expect(query.searchParams.get("select")).not.toContain("payload");
  } finally { f.close(); }
});

test("sign-in attaches the account to the default organization without risking the session", async () => {
  const f = accountFixture();
  try {
    expect((await f.call("self-join", {})).status).toBe(401);
    f.noOrg();
    f.failJoin(true);
    const signedIn = await f.call("signin", { email: "a@fixture.test", password: "synthetic-password" });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.state.authenticated).toBe(true);
    expect(signedIn.body.selfJoin).toEqual({ ok: false, error: "加入默认组织失败，可稍后重试" });
    expect(f.token()).toBe("synthetic-refresh-a");
    const retry = await f.call("self-join", {});
    expect(retry.status).toBe(409);
    expect(retry.body.error).toBe("分组或成员不属于当前组织。");
    expect(retry.body).toEqual({ ok: false, error: "分组或成员不属于当前组织。", code: "NANFU_GROUP_INVALID" });
    f.failJoin(false);
    expect((await f.call("self-join", {})).body).toMatchObject({ ok: true, orgId: "org-1", userId: "a" });
  } finally { f.close(); }
});

test("signing in with an invite code redeems it instead of taking the default seat", async () => {
  const f = accountFixture();
  try {
    f.noOrg();
    const expired = await f.call("signin", { email: "a@fixture.test", password: "synthetic-password", invite: "EXPIRED" });
    expect(expired.status).toBe(200);
    expect(expired.body.state.authenticated).toBe(true);
    expect(expired.body.selfJoin).toEqual({ ok: false, error: "邀请码已过期，请向管理员申请新码。" });
    await f.call("signout", {});
    const member = await f.call("signin", { email: "a@fixture.test", password: "synthetic-password", invite: "MEMBER" });
    expect(member.body.selfJoin).toEqual({ ok: false, error: "当前账号已属于组织，不能重复创建或加入组织。" });
    expect(JSON.stringify(member.body)).not.toContain("42501");
    await f.call("signout", {});
    const blank = await f.call("signin", { email: "a@fixture.test", password: "synthetic-password", invite: "   " });
    expect(blank.body.selfJoin).toEqual({ ok: true });
    await f.call("signout", {});
    const redeemed = await f.call("signin", { email: "a@fixture.test", password: "synthetic-password", invite: "INVITE-OK" });
    expect(redeemed.body.selfJoin).toEqual({ ok: true, orgId: "org-7" });
    expect(f.requests.filter(url => url.pathname.endsWith("/rpc/nanfu_org_redeem_invite"))).toHaveLength(3);
    expect(f.requests.filter(url => url.pathname.endsWith("/rpc/nanfu_org_self_join"))).toHaveLength(1);
  } finally { f.close(); }
});

test("windows cannot be created, launched or imported before a Nanfu session exists", async () => {
  const f = accountFixture();
  try {
    for (const path of ["/ui/api/profiles", "/ui/api/profiles/env-1/open", "/ui/api/import", "/ui/api/import/upload"]) {
      const blocked = await f.callUi(path, { name: "合成环境" });
      expect(blocked.status).toBe(401);
      expect(blocked.body.code).toBe("nanfu_signin_required");
      expect(blocked.body.error).toContain("登录");
    }
    expect(f.requests.length).toBe(0);
    await f.call("signin", { email: "a@fixture.test", password: "synthetic-password" });
    const allowed = await f.callUi("/ui/api/profiles", { name: "合成环境" });
    expect(allowed.body.code).not.toBe("nanfu_signin_required");
    expect(isNanfuSignInRequired(allowed.body)).toBe(false);
  } finally { f.close(); }
});

test("a refused window write points the dashboard at Nanfu sign-in", async () => {
  const f = accountFixture();
  try {
    const blocked = await f.callUi("/ui/api/profiles", { name: "合成环境" });
    expect(blocked.status).toBe(401);
    expect(isNanfuSignInRequired(blocked.body)).toBe(true);
    expect(isNanfuSignInRequired({ ok: false, error: "别的失败" })).toBe(false);
    expect(isNanfuSignInRequired({ ok: false, code: "nanfu_signin_required" })).toBe(true);
    expect(isNanfuSignInRequired(null)).toBe(false);
    expect(isNanfuSignInRequired("nanfu_signin_required")).toBe(false);
  } finally { f.close(); }
});
