import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileStore } from "./store.ts";
import { buildNewProfile } from "./create.ts";
import { deriveFingerprintFlags } from "./fingerprint.ts";
import { handleUiRequest } from "./ui.ts";
import { Launcher, type LauncherOptions } from "./launcher.ts";

async function withCloneFixture(run: (fixture: {
  store: ProfileStore; launcher: Launcher; source: ReturnType<typeof buildNewProfile>; root: string;
}) => Promise<void>, overrides: Partial<LauncherOptions> = {}) {
  const store = new ProfileStore(":memory:");
  const root = mkdtempSync(join(tmpdir(), "nanfu-clone-"));
  try {
    const profile = buildNewProfile({
      name: "合成测试窗口", engine: "chromium", chromiumRuntime: "cloakbrowser",
      locale: "zh-CN", timezone: "Asia/Shanghai", platform: "example.test",
      proxy: { type: "http", host: "proxy.example.test", port: "8080", user: "fixture", pass: "fixture" },
    }, () => false);
    profile.cookies = [{ name: "synthetic", value: "fixture-only", domain: "example.test", path: "/" }];
    profile.extensions = ["synthetic-extension"];
    profile.tags = ["测试"];
    delete profile.timezoneManual;
    store.upsertProfile(profile);
    const launcher = new Launcher({ store, dataRoot: root, findProfileDirHolderPids: async () => [], ...overrides });
    await run({ store, root, launcher, source: store.getProfile(profile.id)! });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function cloneRequest(body: unknown) {
  return new Request("http://localhost/ui/api/profiles/clone", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

function cloneTarget(source: ReturnType<typeof buildNewProfile>) {
  return { ...structuredClone(source), id: "clone123", name: `${source.name} 副本`, fingerprintSeed: source.fingerprintSeed + 1 };
}

for (const pending of [true, false]) {
  test(`clone retains native extension data and ${pending ? "pending" : "saved"} snapshots with a new identity`, async () => {
    await withCloneFixture(async ({ store, launcher, source }) => {
      const bundle = JSON.stringify({ cookies: source.cookies, origins: [], tabs: [{ url: "https://example.test/fixture" }] });
      if (pending) store.upsertProfiles([source], new Map([[source.id, bundle]]));
      else store.saveSessionBundle(source.id, bundle);
      const dir = launcher.userDataDir(source.id);
      const extension = join(dir, "Default", "Local Extension Settings", "synthetic-extension");
      mkdirSync(extension, { recursive: true });
      writeFileSync(join(extension, "fixture.log"), "synthetic extension state");
      const bookmarks = JSON.stringify({ roots: { bookmark_bar: { children: [
        { name: "合成书签", type: "url", url: "https://example.test/bookmark" },
      ], name: "Bookmarks bar", type: "folder" } }, version: 1 });
      writeFileSync(join(dir, "Default", "Bookmarks"), bookmarks);
      writeFileSync(join(dir, "Local State"), "synthetic key metadata");
      writeFileSync(join(dir, "SingletonLock"), "stale fixture lock");
      const response = await handleUiRequest(cloneRequest({ ids: [source.id, source.id] }), launcher, store, null);
      expect(response!.status).toBe(200);
      const result = await response!.json();
      expect(result.failed).toEqual([]);
      expect(result.created).toHaveLength(1);
      const clone = store.getProfile(result.created[0].id)!;
      expect(clone.id).not.toBe(source.id);
      expect(clone.fingerprintSeed).not.toBe(source.fingerprintSeed);
      expect(clone.name).toBe(`${source.name} 副本`);
      expect(clone.chromiumRuntime).toBe(source.chromiumRuntime);
      expect(clone).toMatchObject({ cookies: source.cookies, proxy: source.proxy, extensions: source.extensions,
        tags: source.tags, locale: source.locale, timezone: source.timezone });
      expect(clone.timezoneManual).toBe(source.timezoneManual);
      expect(store.getSessionBundle(clone.id)).toBe(bundle);
      expect(store.getPendingSessionBundle(clone.id)).toBe(pending ? bundle : null);
      const clonedDir = launcher.userDataDir(clone.id);
      expect(readFileSync(join(clonedDir, "Default", "Local Extension Settings", "synthetic-extension", "fixture.log"), "utf8"))
        .toBe("synthetic extension state");
      expect(readFileSync(join(clonedDir, "Local State"), "utf8")).toBe("synthetic key metadata");
      expect(readFileSync(join(clonedDir, "Default", "Bookmarks"), "utf8")).toBe(bookmarks);
      expect(readFileSync(join(dir, "Default", "Bookmarks"), "utf8")).toBe(bookmarks);
      expect(existsSync(join(clonedDir, "SingletonLock"))).toBe(false);
      expect(readFileSync(join(dir, "SingletonLock"), "utf8")).toBe("stale fixture lock");
    });
  });
}

test("clone blocks starts, deletion, and cache clears while the destination is unpublished", async () => {
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await withCloneFixture(async ({ store, launcher, source }) => {
    mkdirSync(launcher.userDataDir(source.id));
    const target = cloneTarget(source);
    const copying = launcher.cloneProfileData(source, target);
    try {
      await ready;
      expect(store.getProfile(target.id)).toBeNull();
      expect(launcher.profileDeletionBlocked(source.id)).toBe(true);
      expect(launcher.profileDeletionBlocked(target.id)).toBe(true);
      await expect(launcher.start(source.id)).rejects.toThrow("克隆");
      await expect(launcher.start(target.id)).rejects.toThrow("克隆");
      await expect(launcher.cloneProfileData(source, { ...target, id: "clone456" })).rejects.toThrow("正在使用");
      expect(await launcher.clearCache(source.id)).toEqual({ cleared: false, freedBytes: 0 });
      expect(launcher.removeUserDataDir(source.id)).toBe(false);
    } finally {
      release();
      await copying;
    }
    expect(store.getProfile(target.id)).not.toBeNull();
    expect(launcher.profileDeletionBlocked(source.id)).toBe(false);
  }, { findProfileDirHolderPids: async () => { entered(); await gate; return []; } });
});

test("clone never overwrites an existing destination directory", async () => {
  await withCloneFixture(async ({ store, launcher, source }) => {
    const target = cloneTarget(source);
    mkdirSync(launcher.userDataDir(target.id));
    const sentinel = join(launcher.userDataDir(target.id), "keep.txt");
    writeFileSync(sentinel, "existing user data");
    await expect(launcher.cloneProfileData(source, target)).rejects.toThrow();
    expect(readFileSync(sentinel, "utf8")).toBe("existing user data");
    expect(store.getProfile(target.id)).toBeNull();
    expect(store.isTrashed(target.id)).toBe(false);
  });
});

test("clone rejects links and removes only its newly allocated directory", async () => {
  await withCloneFixture(async ({ store, launcher, source, root }) => {
    const from = launcher.userDataDir(source.id);
    const outside = join(root, "outside");
    mkdirSync(from);
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "do not follow");
    symlinkSync(outside, join(from, "linked"), "junction");
    const target = cloneTarget(source);
    await expect(launcher.cloneProfileData(source, target)).rejects.toThrow();
    expect(existsSync(launcher.userDataDir(target.id))).toBe(false);
    expect(store.getProfile(target.id)).toBeNull();
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("do not follow");
  });
});

for (const holders of [null, [12345]]) {
  test(`clone refuses ${holders === null ? "unknown" : "live"} directory ownership`, async () => {
    await withCloneFixture(async ({ store, launcher, source }) => {
      mkdirSync(launcher.userDataDir(source.id));
      const target = cloneTarget(source);
      await expect(launcher.cloneProfileData(source, target)).rejects.toThrow("无法确认");
      expect(store.getProfile(target.id)).toBeNull();
      expect(existsSync(launcher.userDataDir(target.id))).toBe(false);
    }, { findProfileDirHolderPids: async () => holders });
  });
}

test("source changes during cloning cause rollback, not an inconsistent clone", async () => {
  let mutate!: () => void;
  await withCloneFixture(async ({ store, launcher, source }) => {
    mkdirSync(launcher.userDataDir(source.id));
    mutate = () => store.saveSessionBundle(source.id, '{"cookies":[],"origins":[],"tabs":[]}');
    const target = cloneTarget(source);
    await expect(launcher.cloneProfileData(source, target)).rejects.toThrow("发生变更");
    expect(store.getProfile(target.id)).toBeNull();
    expect(existsSync(launcher.userDataDir(target.id))).toBe(false);
  }, { findProfileDirHolderPids: async () => { mutate(); return []; } });
});

test("clone reports partial success without hiding valid copies", async () => {
  let sourceId = "";
  await withCloneFixture(async ({ store, launcher, source, root }) => {
    sourceId = source.id;
    mkdirSync(launcher.userDataDir(source.id));
    const response = await handleUiRequest(cloneRequest({ ids: [source.id, "missing"], copies: 2 }), launcher, store, null);
    const result = await response!.json();
    expect(result.created).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.skipped).toEqual([{ id: "missing", reason: "not-found" }]);
    expect(store.listProfiles()).toHaveLength(2);
    expect(readdirSync(root)).toHaveLength(2);
    expect(store.getProfile(result.created[0].id)).not.toBeNull();
  }, { findProfileDirHolderPids: (() => {
    let calls = 0;
    return async (dir) => { expect(dir.endsWith(sourceId)).toBe(true); return ++calls === 1 ? [] : null; };
  })() });
});

test("clone validates input and respects the Nanfu sign-in gate", async () => {
  await withCloneFixture(async ({ store, launcher, source }) => {
    for (const body of [null, {}, { ids: [42] }, { ids: [source.id], copies: 0 }, { ids: [source.id], copies: 21 }]) {
      expect((await handleUiRequest(cloneRequest(body), launcher, store, null))!.status).toBe(400);
    }
    const denied = await handleUiRequest(cloneRequest({ ids: [source.id] }), launcher, store, null,
      { nanfu: { account: { state: () => ({ authenticated: false }) } } } as never);
    expect(denied!.status).toBe(401);
    const crossOrigin = cloneRequest({ ids: [source.id] });
    crossOrigin.headers.set("origin", "https://other.example.test");
    expect((await handleUiRequest(crossOrigin, launcher, store, null))!.status).toBe(403);
    expect(store.listProfiles()).toHaveLength(1);
  });
});

test("startup waits past a blank tab for native restore before deduplicating URLs", async () => {
  let probes = 0;
  await withCloneFixture(async ({ launcher }) => {
    const open = await (launcher as any).restoredPageUrls(12345, 500);
    expect(probes).toBe(2);
    expect(open).toEqual(["https://example.test/account"]);
    expect((launcher as any).startupUrlsToOpen([
      "https://example.test/", "https://example.test/account#section", "https://example.test/new",
      "https://example.test/new", "https://other.example.test/",
    ], open)).toEqual(["https://example.test/new", "https://other.example.test/"]);
  }, { fetch: async () => ({ ok: true, json: async () => [{ type: "page",
    url: ++probes === 1 ? "about:blank" : "https://example.test/account",
  }] }) });
});

test("startup with no restore wait probes once and still opens a fresh profile's URL", async () => {
  let probes = 0;
  await withCloneFixture(async ({ launcher }) => {
    const open = await (launcher as any).restoredPageUrls(12345, 0);
    expect(probes).toBe(1);
    expect(open).toEqual([]);
    expect((launcher as any).startupUrlsToOpen(["https://example.test/"], open)).toEqual(["https://example.test/"]);
  }, { fetch: async () => { probes++; return { ok: true, json: async () => [{ type: "page", url: "about:blank" }] }; } });
});

test("language, timezone, CPU and seed can be chosen at creation and edited afterwards", async () => {
  const store = new ProfileStore(":memory:");
  const root = mkdtempSync(join(tmpdir(), "nanfu-fingerprint-"));
  try {
    const created = buildNewProfile({
      name: "Fingerprint round trip", engine: "chromium", chromiumRuntime: "aliasmode",
      locale: "fr-FR", timezone: "Europe/Paris", cores: "6", seed: "123456",
    }, () => false);
    expect(created).toMatchObject({
      locale: "fr-FR", timezone: "Europe/Paris", timezoneManual: true,
      fingerprintSeed: 123456, hardware: { cores: 6 },
    });
    const flags = deriveFingerprintFlags(created, 64);
    expect(flags).toContain("--fingerprint=123456");
    expect(flags).toContain("--fingerprint-locale=fr-FR");
    expect(flags).toContain("--fingerprint-timezone=Europe/Paris");
    expect(flags).toContain("--fingerprint-hardware-concurrency=6");
    store.upsertProfile(created);

    const response = await handleUiRequest(new Request(`http://x/ui/api/profiles/${created.id}/update`, {
      method: "POST", body: JSON.stringify({ set: { locale: "de-DE", cores: "8" } }),
    }), {} as never, store, null, { paths: { root } as never });
    expect(response!.status).toBe(200);

    const saved = store.getProfile(created.id)!;
    expect(saved).toMatchObject({ locale: "de-DE", timezone: "Europe/Paris", fingerprintSeed: 123456, hardware: { cores: 8 } });
    const edited = deriveFingerprintFlags(saved, 64);
    expect(edited).toContain("--fingerprint-locale=de-DE");
    expect(edited).toContain("--fingerprint-hardware-concurrency=8");

    const audit = readFileSync(join(root, "logs", "fingerprint-audit.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(audit.at(-1)).toMatchObject({
      profileId: created.id,
      changes: { locale: { from: "fr-FR", to: "de-DE" }, cores: { from: "6", to: "8" } },
    });
    expect(Object.keys(audit.at(-1).changes).sort()).toEqual(["cores", "locale"]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid creation-time fingerprint values are rejected instead of half-saved", () => {
  expect(() => buildNewProfile({ locale: "not a language tag" }, () => false)).toThrow();
  expect(() => buildNewProfile({ timezone: "Mars/Olympus" }, () => false)).toThrow();
  expect(() => buildNewProfile({ cores: "0" }, () => false)).toThrow();
  expect(() => buildNewProfile({ seed: "abc" }, () => false)).toThrow();
});

test("a typed timezone at creation survives a later proxy change", async () => {
  const store = new ProfileStore(":memory:");
  try {
    const created = buildNewProfile({ engine: "chromium", chromiumRuntime: "aliasmode", timezone: "Asia/Shanghai" }, () => false);
    store.upsertProfile(created);
    const response = await handleUiRequest(new Request(`http://x/ui/api/profiles/${created.id}/update`, {
      method: "POST", body: JSON.stringify({ set: { proxyType: "http", proxy: "new-proxy.example:8080" } }),
    }), {} as never, store, null, { timezoneFetch: async () => ({ json: async () => ({ status: "success", timezone: "Europe/Paris" }) }) } as never);
    expect(response!.status).toBe(200);
    expect(store.getProfile(created.id)!.timezone).toBe("Asia/Shanghai");
  } finally {
    store.close();
  }
});
