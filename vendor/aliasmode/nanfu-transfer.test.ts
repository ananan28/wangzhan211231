import { expect, test } from "bun:test";
import { NanfuCipher, NanfuDecryptError, createNanfuKeyParams } from "./nanfu-crypto.ts";
import { exportNanfuEnvironment } from "./nanfu-sync.ts";
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
