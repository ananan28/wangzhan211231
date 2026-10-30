import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadOrCreateTransferIdentity,
  openTransferPayload,
  openTransferPayloadForDevices,
  parseCloudTransferPayload,
} from "./nanfu-cloud-transfer.ts";
import { handleNanfuTransferRequest, type NanfuTransferRouteContext } from "./nanfu-transfer-routes.ts";
import type { NanfuRuntime } from "./nanfu-service.ts";
import { NanfuSyncError, type NanfuSyncClient } from "./nanfu-sync.ts";
import { statePaths } from "./paths.ts";
import { ProfileStore } from "./store.ts";
import type { LaunchInfo, Profile } from "./types.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const RECIPIENT_ID = "22222222-2222-4222-8222-222222222222";
const OUTBOUND = ["package-send", "package-upload"] as const;
type OutboundAction = typeof OUTBOUND[number];

function syntheticSession(value = "synthetic-old-session") {
  return {
    cookies: [{
      name: "auth_token", value, domain: ".example.test", path: "/",
      httpOnly: true, secure: true, sameSite: "None" as const, expires: 1_893_456_000,
      partitionKey: "https://partition.example.test", _crHasCrossSiteAncestor: true,
    }],
    origins: [{
      origin: "https://web.telegram.org",
      localStorage: [{ name: "dc2_auth_key", value: "synthetic-local-auth" }],
      indexedDB: [{
        name: "tt-passcode", version: 1,
        stores: [{
          name: "store", autoIncrement: false, indexes: [],
          records: [
            { key: "sessionEncrypted", valueEncoded: { synthetic: [1, 2, 3] } },
            { key: "globalEncrypted", value: "synthetic-encrypted-auth" },
          ],
        }],
      }],
    }],
    tabs: ["https://example.test/inbox", "https://example.test/inbox"],
    telegramClient: "k" as const,
  };
}

function syntheticProfile(): Profile {
  return {
    id: "cloud-safety", engine: "chromium", accId: "", name: "合成云端窗口", group: "",
    username: "", password: "", twofa: "", proxy: null, extensions: [], tags: [],
    ua: "Mozilla/5.0 Chrome/155.0.0.0", timezone: "Asia/Shanghai", locale: "zh-CN",
    screenWidth: 1920, screenHeight: 1080, fingerprintSeed: 12345,
    platform: "example.test", cookies: [], seeded: false,
  };
}

