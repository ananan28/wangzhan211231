import { expect, test } from "bun:test";
import {
  NanfuSyncCipher,
  NanfuSyncClient,
  NanfuSyncDecryptError,
  NanfuSyncError,
  createNanfuSyncKeyParams,
  exportNanfuEnvironment,
  planNanfuSync,
  syncNanfuEnvironments,
  type NanfuEnvironmentConfig,
  type NanfuLocalRecord,
  type NanfuRemoteRecord,
} from "./nanfu-sync.ts";
import {
  NANFU_ORGANIZATION_ACTIONS,
  NanfuInputError,
  mutateNanfuOrganization,
  nanfuOrganizationError,
} from "./nanfu-organization.ts";
import type { Profile } from "./types.ts";

function profile(overrides: Record<string, unknown> = {}): Profile {
  return {
    id: "p1",
    engine: "chromium",
    accId: "acc1",
    name: "Work X",
    group: "Team",
    username: "account-user-secret",
    password: "account-pass-secret",
    email: "account@example.com",
    emailPassword: "inbox-pass-secret",
    twofa: "tfa-seed-secret",
    proxy: { type: "http", host: "proxy.example", port: "8080", user: "proxy-user", pass: "proxy-pass" },
    extensions: ["ext1", "ext2"],
    tags: ["ops"],
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/155.0.0.0",
    timezone: "America/New_York",
    locale: "en-US",
    screenWidth: 1920,
    screenHeight: 1080,
    fingerprintSeed: 12345,
    platform: "x.com",
    cookies: [{ name: "sid", value: "cookie-secret" }],
    seeded: true,
    ...overrides,
  } as unknown as Profile;
}

const params = createNanfuSyncKeyParams(1024);
const cipher = () => new NanfuSyncCipher("correct horse battery staple", params);

