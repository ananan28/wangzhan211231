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
  expect(await client.organization()).toMatchObject({ orgId: "org-1", status: "disabled", quota: 2, used: 3, locked: false });
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
