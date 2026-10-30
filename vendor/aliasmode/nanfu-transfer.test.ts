import { expect, test } from "bun:test";
import "./nanfu-cloud-safety.test.ts";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NanfuCipher, NanfuDecryptError, createNanfuKeyParams } from "./nanfu-crypto.ts";
import {
  NANFU_ENV_EXCLUDED,
  NANFU_ENV_VERSION,
  NanfuEnvPackageError,
  collectNanfuEnvFiles,
  createNanfuEnvPackage,
  nanfuEnvPackageFileName,
  parseNanfuEnvPackage,
  planNanfuEnvImport,
  writeNanfuEnvFiles,
} from "./nanfu-env-package.ts";
import { exportNanfuEnvironment } from "./nanfu-sync.ts";
import {
  NANFU_CLOUD_TRANSFER_FORMAT,
  NanfuCloudTransferError,
  buildCloudTransferPayload,
  createTransferIdentity,
  hasLoginState,
  loadOrCreateTransferIdentity,
  openTransferPayload,
  openTransferPayloadForDevices,
  parseCloudTransferPayload,
  sealTransferPayload,
  sealTransferPayloadForDevices,
} from "./nanfu-cloud-transfer.ts";
import { handleNanfuTransferRequest } from "./nanfu-transfer-routes.ts";
import { parseExport } from "./parse.ts";
import { statePaths } from "./paths.ts";
import { ProfileStore } from "./store.ts";
import type { NanfuCloudPackageRow, NanfuDeviceKeyRow, NanfuSyncClient } from "./nanfu-sync.ts";
import type { NanfuRuntime } from "./nanfu-service.ts";
import {
  NANFU_KERNEL_VERSION,
  NanfuTransferError,
  applyNanfuTransfer,
  buildNanfuTransfer,
  captureNanfuFromCdp,
  decryptNanfuTransfer,
  encryptNanfuTransfer,
  nanfuTransferFileName,
  type NanfuTransferPackage,
  type NanfuTransferTarget,
} from "./nanfu-transfer.ts";
import type { CookieRecord, Profile } from "./types.ts";

const params = createNanfuKeyParams(1024);
const cipher = () => new NanfuCipher("transfer passphrase", params);

const environment = exportNanfuEnvironment(
  {
    id: "k1abc",
    engine: "chromium",
    accId: "acc1",
    name: "Mail box",
    group: "Team",
    username: "account-user",
    password: "account-pass",
    twofa: "",
    proxy: { type: "http", host: "proxy.example", port: "8080", user: "proxy-user", pass: "proxy-pass" },
    extensions: [],
    ua: "Mozilla/5.0 Chrome/155",
    timezone: "UTC",
    screenWidth: 1920,
    screenHeight: 1080,
    fingerprintSeed: 99,
    cookies: [],
    seeded: false,
  } as unknown as Profile,
  new Map(),
  "2026-10-29T00:00:00.000Z",
);