/** Fails fast instead of leaving the runner blocked on a gate that never releases. */
function deadline<T>(promise: Promise<T>, label: string, ms = 5_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

test("the exporter carries configuration only and never account secrets or cookies", () => {
  const config = exportNanfuEnvironment(
    profile(),
    new Map([["ext1", "ModHeader"], ["ext2", "uBlock Origin"]]),
    "2026-10-29T00:00:00.000Z",
  );
  expect(config).toEqual({
    schema: 1,
    id: "p1",
    name: "Work X",
    group: "Team",
    engine: "chromium",
    platform: "x.com",
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/155.0.0.0",
    timezone: "America/New_York",
    locale: "en-US",
    screen: { width: 1920, height: 1080 },
    fingerprint: { seed: 12345 },
    tags: ["ops"],
    extensions: ["ModHeader", "uBlock Origin"],
    proxy: { type: "http", host: "proxy.example", port: "8080", user: "proxy-user", pass: "proxy-pass" },
    updatedAt: "2026-10-29T00:00:00.000Z",
  });
  const text = JSON.stringify(config);
  for (const secret of ["account-user-secret", "account-pass-secret", "account@example.com", "inbox-pass-secret", "tfa-seed-secret", "cookie-secret", "ext1", "ext2"]) {
    expect(text).not.toContain(secret);
  }
});

test("environment payloads round-trip through AES-GCM and carry no plaintext", () => {
  const local = cipher();
  const config = exportNanfuEnvironment(profile(), new Map(), "2026-10-29T00:00:00.000Z");
  const envelope = local.encrypt(config);
  expect(envelope).not.toContain("Work X");
  expect(envelope).not.toContain("proxy.example");
  expect(cipher().decrypt<NanfuEnvironmentConfig>(envelope)).toEqual(config);
});

test("a wrong passphrase and a tampered payload both fail closed", () => {
  const envelope = cipher().encrypt(exportNanfuEnvironment(profile(), new Map(), "2026-10-29T00:00:00.000Z"));
  const wrong = new NanfuSyncCipher("wrong passphrase", params);
  expect(() => wrong.decrypt(envelope)).toThrow(NanfuSyncDecryptError);

  const parsed = JSON.parse(envelope);
  const bytes = Buffer.from(parsed.ct, "base64");
  bytes[0] = bytes[0]! ^ 0xff;
  parsed.ct = bytes.toString("base64");
  expect(() => cipher().decrypt(JSON.stringify(parsed))).toThrow(NanfuSyncDecryptError);
});

test("a second device adopts the salt carried by the first encrypted environment", () => {
  const first = cipher();
  const envelope = first.encrypt(exportNanfuEnvironment(profile(), new Map(), "2026-10-29T00:00:00.000Z"));
  const second = new NanfuSyncCipher("correct horse battery staple");
  expect(second.decrypt<NanfuEnvironmentConfig>(envelope).id).toBe("p1");
  expect(second.keyParams().salt).toBe(JSON.parse(envelope).salt);
});

test("sync planning prefers the higher version and treats a dirty tie as a local win", () => {
  const local: NanfuLocalRecord[] = [
    { id: "same", version: 3, envelope: "local", dirty: false },
    { id: "ahead", version: 4, envelope: "local", dirty: false },
    { id: "behind", version: 1, envelope: "local", dirty: false },
    { id: "dirty", version: 2, envelope: "local", dirty: true },
    { id: "conflict", version: 2, envelope: "local", dirty: true },
    { id: "fresh", version: 0, envelope: "local", dirty: true },
    { id: "gone", version: 5, envelope: "", dirty: true, deleted: true },
  ];
  const remote: NanfuRemoteRecord[] = [
    { id: "same", version: 3, updatedAt: "t3", envelope: "remote" },
    { id: "ahead", version: 4, updatedAt: "t4", envelope: "remote" },
    { id: "behind", version: 2, updatedAt: "t2", envelope: "remote" },
    { id: "dirty", version: 2, updatedAt: "t2", envelope: "remote" },
    { id: "conflict", version: 3, updatedAt: "t3", envelope: "remote" },
    { id: "gone", version: 5, updatedAt: "t5", envelope: "remote" },
    { id: "remote-only", version: 7, updatedAt: "t7", envelope: "remote" },
  ];
  const plan = planNanfuSync(local, remote);
  expect(plan.push.map((row) => row.id).sort()).toEqual(["conflict", "dirty", "fresh", "gone"]);
  expect(plan.pull.map((row) => row.id).sort()).toEqual(["behind", "remote-only"]);
  expect(plan.unchanged.sort()).toEqual(["ahead", "same"]);
  expect(plan.conflicts).toEqual(["conflict"]);
});

test("the client talks to PostgREST with the anon key and the user's bearer token", async () => {
  const seen: Array<{ url: string; headers: Headers }> = [];
  const client = new NanfuSyncClient({
    baseUrl: "https://nanfu.supabase.co",
    anonKey: "anon-key",
    accessToken: async () => "access-token",
    fetchFn: async (url, init) => {
      seen.push({ url: String(url), headers: new Headers(init?.headers) });
      return Response.json([{ environment_id: "p1", version: 2, updated_at: "2026-10-29T00:00:00Z", payload: "env", deleted: false }]);
    },
  });
  const rows = await client.list("user-uuid");
  expect(rows).toEqual([{ id: "p1", version: 2, updatedAt: "2026-10-29T00:00:00Z", envelope: "env" }]);
  expect(seen[0]?.url).toContain("https://nanfu.supabase.co/rest/v1/nanfu_environments?");
  expect(seen[0]?.url).toContain("owner_user_id=eq.user-uuid");
  expect(seen[0]?.headers.get("apikey")).toBe("anon-key");
  expect(seen[0]?.headers.get("authorization")).toBe("Bearer access-token");
});

test("upsert asks for a merge and stores the next version", async () => {
  let body: any;
  const upsert: { prefer: string | null } = { prefer: null };
  const client = new NanfuSyncClient({
    baseUrl: "https://nanfu.supabase.co",
    anonKey: "anon-key",
    accessToken: async () => "access-token",
    fetchFn: async (url, init) => {
      expect(String(url)).toContain("on_conflict=owner_user_id,environment_id");
      upsert.prefer = new Headers(init?.headers).get("prefer");
      body = JSON.parse(String(init?.body));
      return Response.json([{ environment_id: "p1", version: 4, updated_at: "2026-10-29T01:00:00Z", payload: body[0].payload }]);
    },
  });
  const stored = await client.upsert("user-uuid", "device-1", { id: "p1", version: 3, envelope: "ciphertext", dirty: true });
  expect(upsert.prefer).toBe("resolution=merge-duplicates,return=representation");
  expect(body).toEqual([{
    owner_user_id: "user-uuid",
    environment_id: "p1",
    version: 4,
    device_id: "device-1",
    payload: "ciphertext",
    deleted: false,
  }]);
  expect(stored.version).toBe(4);
});

test("sync refuses to run without a session and never calls the network", async () => {
  const client = new NanfuSyncClient({
    baseUrl: "https://nanfu.supabase.co",
    anonKey: "anon-key",
    accessToken: async () => undefined,
    fetchFn: async () => {
      throw new Error("must not be called");
    },
  });
  const failure = client.list("user-uuid");
  await expect(failure).rejects.toBeInstanceOf(NanfuSyncError);
  await failure.catch((error: NanfuSyncError) => {
    expect(error.unauthorized).toBe(true);
  });
});

test("sync validates pulled payloads and records pushed versions", async () => {
  const localCipher = cipher();
  const remoteA = localCipher.encrypt(exportNanfuEnvironment(
    profile({ id: "a", name: "Remote A" }),
    new Map(),
    "2026-10-29T00:00:00.000Z",
  ));
  const localB = localCipher.encrypt(exportNanfuEnvironment(
    profile({ id: "b", name: "Local B" }),
    new Map(),
    "2026-10-29T00:00:00.000Z",
  ));
  const client = new NanfuSyncClient({
    baseUrl: "https://nanfu.supabase.co",
    anonKey: "anon-key",
    accessToken: async () => "access-token",
    fetchFn: async (url, init) => {
      if (init?.method === "GET") {
        return Response.json([{ environment_id: "a", version: 2, updated_at: "2026-10-29T02:00:00Z", payload: remoteA, deleted: false }]);
      }
      const body = JSON.parse(String(init?.body));
      return Response.json([{
        environment_id: body[0].environment_id,
        version: body[0].version,
        updated_at: "2026-10-29T03:00:00Z",
        payload: body[0].payload,
        deleted: false,
      }]);
    },
  });
  const result = await syncNanfuEnvironments({
    local: [
      { id: "a", version: 1, envelope: remoteA, dirty: false },
      { id: "b", version: 0, envelope: localB, dirty: true },
    ],
    client,
    cipher: localCipher,
    userId: "user-uuid",
    deviceId: "device-1",
  });
  expect(result.pushed).toBe(1);
  expect(result.pulled).toBe(1);
  expect(result.conflicts).toEqual([]);
  const byId = new Map(result.state.map((row) => [row.id, row]));
  expect(byId.get("a")).toEqual({ id: "a", version: 2, envelope: remoteA, dirty: false });
  expect(byId.get("b")).toEqual({ id: "b", version: 1, envelope: localB, dirty: false });
});

test("sync aborts before marking a pulled environment clean when the passphrase is wrong", async () => {
  const remoteEnvelope = new NanfuSyncCipher("another passphrase", params).encrypt(
    exportNanfuEnvironment(profile({ id: "a" }), new Map(), "2026-10-29T00:00:00.000Z"),
  );
  const client = new NanfuSyncClient({
    baseUrl: "https://nanfu.supabase.co",
    anonKey: "anon-key",
    accessToken: async () => "access-token",
    fetchFn: async () => Response.json([
      { environment_id: "a", version: 2, updated_at: "2026-10-29T02:00:00Z", payload: remoteEnvelope, deleted: false },
    ]),
  });
  await expect(syncNanfuEnvironments({
    local: [{ id: "a", version: 1, envelope: remoteEnvelope, dirty: false }],
    client,
    cipher: cipher(),
    userId: "user-uuid",
    deviceId: "device-1",
  })).rejects.toBeInstanceOf(NanfuSyncDecryptError);
});

test("visible metadata pages across owners without expanding personal sync", async () => {
  const requests: URL[] = [];
  const client = new NanfuSyncClient({
    baseUrl: "https://nanfu.test", anonKey: "anon-key", accessToken: async () => "synthetic-jwt",
    fetchFn: async (url, init) => {
      const query = new URL(String(url));
      requests.push(query);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-jwt");
      if (query.searchParams.has("owner_user_id")) return Response.json([]);
      const offset = Number(query.searchParams.get("offset"));
      return Response.json(Array.from({ length: offset === 0 ? 500 : 1 }, (_, i) => ({
        environment_id: `env-${offset + i}`, owner_user_id: "group-owner", org_id: "org-1", group_id: "granted",
        version: 2, updated_at: "2026-10-29T00:00:00Z", payload: "must-not-be-returned",
      })));
    },
  });
  const visible = await client.visibleEnvironments("org-1");
  expect(visible).toHaveLength(501);
  expect(visible[500]).toMatchObject({ id: "env-500", ownerUserId: "group-owner", groupId: "granted", orgId: "org-1" });
  expect(JSON.stringify(visible)).not.toContain("must-not-be-returned");
  for (const request of requests) {
    expect(request.searchParams.has("owner_user_id")).toBe(false);
    expect(request.searchParams.get("org_id")).toBe("eq.org-1");
    expect(request.searchParams.get("deleted")).toBe("eq.false");
    expect(request.searchParams.get("select")).not.toContain("payload");
  }
  await client.list("self");
  expect(requests.at(-1)!.searchParams.get("owner_user_id")).toBe("eq.self");
  expect(requests.at(-1)!.searchParams.has("org_id")).toBe(false);
  expect(requests.at(-1)!.searchParams.get("select")).toContain("payload");
});

test("organization queries preserve quota and lock metadata without fetching a disabled organization", async () => {
  const requests: string[] = [];
  const client = new NanfuSyncClient({
    baseUrl: "https://nanfu.test", anonKey: "anon-key", accessToken: async () => "synthetic-jwt",
    fetchFn: async url => {
      requests.push(String(url));
      return Response.json([{ org_id: "org-1", identity: "member", status: "disabled", locked: false, role_name: null, env_quota: 2, used: 3, permissions: [] }]);
    },
  });
  expect(await client.orgMe()).toMatchObject({ orgId: "org-1", status: "disabled", quota: 2, used: 3, locked: false });
  expect(requests).toEqual(["https://nanfu.test/rest/v1/rpc/nanfu_org_me"]);
});

test("visible metadata rejects unexpected organization rows", async () => {
  const client = new NanfuSyncClient({
    baseUrl: "https://nanfu.test", anonKey: "anon-key", accessToken: async () => "synthetic-jwt",
    fetchFn: async () => Response.json([{ environment_id: "other", owner_user_id: "owner", org_id: "other-org" }]),
  });
  await expect(client.visibleEnvironments("org-1")).rejects.toBeInstanceOf(NanfuSyncError);
});

test("cancelling visible queries aborts the fetch and leaves personal sync usable", async () => {
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  let aborted = false;
  const client = new NanfuSyncClient({
    baseUrl: "https://nanfu.test", anonKey: "anon-key", accessToken: async () => "synthetic-jwt",
    fetchFn: async (url, init) => {
      if (new URL(String(url)).searchParams.has("owner_user_id")) return Response.json([]);
      return await new Promise<Response>((_, reject) => {
        init!.signal!.addEventListener("abort", () => { aborted = true; reject(new Error("cancelled")); }, { once: true });
        started();
      });

    },
  });
  const pending = client.visibleEnvironments("org-1");
  const settled = pending.then(() => null, (error: unknown) => error);
  await deadline(waiting, "visible request started");
  client.cancelVisibleRequests();
  expect(await deadline(settled, "cancelled visible request")).toBeInstanceOf(NanfuSyncError);
  expect(aborted).toBe(true);
  expect(await client.list("self")).toEqual([]);
});

test("organization overview only asks for columns the service actually exposes", async () => {
  const requests: URL[] = [];
  const client = new NanfuSyncClient({
    baseUrl: "https://nanfu.test", anonKey: "anon-key", accessToken: async () => "synthetic-jwt",
    fetchFn: async (url) => {
      const query = new URL(String(url));
      requests.push(query);
      if (query.pathname === "/rest/v1/rpc/nanfu_org_overview") {
        return Response.json([{ user_id: "user-1", email: "owner@fixture.test", identity: "owner", role_id: null, role_name: null,
          env_quota: 0, used: 3, status: "active", locked: false, manager_user_id: null }]);
      }
      if (query.pathname === "/rest/v1/nanfu_org_roles") return Response.json([{ id: "role-1", name: "运营", permissions: ["env.create", 7] }]);
      if (query.pathname === "/rest/v1/nanfu_org_groups") return Response.json([{ id: "group-1", name: "默认" }]);
      if (query.pathname === "/rest/v1/nanfu_org_group_grants") return Response.json([{ group_id: "group-1", user_id: "user-1" }]);
      if (query.pathname === "/rest/v1/nanfu_org_invites") return Response.json([{ code: "AAAA", identity: "member", expires_at: "2026-11-01T00:00:00Z", redeemed_by: null }]);
      return Response.json([]);
    },
  });
  const overview = await client.orgOverview("org-1");
  expect(overview.members).toEqual([{ userId: "user-1", email: "owner@fixture.test", identity: "owner", roleId: null, roleName: null,
    managerUserId: null, quota: 0, used: 3, status: "active", locked: false }]);
  expect(overview.roles[0]?.permissions).toEqual(["env.create"]);
  expect(overview.invites).toEqual([{ code: "AAAA", identity: "member", expiresAt: "2026-11-01T00:00:00Z", redeemedBy: null }]);
  const invites = requests.find((item) => item.pathname === "/rest/v1/nanfu_org_invites")!;
  expect(invites.searchParams.get("select")).toBe("code,identity,expires_at,redeemed_by");
  expect(invites.searchParams.get("order")).toBe("code.asc");
  expect(invites.searchParams.get("org_id")).toBe("eq.org-1");
  expect(requests.some((item) => item.pathname === "/rest/v1/nanfu_org_group_grants" && item.searchParams.get("order") === "group_id.asc,user_id.asc")).toBe(true);
  expect(JSON.stringify(overview)).not.toContain("payload");
});

test("organization calls reject malformed service results and keep known refusal codes", async () => {
  let refusal: { status: number; body: unknown } | null = null;
  const client = new NanfuSyncClient({
    baseUrl: "https://nanfu.test", anonKey: "anon-key", accessToken: async () => "synthetic-jwt",
    fetchFn: async () => (refusal ? Response.json(refusal.body, { status: refusal.status }) : Response.json("synthetic-org")),
  });
  expect(await client.createOrg("合成组织")).toBe("synthetic-org");
  refusal = { status: 400, body: { code: "P0001", message: "NANFU_FORBIDDEN: this account already belongs to an organization" } };
  await expect(client.createOrg("合成组织")).rejects.toMatchObject({ code: "ORG_ALREADY_MEMBER", status: 400 });
  refusal = { status: 400, body: { code: "P0001", message: "this invite has expired" } };
  await expect(client.redeemInvite("AAAA")).rejects.toMatchObject({ code: "INVITE_EXPIRED" });
  refusal = { status: 400, body: { code: "P0001", message: "this invite does not exist" } };
  await expect(client.redeemInvite("AAAA")).rejects.toMatchObject({ code: "P0002" });
  refusal = { status: 400, body: { code: "P0001", message: "this transfer has expired" } };
  await expect(client.forceTransfer("env-1", "00000000-0000-4000-8000-000000000002", "note")).rejects.toMatchObject({ code: "TRANSFER_EXPIRED" });
  refusal = null;
  await expect(client.removeMember("00000000-0000-4000-8000-000000000002", true)).rejects.toBeInstanceOf(NanfuSyncError);
});

test("organization mutations validate input before reaching the service", async () => {
  const calls: string[] = [];
  const client = {
    createOrg: async (name: string) => { calls.push(`create:${name}`); return "org-1"; },
    setQuota: async (userId: string, quota: number) => { calls.push(`quota:${userId}:${quota}`); },
    createRole: async (name: string, permissions: string[]) => { calls.push(`role:${name}:${permissions.join("|")}`); return "role-1"; },
  } as unknown as NanfuSyncClient;
  expect(await mutateNanfuOrganization(client, "create-organization", { name: " 合成组织 " })).toEqual({ orgId: "org-1" });
  expect(await mutateNanfuOrganization(client, "set-quota", { userId: "00000000-0000-4000-8000-000000000001", quota: 5 })).toEqual({});
  expect(await mutateNanfuOrganization(client, "create-role", { name: "运营", permissions: ["env.create", "env.create"] })).toEqual({ roleId: "role-1" });
  expect(calls).toEqual(["create:合成组织", "quota:00000000-0000-4000-8000-000000000001:5", "role:运营:env.create"]);
  expect(NANFU_ORGANIZATION_ACTIONS).toContain("remove-member");
  await expect(mutateNanfuOrganization(client, "create-organization", { name: "   " })).rejects.toBeInstanceOf(NanfuInputError);
  await expect(mutateNanfuOrganization(client, "create-organization", "not-an-object")).rejects.toBeInstanceOf(NanfuInputError);
  await expect(mutateNanfuOrganization(client, "set-quota", { userId: "not-a-uuid", quota: 5 })).rejects.toBeInstanceOf(NanfuInputError);
  await expect(mutateNanfuOrganization(client, "set-quota", { userId: "00000000-0000-4000-8000-000000000001", quota: 1.5 })).rejects.toBeInstanceOf(NanfuInputError);
  await expect(mutateNanfuOrganization(client, "create-role", { name: "x", permissions: ["delete.everything"] })).rejects.toBeInstanceOf(NanfuInputError);
  await expect(mutateNanfuOrganization(client, "create-invite", { identity: "member", quota: 0, hours: 0 })).rejects.toBeInstanceOf(NanfuInputError);
  await expect(mutateNanfuOrganization(client, "grant-group", { groupId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002", granted: "yes" })).rejects.toBeInstanceOf(NanfuInputError);
  expect(calls).toHaveLength(3);
});

test("organization failures become fixed copy that never repeats the service text", () => {
  expect(nanfuOrganizationError(new NanfuSyncError("upstream detail", 400, false, "ORG_ALREADY_MEMBER")))
    .toEqual({ status: 403, body: { ok: false, error: "当前账号已属于组织，不能重复创建或加入组织。", code: "ORG_ALREADY_MEMBER" } });
  expect(nanfuOrganizationError(new NanfuSyncError("upstream detail", 400, false, "NANFU_ORG_QUOTA")).status).toBe(409);
  expect(nanfuOrganizationError(new NanfuSyncError("upstream detail", 404, false, "P0002")).status).toBe(409);
  expect(nanfuOrganizationError(new NanfuSyncError("upstream detail", 401, true))).toEqual({ status: 401, body: { ok: false, error: "请重新登录南孚账号。" } });
  expect(nanfuOrganizationError(new NanfuSyncError("upstream detail", 503, false)))
    .toEqual({ status: 503, body: { ok: false, error: expect.stringContaining("操作结果未确认"), retryable: true } });
  expect(JSON.stringify(nanfuOrganizationError(new NanfuSyncError("upstream detail", 500, false)))).not.toContain("upstream detail");
});

test("self-join calls the default organization RPC with an empty body", async () => {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const client = new NanfuSyncClient({
    baseUrl: "https://nanfu.test",
    anonKey: "anon-key",
    accessToken: async () => "synthetic-jwt",
    fetchFn: async (url, init) => {
      seen.push({ url: String(url), init });
      return Response.json("org-default");
    },
  });
  expect(await client.selfJoinOrg()).toBe("org-default");
  expect(seen[0]?.url).toBe("https://nanfu.test/rest/v1/rpc/nanfu_org_self_join");
  expect(seen[0]?.init?.method).toBe("POST");
  expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({});

  const malformed = new NanfuSyncClient({
    baseUrl: "https://nanfu.test", anonKey: "anon-key", accessToken: async () => "synthetic-jwt",
    fetchFn: async () => Response.json({ org_id: "org-default" }),
  });
  await expect(malformed.selfJoinOrg()).rejects.toMatchObject({ message: "Invalid operation response", status: 502 });
});

test("transfer RPCs normalise their input and call the documented functions", async () => {
  const target = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const transferId = "11111111-2222-3333-4444-555555555555";
  const calls: Array<{ path: string; body: unknown }> = [];
  const client = new NanfuSyncClient({
    baseUrl: "https://nanfu.test", anonKey: "anon-key", accessToken: async () => "synthetic-jwt",
    fetchFn: async (url, init) => {
      const path = String(url).replace("https://nanfu.test/rest/v1", "");
      calls.push({ path, body: JSON.parse(String(init?.body ?? "null")) });
      if (path === "/rpc/nanfu_env_transfer_request") return Response.json(transferId);
      if (path === "/rpc/nanfu_env_transfer_respond") {
        return Response.json(JSON.parse(String(init?.body)).p_accept ? "accepted" : "rejected");
      }
      if (path === "/rpc/nanfu_env_transfer_batch") return Response.json(3);
      if (path === "/rpc/nanfu_env_transfer_force") return Response.json(1);
      throw new Error(`unexpected ${path}`);
    },
  });
  expect(await client.requestTransfer("  env-1  ", target)).toBe(transferId);
  expect(await client.respondTransfer(transferId, true)).toBe("accepted");
  expect(await client.respondTransfer(transferId, false)).toBe("rejected");
  expect(await client.batchTransfer(["env-1", "env-1", " env-2 "], target, "交接")).toBe(3);
  expect(await client.forceTransfer("env-2", target, "管理员调整")).toBe(1);
  expect(calls).toEqual([
    { path: "/rpc/nanfu_env_transfer_request", body: { p_environment_id: "env-1", p_to: target } },
    { path: "/rpc/nanfu_env_transfer_respond", body: { p_id: transferId, p_accept: true } },
    { path: "/rpc/nanfu_env_transfer_respond", body: { p_id: transferId, p_accept: false } },
    { path: "/rpc/nanfu_env_transfer_batch", body: { p_environment_ids: ["env-1", "env-2"], p_to: target, p_note: "交接" } },
    { path: "/rpc/nanfu_env_transfer_force", body: { p_environment_id: "env-2", p_to: target, p_note: "管理员调整" } },
  ]);
});

test("transfer requests reject bad identifiers before touching the network", async () => {
  const client = new NanfuSyncClient({
    baseUrl: "https://nanfu.test", anonKey: "anon-key", accessToken: async () => "synthetic-jwt",
    fetchFn: async () => { throw new Error("must not be called"); },
  });
  const target = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  await expect(client.requestTransfer("", target)).rejects.toBeInstanceOf(NanfuSyncError);
  await expect(client.requestTransfer("env", "not-a-uuid")).rejects.toThrow("接收成员编号无效");
  await expect(client.respondTransfer("nope", true)).rejects.toThrow("转移记录编号无效");
  await expect(client.batchTransfer([], target)).rejects.toThrow("请选择要转移的环境");
  await expect(client.batchTransfer(Array.from({ length: 201 }, (_, index) => `env-${index}`), target))
    .rejects.toThrow("一次最多转移200个环境");
  await expect(client.forceTransfer("env", target, "x".repeat(501))).rejects.toThrow("备注最多500个字符");
});

test("a forbidden transfer surfaces the server code and never retries", async () => {
  let calls = 0;
  const client = new NanfuSyncClient({
    baseUrl: "https://nanfu.test", anonKey: "anon-key", accessToken: async () => "synthetic-jwt",
    fetchFn: async () => {
      calls += 1;
      return Response.json(
        { code: "42501", message: "NANFU_FORBIDDEN: only the owner or an administrator can force a transfer" },
        { status: 403 },
      );
    },
  });
  const failure = client.forceTransfer("env-1", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "");
  await expect(failure).rejects.toBeInstanceOf(NanfuSyncError);
  await failure.catch((error: NanfuSyncError) => {
    expect(error.status).toBe(403);
    expect(error.code).toBe("NANFU_FORBIDDEN");
    expect(error.unauthorized).toBe(true);
  });
  expect(calls).toBe(1);
});

test("the transfer inbox query selects metadata only and keeps the resolution time", async () => {
  const urls: URL[] = [];
  const client = new NanfuSyncClient({
    baseUrl: "https://nanfu.test", anonKey: "anon-key", accessToken: async () => "synthetic-jwt",
    fetchFn: async (url) => {
      urls.push(new URL(String(url)));
      return Response.json([{
        id: "t1", environment_id: "env-1", from_user_id: "u1", to_user_id: "u2", status: "accepted",
        forced: true, note: "handover", created_at: "2026-10-29T00:00:00Z", resolved_at: "2026-10-29T01:00:00Z",
      }]);
    },
  });
  expect(await client.transfers("org-1")).toEqual([{
    id: "t1", environmentId: "env-1", fromUserId: "u1", toUserId: "u2", status: "accepted",
    forced: true, note: "handover", createdAt: "2026-10-29T00:00:00Z", resolvedAt: "2026-10-29T01:00:00Z",
  }]);
  expect(urls[0]?.pathname).toBe("/rest/v1/nanfu_env_transfers");
  expect(urls[0]?.searchParams.get("select")).toContain("resolved_at");
  expect(urls[0]?.searchParams.get("select")).not.toContain("payload");
  expect(urls[0]?.searchParams.get("org_id")).toBe("eq.org-1");
});