interface SentPackage {
  id: string;
  payload: string;
  environmentName: string;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "nanfu-cloud-safety-"));
  const store = new ProfileStore(":memory:");
  const profile = syntheticProfile();
  store.upsertProfile(profile);
  store.saveSessionBundle(profile.id, JSON.stringify(syntheticSession()));
  const identity = loadOrCreateTransferIdentity(root);
  const sent: SentPackage[] = [];
  let captures = 0;
  let accepted = 0;
  const client = {
    orgMe: async () => ({ orgId: "synthetic-org", identity: "member", status: "active", locked: false }),
    visibleEnvironments: async (): Promise<Array<{ id: string; ownerUserId: string }>> => [],
    orgOverview: async () => ({ members: [{
      userId: RECIPIENT_ID, email: "recipient@example.test", identity: "member", status: "active", locked: false,
    }] }),
    transferPublicKey: async () => identity.publicKey,
    publishDeviceKey: async () => {},
    deviceKeys: async () => [],
    sendCloudTransfer: async (input: SentPackage) => { sent.push(input); },
    upsertCloudPackage: async (input: SentPackage) => { sent.push(input); return input.id; },
    cloudTransferPayload: async (id: string) => ({
      payload: sent.find((item) => item.id === id)!.payload,
      row: { id, environmentId: profile.id, environmentName: profile.name, senderEmail: "sender@example.test",
        recipientEmail: "recipient@example.test", status: "pending", createdAt: new Date().toISOString(),
        expiresAt: "2099-01-01T00:00:00.000Z", acceptedAt: null },
    }),
    acceptCloudTransfer: async () => { accepted++; return { senderEmail: "sender@example.test" }; },
    cloudPackage: async (id: string) => ({
      row: { environmentName: "合成云端窗口" }, payload: sent.find((item) => item.id === id)!.payload,
    }),
  };
  const context: NanfuTransferRouteContext = {
    store, paths: statePaths(root),
    nanfu: {
      account: { state: () => ({ authenticated: true, userId: USER_ID, email: "sender@example.test" }) },
      client: client as unknown as NanfuSyncClient,
    } as unknown as NanfuRuntime,
  };
  const launch: LaunchInfo = {
    profileId: profile.id, engine: "chromium", pid: 123, debugPort: 9222,
    startedAt: 1, ws: "ws://127.0.0.1:9222/devtools/browser/synthetic-generation-1",
  };
  return {
    store, root, profile, client, context, sent, launch,
    get captures() { return captures; },
    get accepted() { return accepted; },
    capture(fn: () => Promise<boolean>) {
      context.launcher = { captureLocalSession: async (id) => {
        expect(id).toBe(profile.id);
        captures++;
        return fn();
      } };
    },
    async request(action: string, body: unknown = { environmentId: profile.id, toUserId: RECIPIENT_ID }) {
      return handleNanfuTransferRequest(new Request(`http://local/ui/api/nanfu-transfer/${action}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }), context);
    },
    opened(action: OutboundAction) {
      expect(sent).toHaveLength(1);
      const item = sent[0]!;
      return parseCloudTransferPayload(action === "package-send"
        ? openTransferPayload(identity, item.payload, item.id)
        : openTransferPayloadForDevices(identity, item.payload, item.id));
    },
    async dispose() {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("accepted transfer retries after local write failure and never imports twice", async () => {
  await withFixture(async (f) => {
    expect((await f.request("package-send")).status).toBe(200);
    const id = f.sent[0]!.id;
    const complete = f.store.completeNanfuTransfer.bind(f.store);
    f.store.completeNanfuTransfer = () => { throw new Error("synthetic disk failure"); };
    expect((await f.request("package-accept", { id })).status).not.toBe(200);
    expect(f.accepted).toBe(1);
    expect(f.store.listProfiles()).toHaveLength(1);
    const staged = f.store.getNanfuTransferReceipt(USER_ID, id)!;
    expect(staged.resultJson).toBeNull();
    expect(staged.sealedPayload).toBe(f.sent[0]!.payload);
    expect(staged.sealedPayload).not.toContain("synthetic-old-session");
    expect(f.store.listPendingNanfuTransfers(USER_ID)).toHaveLength(1);
    f.client.cloudTransferPayload = async () => { throw new Error("accepted rows cannot be read"); };
    f.store.completeNanfuTransfer = complete;
    const response = await f.request("package-accept", { id });
    expect(response.status).toBe(200);
    const imported = await response.json();
    expect(f.store.listProfiles()).toHaveLength(2);
    expect(f.store.getPendingSessionBundle(imported.profileId)).toContain("synthetic-old-session");
    expect(f.store.getNanfuTransferReceipt(USER_ID, id)!.sealedPayload).toBe("");
    expect(f.store.listPendingNanfuTransfers(USER_ID)).toEqual([]);
    f.client.acceptCloudTransfer = async () => { throw new Error("must not acknowledge twice after local completion"); };
    const repeat = await f.request("package-accept", { id });
    expect(await repeat.json()).toEqual(imported);
    expect(f.store.listProfiles()).toHaveLength(2);
    expect(f.store.getNanfuTransferReceipt(RECIPIENT_ID, id)).toBeNull();
  });
});

test("uncertain remote acknowledgement retains ciphertext for safe retry", async () => {
  await withFixture(async (f) => {
    expect((await f.request("package-send")).status).toBe(200);
    const id = f.sent[0]!.id;
    const accept = f.client.acceptCloudTransfer;
    f.client.acceptCloudTransfer = async () => { throw new Error("synthetic lost response"); };
    expect((await f.request("package-accept", { id })).status).not.toBe(200);
    expect(f.store.getNanfuTransferReceipt(USER_ID, id)!.resultJson).toBeNull();
    expect(f.store.listProfiles()).toHaveLength(1);
    f.client.cloudTransferPayload = async () => { throw new Error("must use durable receipt"); };
    f.client.acceptCloudTransfer = accept;
    expect((await f.request("package-accept", { id })).status).toBe(200);
    expect(f.store.listProfiles()).toHaveLength(2);
  });
});

test("encrypted receipts survive reopening SQLite and complete atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "nanfu-receipt-"));
  let store = new ProfileStore(join(root, "store.db"));
  try {
    store.stageNanfuTransfer(USER_ID, "synthetic-transfer", "synthetic-ciphertext", '{"id":"synthetic-transfer"}');
    store.close();
    store = new ProfileStore(join(root, "store.db"));
    expect(store.getNanfuTransferReceipt(USER_ID, "synthetic-transfer")!.sealedPayload).toBe("synthetic-ciphertext");
    const profile = syntheticProfile();
    expect(() => store.completeNanfuTransfer(USER_ID, "synthetic-transfer", { ...profile, timezoneManual: false }, new Map(), "{}"))
      .toThrow();
    expect(store.getProfile(profile.id)).toBeNull();
    expect(store.getNanfuTransferReceipt(USER_ID, "synthetic-transfer")!.resultJson).toBeNull();
    const bundle = JSON.stringify(syntheticSession());
    store.completeNanfuTransfer(USER_ID, "synthetic-transfer", profile, new Map([[profile.id, bundle]]), '{"ok":true}');
    store.close();
    store = new ProfileStore(join(root, "store.db"));
    expect(store.getNanfuTransferReceipt(USER_ID, "synthetic-transfer")).toEqual({ sealedPayload: "", resultJson: '{"ok":true}' });
    expect(store.getPendingSessionBundle(profile.id)).toBe(bundle);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function withFixture(run: (f: Fixture) => Promise<void>) {
  const f = await fixture();
  try { await run(f); } finally { await f.dispose(); }
}

async function expectBlocked(f: Fixture, action: OutboundAction, status: number, message: RegExp) {
  const response = await f.request(action);
  expect(response.status).toBe(status);
  const body = await response.json() as any;
  expect(body).toMatchObject({ ok: false, retryable: true });
  expect(body.error).toMatch(message);
  expect(JSON.stringify(body)).not.toContain("synthetic-old-session");
  expect(f.sent).toEqual([]);
}

// All state, service doubles and capture callbacks belong to one fixture. No global/module mocks.
for (const action of OUTBOUND) {
  for (const failure of ["missing-launcher", "false", "throw"] as const) {
    test(`${action}: live capture ${failure} cannot send an older valid checkpoint`, async () => {
      await withFixture(async (f) => {
        f.store.recordLaunch(f.launch);
        if (failure !== "missing-launcher") f.capture(async () => {
          if (failure === "throw") throw new Error("synthetic-private-capture-detail");
          return false;
        });
        const before = f.store.getSessionBundle(f.profile.id);
        const response = await f.request(action);
        expect(response.status).toBe(409);
        const body = await response.json() as any;
        expect(body).toMatchObject({ ok: false, retryable: true });
        expect(body.error).toContain("重试");
        expect(body.error).not.toContain("synthetic-private-capture-detail");
        expect(f.sent).toEqual([]);
        expect(f.store.getSessionBundle(f.profile.id)).toBe(before);
      });
    });
  }

  test(`${action}: successful live capture sends fresh auth, not imported or saved cookies`, async () => {
    await withFixture(async (f) => {
      f.store.recordLaunch(f.launch);
      const fresh = syntheticSession("synthetic-fresh-session");
      f.capture(async () => {
        f.store.saveSessionBundle(f.profile.id, JSON.stringify(fresh));
        return true;
      });
      expect((await f.request(action)).status).toBe(200);
      expect(f.captures).toBe(1);
      expect(f.opened(action).transfer.session).toEqual(fresh);
      expect(f.sent[0]!.payload).not.toContain("synthetic-fresh-session");
    });
  });

  test(`${action}: an unchanged but successfully captured snapshot is still valid`, async () => {
    await withFixture(async (f) => {
      f.store.recordLaunch(f.launch);
      f.capture(async () => {
        f.store.saveSessionBundle(f.profile.id, JSON.stringify(syntheticSession()));
        return true;
      });
      expect((await f.request(action)).status).toBe(200);
      expect(f.opened(action).transfer.session).toEqual(syntheticSession());
    });
  });

  test(`${action}: capture success without a saved snapshot cannot fall back to profile cookies`, async () => {
    await withFixture(async (f) => {
      f.store.upsertProfile({ ...f.profile, cookies: syntheticSession().cookies });
      f.store.recordLaunch(f.launch);
      f.capture(async () => { f.store.saveSessionBundle(f.profile.id, ""); return true; });
      await expectBlocked(f, action, 409, /快照未保存/);
    });
  });

  for (const transition of ["close", "startedAt", "debugPort", "ws"] as const) {
    test(`${action}: ${transition} changing during capture rejects even a valid new snapshot`, async () => {
      await withFixture(async (f) => {
        f.store.recordLaunch(f.launch);
        f.capture(async () => {
          f.store.saveSessionBundle(f.profile.id, JSON.stringify(syntheticSession("synthetic-new-generation")));
          if (transition === "close") f.store.clearLaunch(f.profile.id);
          else f.store.recordLaunch({
            ...f.launch,
            ...(transition === "startedAt" ? { startedAt: 2 } : {}),
            ...(transition === "debugPort" ? { debugPort: 9333 } : {}),
            ...(transition === "ws" ? { ws: "ws://127.0.0.1:9222/devtools/browser/synthetic-generation-2" } : {}),
          });
          return true;
        });
        await expectBlocked(f, action, 409, /运行状态已变化/);
      });
    });
  }

  for (const running of [false, true]) {
    test(`${action}: ${running ? "live" : "closed"} generation is rechecked after packaging starts`, async () => {
      await withFixture(async (f) => {
        if (running) {
          f.store.recordLaunch(f.launch);
          f.capture(async () => true);
        }
        // Per-instance double: simulate a start/restart while collecting package inputs.
        f.store.listExtensions = () => {
          f.store.recordLaunch({ ...f.launch, startedAt: 2 });
          return [];
        };
        await expectBlocked(f, action, 409, /运行状态已变化/);
      });
    });
  }

  const invalidBundles = [
    ["broken JSON", "{synthetic-broken"],
    ["whitespace", "   "],
    ["null", "null"],
    ["array", "[]"],
    ["empty object", "{}"],
    ["missing cookies", JSON.stringify({ origins: [], tabs: [] })],
    ["wrong cookies", JSON.stringify({ cookies: {}, origins: [] })],
    ["wrong origins", JSON.stringify({ cookies: [], origins: {} })],
    ["bad cookie", JSON.stringify({ cookies: [{ name: "sid", value: "synthetic" }], origins: [] })],
    ["bad localStorage", JSON.stringify({ cookies: [], origins: [{ origin: "https://example.test", localStorage: [{ name: "token", value: 7 }] }] })],
    ["wrong tabs", JSON.stringify({ cookies: [], origins: [], tabs: [42] })],
    ["null tab", JSON.stringify({ cookies: [], origins: [], tabs: [null] })],
    ["internal tabs", JSON.stringify({ cookies: [], origins: [], tabs: ["chrome://extensions/"] })],
    ["wrong Telegram client", JSON.stringify({ cookies: [], origins: [], telegramClient: "other" })],
    ["invalid auth database", JSON.stringify({ cookies: [], origins: [{ origin: "https://web.telegram.org", localStorage: [], indexedDB: [{ name: "tt-passcode", version: 1, stores: [] }] }] })],
  ] as const;
  for (const [label, bundle] of invalidBundles) {
    for (const running of [false, true]) {
      test(`${action}: ${running ? "live" : "closed"} ${label} fails instead of silently normalizing`, async () => {
        await withFixture(async (f) => {
          f.store.upsertProfile({ ...f.profile, cookies: syntheticSession().cookies });
          f.store.saveSessionBundle(f.profile.id, bundle);
          if (running) {
            f.store.recordLaunch(f.launch);
            f.capture(async () => true);
          }
          await expectBlocked(f, action, 422, /快照已损坏或格式不受支持/);
        });
      });
    }
  }

  test(`${action}: a closed browser uses its saved auth unchanged and never captures`, async () => {
    await withFixture(async (f) => {
      f.capture(async () => { throw new Error("must not capture a closed browser"); });
      const response = await f.request(action);
      expect(response.status).toBe(200);
      expect((await response.json() as any).hasLoginState).toBe(true);
      expect(f.captures).toBe(0);
      expect(f.opened(action).transfer.session).toEqual(syntheticSession());
    });
  });

  test(`${action}: valid legacy cookie-only saved snapshots remain supported`, async () => {
    await withFixture(async (f) => {
      const cookies = syntheticSession().cookies;
      f.store.saveSessionBundle(f.profile.id, JSON.stringify({ cookies }));
      expect((await f.request(action)).status).toBe(200);
      expect(f.opened(action).transfer.session).toEqual({ cookies, origins: [], tabs: [] });
    });
  });

  test(`${action}: live capture must contain origins, not a legacy cookie-only shape`, async () => {
    await withFixture(async (f) => {
      f.store.recordLaunch(f.launch);
      f.capture(async () => {
        f.store.saveSessionBundle(f.profile.id, JSON.stringify({ cookies: syntheticSession().cookies }));
        return true;
      });
      await expectBlocked(f, action, 422, /快照已损坏或格式不受支持/);
    });
  });

  test(`${action}: origin-only auth remains login state without cookies`, async () => {
    await withFixture(async (f) => {
      const session = { ...syntheticSession(), cookies: [] };
      f.store.saveSessionBundle(f.profile.id, JSON.stringify(session));
      const response = await f.request(action);
      expect(response.status).toBe(200);
      expect((await response.json() as any).hasLoginState).toBe(true);
      expect(f.opened(action).transfer.session).toEqual(session);
    });
  });

  test(`${action}: only a closed browser without a snapshot uses valid imported cookies`, async () => {
    await withFixture(async (f) => {
      const cookies = syntheticSession().cookies;
      f.store.saveSessionBundle(f.profile.id, "");
      f.store.upsertProfile({ ...f.profile, cookies });
      const response = await f.request(action);
      expect(response.status).toBe(200);
      expect((await response.json() as any).hasLoginState).toBe(true);
      expect(f.opened(action).transfer.session).toEqual({ cookies, origins: [], tabs: [] });
    });
  });

  test(`${action}: malformed imported cookies fail schema validation`, async () => {
    await withFixture(async (f) => {
      f.store.saveSessionBundle(f.profile.id, "");
      f.store.upsertProfile({ ...f.profile, cookies: [{ name: "sid", value: "synthetic" }] as Profile["cookies"] });
      await expectBlocked(f, action, 422, /Cookie 格式无效/);
    });
  });

  for (const bundle of ["", JSON.stringify({ cookies: [], origins: [], tabs: [] })]) {
    test(`${action}: ${bundle ? "empty valid snapshot" : "no snapshot"} explicitly reports no login state`, async () => {
      await withFixture(async (f) => {
        f.store.saveSessionBundle(f.profile.id, bundle);
        // An explicit logged-out snapshot must win over older imported cookies.
        if (bundle) f.store.upsertProfile({ ...f.profile, cookies: syntheticSession().cookies });
        const response = await f.request(action);
        expect(response.status).toBe(200);
        const body = await response.json() as any;
        expect(body).toMatchObject({ ok: true, hasLoginState: false, cookies: 0, origins: 0 });
        expect(body.warning).toContain("不包含网站登录凭据");
        expect(f.opened(action).transfer.session.cookies).toEqual([]);
      });
    });
  }

  for (const missing of ["record", "directory"] as const) {
    test(`${action}: a referenced missing extension ${missing} blocks sending`, async () => {
      await withFixture(async (f) => {
        f.store.upsertProfile({ ...f.profile, extensions: ["missing-extension"] });
        if (missing === "directory") f.store.addExtension({
          id: "missing-extension", name: "合成扩展", loadDir: join(f.root, "does-not-exist"),
        });
        const response = await f.request(action);
        expect(response.status).toBe(404);
        expect((await response.json() as any).error).toContain("扩展");
        expect(f.sent).toEqual([]);
      });
    });
  }

  test(`${action}: existing extension files still travel with a valid session`, async () => {
    await withFixture(async (f) => {
      // This per-test directory contains only a synthetic extension manifest.
      const archiveRoot = await mkdtemp(join(f.root, "extension-"));
      const manifest = '{"manifest_version":3,"name":"Synthetic","version":"1.0"}';
      await writeFile(join(archiveRoot, "manifest.json"), manifest);
      f.store.addExtension({ id: "synthetic-extension", name: "Synthetic", loadDir: archiveRoot });
      f.store.upsertProfile({ ...f.profile, extensions: ["synthetic-extension"] });
      expect((await f.request(action)).status).toBe(200);
      const payload = f.opened(action);
      expect(payload.package.extensionArchives).toHaveLength(1);
      expect(Buffer.from(payload.package.extensionArchives[0]!.files[0]!.data, "base64").toString()).toBe(manifest);
      expect(payload.transfer.session).toEqual(syntheticSession());
    });
  });

  test(`${action}: tabs-only ${action === "package-send" ? "accept" : "download"} persists a pending session`, async () => {
    await withFixture(async (f) => {
      const session = { cookies: [], origins: [], tabs: ["https://example.test/a", "https://example.test/a"] };
      f.store.saveSessionBundle(f.profile.id, JSON.stringify(session));
      const outgoing = await f.request(action);
      expect(outgoing.status).toBe(200);
      const target = new ProfileStore(":memory:");
      try {
        f.context.store = target;
        const response = await f.request(action === "package-send" ? "package-accept" : "package-download", { id: f.sent[0]!.id });
        expect(response.status).toBe(200);
        const body = await response.json() as any;
        expect(body.hasLoginState).toBe(false);
        expect(target.getProfile(body.profileId)).not.toBeNull();
        const pending = target.getPendingSessionBundle(body.profileId);
        expect(pending).not.toBeNull();
        expect(JSON.parse(pending!)).toEqual(session);
        expect(target.getSessionBundle(body.profileId)).toBe(pending);
        expect(f.accepted).toBe(action === "package-send" ? 1 : 0);
      } finally { target.close(); }
    });
  });
}

test("package-send: a failed ownership lookup cannot authorize an unregistered local profile", async () => {
  await withFixture(async (f) => {
    f.client.visibleEnvironments = async () => { throw new NanfuSyncError("synthetic ownership failure", 503, false); };
    await expectBlocked(f, "package-send", 502, /服务暂时不可用/);
    expect(f.captures).toBe(0);
  });
});

test("package-send: a registered environment owned by another member is still forbidden", async () => {
  await withFixture(async (f) => {
    f.client.visibleEnvironments = async () => [{ id: f.profile.id, ownerUserId: RECIPIENT_ID }];
    const response = await f.request("package-send");
    expect(response.status).toBe(403);
    expect((await response.json() as any).ok).toBe(false);
    expect(f.sent).toEqual([]);
  });
});