const rawSession = {
  cookies: [
    {
      name: "sid",
      value: "cookie-secret",
      domain: ".example.com",
      path: "/",
      expires: 1_893_456_000,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
    { name: "theme", value: "dark", domain: "web.telegram.org", path: "/" },
  ],
  origins: [
    {
      origin: "https://web.telegram.org",
      localStorage: [{ name: "kz_version", value: "K" }],
      indexedDB: [
        { name: "tt-data", version: 1, stores: [{ name: "messages", records: [{ key: 1, value: "chat" }] }] },
        {
          name: "tweb-common",
          version: 1,
          stores: [
            { name: "session", records: [{ key: "dc", value: "auth" }] },
            { name: "localStorage__encrypted", records: [{ key: "data", value: "sealed" }] },
          ],
        },
      ],
    },
    {
      origin: "https://mail.example.com",
      localStorage: [{ name: "token", value: "local-secret" }],
      indexedDB: [{ name: "mail-cache", version: 1, stores: [] }],
    },
  ],
  tabs: ["https://mail.example.com/inbox"],
};

const capturedSession = {
  ...rawSession,
  origins: rawSession.origins.map(({ indexedDB, ...origin }) => ({
    ...origin,
    ...(origin.origin === "https://web.telegram.org" ? { indexedDB: indexedDB.filter((db) => db.name === "tweb-common").map((db) => ({
      ...db, stores: db.stores.map((store) => ({ ...store, autoIncrement: false, indexes: [] })),
    })) } : {}),
  })),
};

function packageWith(policy: "auth-only" | "all"): NanfuTransferPackage {
  return buildNanfuTransfer({
    environment,
    session: rawSession,
    serviceWorkers: [{ origin: "https://mail.example.com", caches: [{ name: "v1", entries: 12 }] }],
    extensionNames: ["ModHeader"],
    kernel: NANFU_KERNEL_VERSION,
    createdAt: "2026-10-29T02:00:00.000Z",
    indexedDB: policy,
  });
}

test("the default policy carries login state but drops chat IndexedDB", () => {
  const pkg = packageWith("auth-only");
  expect(pkg.session.cookies).toHaveLength(2);
  expect(pkg.session.cookies[0]?.httpOnly).toBe(true);
  expect(pkg.session.cookies[0]?.expires).toBe(1_893_456_000);
  expect(pkg.session.origins.map((origin) => origin.origin)).toEqual([
    "https://mail.example.com",
    "https://web.telegram.org",
  ]);
  const telegram = pkg.session.origins.find((origin) => origin.origin === "https://web.telegram.org");
  expect(telegram?.localStorage).toEqual([{ name: "kz_version", value: "K" }]);
  const databases = (telegram?.indexedDB ?? []) as Array<{ name: string; stores: Array<{ name: string }> }>;
  expect(databases.map((db) => db.name)).toEqual(["tweb-common"]);
  expect(databases[0]?.stores.map((store) => store.name)).toEqual(["session", "localStorage__encrypted"]);
  expect(pkg.session.origins.find((origin) => origin.origin === "https://mail.example.com")?.indexedDB).toBeUndefined();
  expect(JSON.stringify(pkg)).not.toContain("chat");
  expect(pkg.extensions).toEqual({ names: ["ModHeader"], archivesIncluded: false });
  expect(pkg.serviceWorkers).toEqual([{ origin: "https://mail.example.com", caches: [{ name: "v1", entries: 12 }] }]);
  expect(pkg.warnings).toEqual(["This file contains live login cookies for the exported environment."]);
});

test("the opt-in policy keeps every IndexedDB and says so", () => {
  const pkg = packageWith("all");
  const mail = pkg.session.origins.find((origin) => origin.origin === "https://mail.example.com");
  expect((mail?.indexedDB as any[]).map((db) => db.name)).toEqual(["mail-cache"]);
  const telegram = pkg.session.origins.find((origin) => origin.origin === "https://web.telegram.org");
  expect((telegram?.indexedDB as any[]).map((db) => db.name)).toEqual(["tt-data", "tweb-common"]);
  expect(pkg.storagePolicy).toBe("all");
  expect(pkg.warnings).toContain("Full site storage is included and may contain chat history or large caches.");
});

test("a package round-trips and never exposes plaintext secrets in the file", () => {
  const pkg = packageWith("auth-only");
  const envelope = encryptNanfuTransfer(pkg, cipher());
  expect(envelope).not.toContain("cookie-secret");
  expect(envelope).not.toContain("mail.example.com");
  const imported = decryptNanfuTransfer(envelope, cipher(), { kernel: NANFU_KERNEL_VERSION });
  expect(imported.package).toEqual(pkg);
  expect(imported.kernelMismatch).toBeUndefined();
  expect(imported.requiresAcknowledgement).toBe(true);
});

test("a wrong passphrase, a tampered payload and a foreign file are all rejected", () => {
  const envelope = encryptNanfuTransfer(packageWith("auth-only"), cipher());
  expect(() => decryptNanfuTransfer(envelope, new NanfuCipher("wrong passphrase", params)))
    .toThrow(NanfuDecryptError);

  const parsed = JSON.parse(envelope);
  const bytes = Buffer.from(parsed.ct, "base64");
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0x01;
  parsed.ct = bytes.toString("base64");
  expect(() => decryptNanfuTransfer(JSON.stringify(parsed), cipher())).toThrow(NanfuDecryptError);

  const foreign = cipher().encrypt({ hello: "world" });
  expect(() => decryptNanfuTransfer(foreign, cipher())).toThrow(NanfuTransferError);
});

test("a package from another kernel imports with an explicit warning, never silently", () => {
  const pkg = buildNanfuTransfer({
    environment,
    session: rawSession,
    kernel: "154.0.1-aliasmode.0",
    createdAt: "2026-10-29T02:00:00.000Z",
  });
  const imported = decryptNanfuTransfer(encryptNanfuTransfer(pkg, cipher()), cipher(), {
    kernel: NANFU_KERNEL_VERSION,
  });
  expect(imported.kernelMismatch).toEqual({ package: "154.0.1-aliasmode.0", current: NANFU_KERNEL_VERSION });
  expect(imported.requiresAcknowledgement).toBe(true);
  expect(imported.package.environment.id).toBe("k1abc");
});

test("applying a package restores cookies first, then per-origin storage", async () => {
  const pkg = packageWith("auth-only");
  const state = {
    order: [] as string[],
    cookies: [] as CookieRecord[],
    local: new Map<string, Array<{ name: string; value: string }>>(),
    indexedDB: new Map<string, unknown[]>(),
  };
  const target: NanfuTransferTarget = {
    addCookies: async (cookies) => {
      state.order.push("cookies");
      state.cookies.push(...cookies);
    },
    setLocalStorage: async (origin, entries) => {
      state.order.push(`local:${origin}`);
      state.local.set(origin, entries);
    },
    writeIndexedDB: async (origin, databases) => {
      state.order.push(`idb:${origin}`);
      state.indexedDB.set(origin, databases);
    },
  };
  const applied = await applyNanfuTransfer(pkg, target);
  expect(applied).toEqual({ cookies: 2, origins: 2, databases: 1 });
  expect(state.order).toEqual([
    "cookies",
    "local:https://mail.example.com",
    "local:https://web.telegram.org",
    "idb:https://web.telegram.org",
  ]);
  expect(state.cookies).toEqual(pkg.session.cookies);
  expect(state.local.get("https://mail.example.com")).toEqual([{ name: "token", value: "local-secret" }]);
  expect(state.indexedDB.get("https://web.telegram.org")).toEqual(
    pkg.session.origins.find((origin) => origin.origin === "https://web.telegram.org")?.indexedDB,
  );
});

test("the CDP capture reads cookies, storage and the cache manifest and reports unreadable origins", async () => {
  const calls: string[] = [];
  const cdp = {
    send: async (method: string, params?: any) => {
      calls.push(method);
      switch (method) {
        case "Storage.getCookies":
          return {
            cookies: [{
              name: "sid",
              value: "v",
              domain: ".example.com",
              path: "/",
              expires: 1_893_456_000,
              httpOnly: true,
              secure: true,
              sameSite: "None",
            }],
          };
        case "DOMStorage.getDOMStorageItems":
          if (params.storageId.securityOrigin === "https://blocked.example") throw new Error("no document");
          return { entries: [["theme", "dark"], ["lang", "en"]] };
        case "IndexedDB.requestDatabaseNames":
          return { databaseNames: ["mail"] };
        case "IndexedDB.requestDatabase":
          return { database: { version: 2, objectStores: [{ name: "store", keyPath: "id", autoIncrement: false, indexes: [] }] } };
        case "IndexedDB.requestData":
          return params.skipCount === 0
            ? { objectStoreDataEntries: [{ key: 1, value: "a" }, { key: 2, value: "b" }], hasMore: true }
            : { objectStoreDataEntries: [{ key: 3, value: "c" }], hasMore: false };
        case "CacheStorage.requestCacheNames":
          return { caches: [{ cacheId: "c1", cacheName: "v1" }] };
        case "CacheStorage.requestEntries":
          return { returnCount: 7 };
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
  };
  const captured = await captureNanfuFromCdp(cdp, {
    origins: ["https://mail.example.com", "https://blocked.example"],
    indexedDB: "all",
  });
  expect(calls).toContain("Storage.getCookies");
  expect(calls).not.toContain("Network.getAllCookies");
  expect(captured.cookies).toEqual([{
    name: "sid",
    value: "v",
    domain: ".example.com",
    path: "/",
    expires: 1_893_456_000,
    httpOnly: true,
    secure: true,
    sameSite: "None",
  }]);
  expect(captured.unreadableOrigins).toEqual(["https://blocked.example"]);
  const mail = captured.origins.find((origin) => origin.origin === "https://mail.example.com");
  expect(mail?.localStorage).toEqual([{ name: "theme", value: "dark" }, { name: "lang", value: "en" }]);
  const database = (mail?.indexedDB as any[])[0];
  expect(database.name).toBe("mail");
  expect(database.version).toBe(2);
  expect(database.stores[0].records).toEqual([{ key: 1, value: "a" }, { key: 2, value: "b" }, { key: 3, value: "c" }]);
  expect(captured.serviceWorkers).toEqual([
    { origin: "https://mail.example.com", caches: [{ name: "v1", entries: 7 }] },
    { origin: "https://blocked.example", caches: [{ name: "v1", entries: 7 }] },
  ]);
});

test("exported file names stay slugged and dated", () => {
  expect(nanfuTransferFileName("Work / Mail #2", "2026-10-29T02:00:00.000Z")).toBe("nanfu-work-mail-2-2026-10-29.nanfu");
  expect(nanfuTransferFileName("", "2026-10-29T02:00:00.000Z")).toBe("nanfu-environment-2026-10-29.nanfu");
});

function envPackage(environmentOverride: Record<string, unknown> = {}, options: { version?: number } = {}) {
  return createNanfuEnvPackage({
    environment: { ...environment, ...environmentOverride } as typeof environment,
    createdAt: "2026-10-29T02:00:00.000Z",
    ...options,
  });
}

const packageError = (text: string): NanfuEnvPackageError => {
  try {
    parseNanfuEnvPackage(text);
  } catch (error) {
    if (error instanceof NanfuEnvPackageError) return error;
    throw error;
  }
  throw new Error("expected the package to be rejected");
};

test("the .nanfu-env package carries configuration only and no login state", () => {
  const pkg = envPackage();
  expect(pkg.header.format).toBe("nanfu-env");
  expect(pkg.header.version).toBe(NANFU_ENV_VERSION);
  expect(pkg.header.signature.alg).toBe("sha256");
  expect(pkg.header.signature.value).toMatch(/^[0-9a-f]{64}$/);
  expect(pkg.excluded).toEqual([...NANFU_ENV_EXCLUDED]);
  expect(pkg.environment).not.toHaveProperty("cookies");
  expect(pkg.environment).not.toHaveProperty("username");
  expect(pkg.environment).not.toHaveProperty("password");
  const text = JSON.stringify(pkg);
  for (const secret of ["account-user", "account-pass", "cookie-secret"]) expect(text).not.toContain(secret);
  expect(text).not.toMatch(/"(cookies|localstorage|tokens?|password|twofa)"/i);
});

test("a .nanfu-env round-trips and rejects a version drift before verifying anything else", () => {
  const pkg = envPackage();
  expect(parseNanfuEnvPackage(JSON.stringify(pkg))).toEqual(pkg);

  const drifted = JSON.parse(JSON.stringify(pkg));
  drifted.header.version = NANFU_ENV_VERSION + 1;
  const error = packageError(JSON.stringify(drifted));
  expect(error.code).toBe("version");
  expect(error.message).toContain(String(NANFU_ENV_VERSION + 1));
  expect(error.message).toContain(String(NANFU_ENV_VERSION));

  expect(packageError("not json").code).toBe("format");
  expect(packageError(JSON.stringify({ header: { format: "other" } })).code).toBe("format");
});

test("a tampered .nanfu-env is rejected, and login-state fields are refused outright", () => {
  const pkg = envPackage();
  const renamed = JSON.parse(JSON.stringify(pkg));
  renamed.environment.name = "Renamed";
  expect(packageError(JSON.stringify(renamed)).code).toBe("signature");

  const withCookies = JSON.parse(JSON.stringify(pkg));
  withCookies.environment.cookies = [{ name: "sid", value: "cookie-secret" }];
  expect(packageError(JSON.stringify(withCookies)).code).toBe("login-state");

  expect(() => envPackage({ cookies: [{ name: "sid", value: "secret" }] })).toThrow(NanfuEnvPackageError);
});

test("importing never overwrites an existing environment", () => {
  const pkg = envPackage();
  const first = planNanfuEnvImport(pkg, { takenIds: ["k1abc"], takenNames: ["mail box"] });
  expect(first).toMatchObject({ id: "k1abc-2", name: "Mail box (导入)", renamed: true, originalId: "k1abc" });
  const second = planNanfuEnvImport(pkg, {
    takenIds: ["k1abc", "k1abc-2"], takenNames: ["mail box", "mail box (导入)"],
  });
  expect(second.id).toBe("k1abc-3");
  expect(second.name).toBe("Mail box (导入 2)");
  const free = planNanfuEnvImport(pkg, { takenIds: [], takenNames: [] });
  expect(free).toMatchObject({ id: "k1abc", name: "Mail box", renamed: false });
});

test("extension directories round-trip through a package into a fresh directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "nanfu-env-"));
  try {
    const source = join(root, "extension");
    await mkdir(join(source, "js"), { recursive: true });
    await writeFile(join(source, "manifest.json"), '{"manifest_version":3,"name":"Demo"}\n');
    await writeFile(join(source, "js", "background.js"), "console.log('ok')\n");
    const files = await collectNanfuEnvFiles(source);
    expect(files.map((file) => file.path)).toEqual(["js/background.js", "manifest.json"]);

    const pkg = createNanfuEnvPackage({ environment, extensionArchives: [{ name: "Demo", files }] });
    const parsed = parseNanfuEnvPackage(JSON.stringify(pkg));
    const archive = parsed.extensionArchives[0]!;
    const target = join(root, "restored");
    await writeNanfuEnvFiles(target, archive.files);
    expect(await readFile(join(target, "manifest.json"), "utf8")).toContain("Demo");
    expect(await readFile(join(target, "js", "background.js"), "utf8")).toContain("ok");

    await expect(writeNanfuEnvFiles(target, [])).rejects.toThrow();
    const escaped = { ...archive.files[0]!, path: "../evil.js" };
    await expect(writeNanfuEnvFiles(join(root, "escape"), [escaped])).rejects.toBeInstanceOf(NanfuEnvPackageError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("environment package file names stay slugged and dated", () => {
  expect(nanfuEnvPackageFileName("Work / Mail #2", "2026-10-29T02:00:00.000Z")).toBe("nanfu-work-mail-2-2026-10-29.nanfu-env");
  expect(nanfuEnvPackageFileName("邮箱", "2026-10-29T02:00:00.000Z")).toBe("nanfu-environment-2026-10-29.nanfu-env");
});

const cloudArchiveBytes = Buffer.from('{"manifest_version":3,"name":"Demo"}');
const cloudArchive = {
  name: "Demo",
  files: [{
    path: "manifest.json",
    size: cloudArchiveBytes.length,
    sha256: createHash("sha256").update(cloudArchiveBytes).digest("hex"),
    data: cloudArchiveBytes.toString("base64"),
  }],
};

function cloudPayload() {
  return buildCloudTransferPayload({
    environment,
    session: rawSession,
    extensionNames: ["Demo"],
    createdAt: "2026-10-30T01:00:00.000Z",
  });
}

test("a sealed payload opens only for the addressed key and the addressed transfer", () => {
  const recipient = createTransferIdentity();
  const stranger = createTransferIdentity();
  const id = "0b8f0a9e-4b1f-4c0a-9d78-7a4c1b2e3f40";
  const sealed = sealTransferPayload(recipient.publicKey, "hello", id);
  expect(sealed).not.toContain("hello");
  expect(openTransferPayload(recipient, sealed, id)).toBe("hello");
  expect(() => openTransferPayload(stranger, sealed, id)).toThrow(NanfuCloudTransferError);
  expect(() => openTransferPayload(recipient, sealed, "another-transfer")).toThrow(NanfuCloudTransferError);
});

test("a tampered or foreign sealed payload is rejected", () => {
  const recipient = createTransferIdentity();
  const id = "0b8f0a9e-4b1f-4c0a-9d78-7a4c1b2e3f40";
  const sealed = sealTransferPayload(recipient.publicKey, JSON.stringify(cloudPayload()), id);
  const parsed = JSON.parse(sealed);
  const bytes = Buffer.from(parsed.ct, "base64");
  bytes[0] = bytes[0]! ^ 0x01;
  parsed.ct = bytes.toString("base64");
  expect(() => openTransferPayload(recipient, JSON.stringify(parsed), id)).toThrow(NanfuCloudTransferError);
  expect(() => openTransferPayload(recipient, "not json", id)).toThrow(NanfuCloudTransferError);
});

test("the cloud payload carries configuration and login state without the password", () => {
  const built = cloudPayload();
  expect(built.format).toBe(NANFU_CLOUD_TRANSFER_FORMAT);
  expect(built.package.header.format).toBe("nanfu-env");
  expect(built.transfer.session.cookies).toHaveLength(2);
  expect(built.transfer.session.cookies[0]?.httpOnly).toBe(true);
  expect(built.transfer.environment.id).toBe("k1abc");
  expect(hasLoginState(built)).toBe(true);
  const telegram = built.transfer.session.origins.find((origin) => origin.origin === "https://web.telegram.org");
  expect((telegram?.indexedDB as any[]).map((db) => db.name)).toEqual(["tweb-common"]);
  expect(JSON.stringify(built)).not.toContain("account-pass");
  expect(JSON.stringify(built)).not.toContain("chat");
});

test("a decrypted payload is validated before anything is imported", () => {
  const built = cloudPayload();
  const parsed = parseCloudTransferPayload(JSON.stringify(built));
  expect(parsed.package.environment.id).toBe("k1abc");
  expect(parsed.transfer.session.origins.find((origin) => origin.origin === "https://mail.example.com")
    ?.localStorage[0]?.value).toBe("local-secret");

  const renamed = JSON.parse(JSON.stringify(built));
  renamed.package.environment.name = "Renamed";
  expect(() => parseCloudTransferPayload(JSON.stringify(renamed))).toThrow();

  const drifted = JSON.parse(JSON.stringify(built));
  drifted.version = 99;
  expect(() => parseCloudTransferPayload(JSON.stringify(drifted))).toThrow(/版本/);

  const mismatched = JSON.parse(JSON.stringify(built));
  mismatched.transfer.environment.id = "k1other";
  expect(() => parseCloudTransferPayload(JSON.stringify(mismatched))).toThrow(/编号/);
});

test("an environment with no login state says so instead of pretending", () => {
  const built = buildCloudTransferPayload({ environment, session: {} });
  expect(hasLoginState(built)).toBe(false);
  expect(built.transfer.session.cookies).toEqual([]);
  expect(built.transfer.session.origins).toEqual([]);
});

test("the device identity is created once and reused from the state directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "nanfu-cloud-key-"));
  try {
    const first = loadOrCreateTransferIdentity(root);
    const second = loadOrCreateTransferIdentity(root);
    expect(second.publicKey).toBe(first.publicKey);
    expect(second.privateKey).toBe(first.privateKey);
    expect(first.deviceId).toBeTruthy();
    const file = JSON.parse(await readFile(join(root, "nanfu-transfer-key.json"), "utf8"));
    expect(file.publicKey).toBe(first.publicKey);
    expect(file.deviceId).toBe(first.deviceId);
    expect(() => openTransferPayload({ deviceId: first.deviceId, publicKey: first.publicKey, privateKey: "broken" }, "{}", "x"))
      .toThrow(NanfuCloudTransferError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("damaged cloud key files are preserved instead of silently replaced", async () => {
  const root = await mkdtemp(join(tmpdir(), "nanfu-damaged-key-"));
  const file = join(root, "nanfu-transfer-key.json");
  try {
    for (const contents of ["", "{broken", "null", "{}", JSON.stringify({ publicKey: "fixture", privateKey: "fixture" })]) {
      await writeFile(file, contents);
      expect(() => loadOrCreateTransferIdentity(root)).toThrow("已保留原文件");
      expect(await readFile(file, "utf8")).toBe(contents);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unreadable cloud key path is left untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "nanfu-unreadable-key-"));
  const file = join(root, "nanfu-transfer-key.json");
  try {
    await mkdir(file);
    await writeFile(join(file, "sentinel"), "synthetic backup");
    expect(() => loadOrCreateTransferIdentity(root)).toThrow("已保留原文件");
    expect(await readFile(join(file, "sentinel"), "utf8")).toBe("synthetic backup");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adding a device ID to an existing key preserves access to old ciphertext", async () => {
  const root = await mkdtemp(join(tmpdir(), "nanfu-existing-key-"));
  try {
    const identity = createTransferIdentity();
    const sealed = sealTransferPayload(identity.publicKey, "synthetic prior package", "fixture-transfer");
    await writeFile(join(root, "nanfu-transfer-key.json"), JSON.stringify({
      publicKey: identity.publicKey, privateKey: identity.privateKey,
    }));
    const upgraded = loadOrCreateTransferIdentity(root);
    expect(upgraded.publicKey).toBe(identity.publicKey);
    expect(upgraded.privateKey).toBe(identity.privateKey);
    expect(upgraded.deviceId).toBeTruthy();
    expect(openTransferPayload(upgraded, sealed, "fixture-transfer")).toBe("synthetic prior package");
    expect(loadOrCreateTransferIdentity(root)).toEqual(upgraded);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extension archives travel with the payload and survive a round trip", () => {
  const built = buildCloudTransferPayload({
    environment, session: rawSession, extensionNames: ["Demo"], extensionArchives: [cloudArchive],
  });
  expect(built.package.extensionArchives[0]?.files[0]?.path).toBe("manifest.json");
  const parsed = parseCloudTransferPayload(JSON.stringify(built));
  expect(parsed.package.extensionArchives[0]?.name).toBe("Demo");
});

const USER_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_USER_ID = "22222222-2222-2222-2222-222222222222";

/** Stands in for PostgREST + RLS: rows are addressed by account, as the policies require. */
class FakeCloudService {
  private readonly keys = new Map<string, Map<string, string>>();
  private readonly packages = new Map<string, { row: NanfuCloudPackageRow; payload: string }>();

  async publishDeviceKey(userId: string, deviceId: string, publicKey: string): Promise<void> {
    const devices = this.keys.get(userId) ?? new Map<string, string>();
    devices.set(deviceId, publicKey);
    this.keys.set(userId, devices);
  }

  async deviceKeys(userId: string): Promise<NanfuDeviceKeyRow[]> {
    return [...(this.keys.get(userId) ?? new Map<string, string>())]
      .map(([deviceId, publicKey]) => ({ deviceId, publicKey, label: "", lastSeenAt: "" }));
  }

  async upsertCloudPackage(input: {
    id: string; userId: string; environmentId: string; environmentName: string;
    deviceId: string; payload: string; sizeBytes: number;
  }): Promise<string> {
    this.packages.set(`${input.userId}:${input.id}`, {
      row: {
        id: input.id, environmentId: input.environmentId, environmentName: input.environmentName,
        deviceId: input.deviceId, sizeBytes: input.sizeBytes, createdAt: "", updatedAt: "",
      },
      payload: input.payload,
    });
    return input.id;
  }

  async cloudPackages(userId: string): Promise<NanfuCloudPackageRow[]> {
    return [...this.packages.entries()]
      .filter(([key]) => key.startsWith(`${userId}:`))
      .map(([, value]) => value.row);
  }

  async cloudPackage(id: string, userId: string): Promise<{ row: NanfuCloudPackageRow; payload: string }> {
    const found = this.packages.get(`${userId}:${id}`);
    if (!found) throw new Error("cloud package not found for this account");
    return found;
  }

  async deleteCloudPackage(id: string, userId: string): Promise<void> {
    this.packages.delete(`${userId}:${id}`);
  }

  sealed(id: string, userId = USER_ID): string {
    return this.packages.get(`${userId}:${id}`)!.payload;
  }
}

function routeContext(store: ProfileStore, root: string, service: FakeCloudService, userId = USER_ID) {
  return {
    nanfu: {
      account: { state: () => ({ authenticated: true, userId, email: "owner@example.com" }) },
      client: service as unknown as NanfuSyncClient,
      persistent: true,
    } as unknown as NanfuRuntime,
    store,
    paths: statePaths(root),
  };
}

function transferRequest(
  store: ProfileStore,
  root: string,
  service: FakeCloudService,
  action: string,
  body: unknown,
  userId = USER_ID,
): Promise<Response> {
  return handleNanfuTransferRequest(new Request(`http://local/ui/api/nanfu-transfer/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }), routeContext(store, root, service, userId));
}

const testProfile = () => parseExport("id=k1cloud\nname=Cloud box\ncookie=[]").profiles[0]!;

test("a multi-device envelope opens for every registered device and for nobody else", () => {
  const first = createTransferIdentity();
  const second = createTransferIdentity();
  const stranger = createTransferIdentity();
  const id = "0b8f0a9e-4b1f-4c0a-9d78-7a4c1b2e3f40";
  const sealed = sealTransferPayloadForDevices([
    { deviceId: first.deviceId, publicKey: first.publicKey },
    { deviceId: second.deviceId, publicKey: second.publicKey },
  ], "secret", id);
  expect(openTransferPayloadForDevices(first, sealed, id)).toBe("secret");
  expect(openTransferPayloadForDevices(second, sealed, id)).toBe("secret");
  expect(() => openTransferPayloadForDevices(stranger, sealed, id)).toThrow(/没有包含本机的密钥/);
  expect(() => openTransferPayloadForDevices(first, sealed, "another-package")).toThrow(NanfuCloudTransferError);

  const tampered = JSON.parse(sealed);
  const bytes = Buffer.from(tampered.ct, "base64");
  bytes[0] = bytes[0]! ^ 0x01;
  tampered.ct = bytes.toString("base64");
  expect(() => openTransferPayloadForDevices(first, JSON.stringify(tampered), id)).toThrow(NanfuCloudTransferError);
});

test("same account, two machines: upload seals the login state and the other machine restores it", async () => {
  const rootA = await mkdtemp(join(tmpdir(), "nanfu-cloud-a-"));
  const rootB = await mkdtemp(join(tmpdir(), "nanfu-cloud-b-"));
  const storeA = new ProfileStore(":memory:");
  const storeB = new ProfileStore(":memory:");
  const service = new FakeCloudService();
  try {
    const profile = testProfile();
    storeA.upsertProfile(profile);
    storeA.saveSessionBundle(profile.id, JSON.stringify(capturedSession));
    // Machine B has opened the transfer page before, so its key is on file.
    const identityB = loadOrCreateTransferIdentity(rootB);
    await service.publishDeviceKey(USER_ID, identityB.deviceId, identityB.publicKey);

    const upload = await transferRequest(storeA, rootA, service, "package-upload", { environmentId: profile.id });
    expect(upload.status).toBe(200);
    const uploaded = await upload.json() as any;
    expect(uploaded.hasLoginState).toBe(true);
    expect(uploaded.cookies).toBe(2);
    expect(uploaded.origins).toBe(2);
    expect(uploaded.deviceCount).toBe(2);
    const sealed = service.sealed(uploaded.id);
    expect(sealed).not.toContain("cookie-secret");
    expect(sealed).not.toContain("local-secret");
    expect(sealed).not.toContain("mail.example.com");

    const download = await transferRequest(storeB, rootB, service, "package-download", { id: uploaded.id });
    expect(download.status).toBe(200);
    const imported = await download.json() as any;
    expect(imported.hasLoginState).toBe(true);
    expect(imported.cookies).toBe(2);
    const restored = storeB.getProfile(imported.profileId)!;
    expect(restored.engine).toBe("chromium");
    expect(restored.name).toContain("Cloud box");
    const pending = storeB.getPendingSessionBundle(imported.profileId)!;
    const bundle = JSON.parse(pending);
    expect(bundle.cookies[0].value).toBe("cookie-secret");
    expect(bundle.cookies[0].httpOnly).toBe(true);
    expect(bundle.origins.find((origin: any) => origin.origin === "https://mail.example.com")
      .localStorage[0].value).toBe("local-secret");
    expect(storeB.getSessionBundle(imported.profileId)).toBe(pending);
  } finally {
    storeA.close();
    storeB.close();
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
  }
});

test("a device registered after the upload is told the package has no box for it", async () => {
  const rootA = await mkdtemp(join(tmpdir(), "nanfu-cloud-late-a-"));
  const rootB = await mkdtemp(join(tmpdir(), "nanfu-cloud-late-b-"));
  const storeA = new ProfileStore(":memory:");
  const storeB = new ProfileStore(":memory:");
  const service = new FakeCloudService();
  try {
    const profile = testProfile();
    storeA.upsertProfile(profile);
    storeA.saveSessionBundle(profile.id, JSON.stringify(capturedSession));

    const upload = await transferRequest(storeA, rootA, service, "package-upload", { environmentId: profile.id });
    const uploaded = await upload.json() as any;
    expect(uploaded.deviceCount).toBe(1);

    const identityB = loadOrCreateTransferIdentity(rootB);
    await service.publishDeviceKey(USER_ID, identityB.deviceId, identityB.publicKey);
    const download = await transferRequest(storeB, rootB, service, "package-download", { id: uploaded.id });
    expect(download.status).toBe(422);
    expect((await download.json() as any).error).toContain("没有包含本机的密钥");
    expect(storeB.count()).toBe(0);
  } finally {
    storeA.close();
    storeB.close();
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
  }
});

test("another account cannot download the sealed slot even with the package id", async () => {
  const rootA = await mkdtemp(join(tmpdir(), "nanfu-cloud-other-a-"));
  const rootB = await mkdtemp(join(tmpdir(), "nanfu-cloud-other-b-"));
  const storeA = new ProfileStore(":memory:");
  const storeB = new ProfileStore(":memory:");
  const service = new FakeCloudService();
  try {
    const profile = testProfile();
    storeA.upsertProfile(profile);
    storeA.saveSessionBundle(profile.id, JSON.stringify(capturedSession));
    const upload = await transferRequest(storeA, rootA, service, "package-upload", { environmentId: profile.id });
    const uploaded = await upload.json() as any;

    const download = await transferRequest(storeB, rootB, service, "package-download", { id: uploaded.id }, OTHER_USER_ID);
    expect(download.status).not.toBe(200);
    expect(storeB.count()).toBe(0);
  } finally {
    storeA.close();
    storeB.close();
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
  }
});

test("Camoufox / Firefox windows are refused by name before any capture", async () => {
  const root = await mkdtemp(join(tmpdir(), "nanfu-cloud-ff-"));
  const service = new FakeCloudService();
  const store = {
    getProfile: () => ({ id: "ff1", name: "Firefox box", engine: "firefox", extensions: [] }),
    listExtensions: () => [],
  } as unknown as ProfileStore;
  try {
    const response = await transferRequest(store, root, service, "package-upload", { environmentId: "ff1" });
    expect(response.status).toBe(400);
    expect((await response.json() as any).error).toContain("Camoufox");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
