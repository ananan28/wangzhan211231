import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { NanfuCipher, NanfuDecryptError } from "./nanfu-crypto.ts";
import { exportNanfuEnvironment } from "./nanfu-sync.ts";
import {
  NANFU_KERNEL_VERSION,
  applyNanfuTransferToContext,
  buildNanfuTransfer,
  captureNanfuFromBrowser,
  decryptNanfuTransfer,
  encryptNanfuTransfer,
} from "./nanfu-transfer.ts";
import type { Profile } from "./types.ts";

/**
 * Real-browser round trip: a live Chromium profile is exported over CDP and
 * imported into a fresh browser process. Gated because it needs a Chromium build.
 */
const enabled = process.env.NANFU_CDP_TEST === "1";
const passphrase = "correct horse battery staple";
const cipher = () => new NanfuCipher(passphrase);

const DEBUG_PORT = 9333;
const debugEndpoint = `http://127.0.0.1:${DEBUG_PORT}`;

let serverA: ReturnType<typeof Bun.serve>;
let serverB: ReturnType<typeof Bun.serve>;
let originA: string;
let originB: string;
const processes: Array<{ kill(): void; exited: Promise<number> }> = [];
const profiles: string[] = [];

/**
 * Bun cannot complete Playwright's fd-3 pipe handshake with a browser it
 * spawns, so start Chromium ourselves on a debugging port and attach over CDP.
 */
async function connectChrome(): Promise<{ browser: Browser; stop(): Promise<void> }> {
  const profile = mkdtempSync(join(tmpdir(), "nanfu-cdp-"));
  profiles.push(profile);
  const child = Bun.spawn([
    chromium.executablePath(),
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    "about:blank",
  ], { stdout: "ignore", stderr: "ignore" });
  processes.push(child);
  let ready = false;
  for (let attempt = 0; attempt < 120 && !ready; attempt++) {
    ready = await fetch(`${debugEndpoint}/json/version`).then((response) => response.ok).catch(() => false);
    if (!ready) await Bun.sleep(250);
  }
  if (!ready) throw new Error("Chromium did not expose a debugging endpoint");
  const browser = await chromium.connectOverCDP(debugEndpoint);
  return {
    browser,
    async stop() {
      await browser.close().catch(() => {});
      child.kill();
      await child.exited.catch(() => {});
      for (let attempt = 0; attempt < 40; attempt++) {
        const up = await fetch(`${debugEndpoint}/json/version`).then(() => true).catch(() => false);
        if (!up) return;
        await Bun.sleep(250);
      }
    },
  };
}

beforeAll(async () => {
  if (!enabled) return;
  const page = () => new Response("<!doctype html><title>nanfu</title><p>probe</p>", {
    headers: { "content-type": "text/html" },
  });
  serverA = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: page });
  serverB = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: page });
  originA = `http://127.0.0.1:${serverA.port}`;
  originB = `http://127.0.0.1:${serverB.port}`;
});

afterAll(async () => {
  for (const child of processes) child.kill();
  await Promise.all(processes.map((child) => child.exited.catch(() => 0)));
  serverA?.stop(true);
  serverB?.stop(true);
  for (const profile of profiles) {
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      // A killed browser may still hold its profile briefly; it lives in temp.
    }
  }
});

test.skipIf(!enabled)("a live environment survives export and import without losing login state", async () => {
  const environment = exportNanfuEnvironment({
    id: "env-cdp-1",
    engine: "chromium",
    name: "CDP Round Trip",
    group: "QA",
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/155.0.0.0",
    timezone: "Asia/Shanghai",
    screenWidth: 1920,
    screenHeight: 1080,
    fingerprintSeed: 424242,
    platform: "windows",
    locale: "zh-CN",
    tags: ["qa"],
    extensions: ["ext1"],
    proxy: { type: "http", host: "proxy.example", port: "8080", user: "proxy-user", pass: "proxy-pass" },
  } as unknown as Profile, new Map([["ext1", "uBlock Origin"]]), "2026-10-29T00:00:00.000Z");

  const first = await connectChrome();
  const contextA = first.browser.contexts()[0] ?? await first.browser.newContext();
  const expires = Math.floor(Date.now() / 1000) + 3_600;
  await contextA.addCookies([{
    name: "sid",
    value: "cookie-secret-value",
    url: originA,
    httpOnly: true,
    secure: false,
    sameSite: "Lax",
    expires,
  }]);
  const pageA = await contextA.newPage();
  await pageA.goto(originA);
  await pageA.evaluate(async () => {
    localStorage.setItem("theme", "dark");
    localStorage.setItem("token", "local-secret");
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("nanfu-mail", 2);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore("messages", { keyPath: "id" });
        store.createIndex("by-folder", "folder");
      };
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction("messages", "readwrite");
        const store = transaction.objectStore("messages");
        for (const item of [
          { id: "m1", folder: "inbox", body: "one" },
          { id: "m2", folder: "inbox", body: "two" },
          { id: "m3", folder: "sent", body: "three" },
        ]) store.put(item);
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onerror = () => reject(transaction.error);
      };
      request.onerror = () => reject(request.error);
    });
    const cache = await caches.open("nanfu-assets");
    await cache.put("/a.txt", new Response("a"));
    await cache.put("/b.txt", new Response("b"));
  });
  await pageA.goto(originB);
  await pageA.evaluate(() => localStorage.setItem("locale", "zh-CN"));

  const captured = await captureNanfuFromBrowser(contextA, {
    origins: [originA, originB],
    indexedDB: "all",
  });
  expect(captured.unreadableOrigins).toEqual([]);
  const sid = captured.cookies.find((cookie) => cookie.name === "sid");
  expect(sid).toMatchObject({
    value: "cookie-secret-value",
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
  });
  expect(sid?.secure).toBeUndefined();
  expect(sid?.expires).toBe(expires);
  const mail = captured.origins.find((origin) => origin.origin === originA);
  expect(mail?.localStorage.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
    { name: "theme", value: "dark" },
    { name: "token", value: "local-secret" },
  ]);
  const database = (mail?.indexedDB as any[])[0];
  if (!database || database.version !== 2) console.log("captured database:", JSON.stringify(database));
  expect(database.name).toBe("nanfu-mail");
  expect(database.version).toBe(2);
  expect(database.stores[0].name).toBe("messages");
  expect(database.stores[0].indexes.map((index: any) => index.name)).toEqual(["by-folder"]);
  const records = [...database.stores[0].records].sort((a: any, b: any) => a.value.id.localeCompare(b.value.id));
  expect(records.map((record: any) => record.value)).toEqual([
    { id: "m1", folder: "inbox", body: "one" },
    { id: "m2", folder: "inbox", body: "two" },
    { id: "m3", folder: "sent", body: "three" },
  ]);
  const cacheManifest = captured.serviceWorkers.find((entry) => entry.origin === originA);
  expect(cacheManifest?.caches).toEqual([{ name: "nanfu-assets", entries: 2 }]);

  const pkg = buildNanfuTransfer({
    environment,
    session: { cookies: captured.cookies, origins: captured.origins },
    serviceWorkers: captured.serviceWorkers,
    kernel: NANFU_KERNEL_VERSION,
    indexedDB: "all",
  });
  const envelope = encryptNanfuTransfer(pkg, cipher());
  expect(envelope).not.toContain("cookie-secret-value");
  expect(envelope).not.toContain("local-secret");
  expect(() => decryptNanfuTransfer(envelope, new NanfuCipher("wrong passphrase"))).toThrow(NanfuDecryptError);
  const parsed = JSON.parse(envelope);
  const bytes = Buffer.from(parsed.ct, "base64");
  bytes[0] = bytes[0]! ^ 0xff;
  parsed.ct = bytes.toString("base64");
  expect(() => decryptNanfuTransfer(JSON.stringify(parsed), cipher())).toThrow(NanfuDecryptError);

  const mismatch = decryptNanfuTransfer(envelope, cipher(), { kernel: "154.0.1-aliasmode.0" });
  expect(mismatch.kernelMismatch).toEqual({ package: NANFU_KERNEL_VERSION, current: "154.0.1-aliasmode.0" });
  expect(mismatch.requiresAcknowledgement).toBe(true);

  const imported = decryptNanfuTransfer(envelope, cipher(), { kernel: NANFU_KERNEL_VERSION });
  expect(imported.kernelMismatch).toBeUndefined();
  expect(imported.package.environment).toEqual(environment);

  await first.stop();
  const second = await connectChrome();
  const contextB = second.browser.contexts()[0] ?? await second.browser.newContext();
  const applied = await applyNanfuTransferToContext(contextB, imported.package);
  expect(applied).toEqual({ cookies: captured.cookies.length, origins: 2, databases: 1 });

  const restoredSid = (await contextB.cookies(originA)).find((cookie) => cookie.name === "sid");
  expect(restoredSid).toMatchObject({
    value: "cookie-secret-value",
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
    secure: false,
    sameSite: "Lax",
  });
  expect(restoredSid?.expires).toBe(expires);

  const pageB = await contextB.newPage();
  await pageB.goto(originA);
  const restored = await pageB.evaluate(async () => {
    const data = await new Promise<any[]>((resolve, reject) => {
      const request = indexedDB.open("nanfu-mail");
      request.onsuccess = () => {
        const db = request.result;
        const all = db.transaction("messages").objectStore("messages").getAll();
        all.onsuccess = () => { db.close(); resolve(all.result); };
        all.onerror = () => reject(all.error);
      };
      request.onerror = () => reject(request.error);
    });
    return {
      theme: localStorage.getItem("theme"),
      token: localStorage.getItem("token"),
      ids: data.map((item) => item.id).sort(),
      caches: await caches.keys(),
    };
  });
  expect(restored.theme).toBe("dark");
  expect(restored.token).toBe("local-secret");
  expect(restored.ids).toEqual(["m1", "m2", "m3"]);
  // Cache bodies are rebuildable and deliberately not packaged.
  expect(restored.caches).toEqual([]);
  await pageB.goto(originB);
  expect(await pageB.evaluate(() => localStorage.getItem("locale"))).toBe("zh-CN");

  await second.stop();
}, 180_000);
