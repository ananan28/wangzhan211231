import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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

test.skipIf(!enabled)("staff account forms validate and remain usable in real Chromium", async () => {
  // Keep the entry beneath the remote repo so React resolves from its node_modules.
  const entryDir = mkdtempSync(join(process.cwd(), ".nanfu-management-cdp-"));
  let server: ReturnType<typeof Bun.serve> | undefined;
  let chrome: Awaited<ReturnType<typeof connectChrome>> | undefined;
  try {
    const web = join(process.cwd(), "web").replace(/\\/g, "/");
    const entry = join(entryDir, "fixture.tsx");
    writeFileSync(entry, `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import { NanfuManagement } from ${JSON.stringify(`${web}/nanfu-management.tsx`)};
      import ${JSON.stringify(`${web}/styles.css`)};
      const organization = {
        orgId: "fixture-org", name: "合成组织", identity: "owner", roleName: null,
        permissions: [], quota: 0, used: 0, planQuota: 0, status: "active", locked: false,
      };
      const member = {
        roleId: null, roleName: null, managerUserId: null, quota: 0, used: 0,
        status: "active", locked: false,
      };
      const overview = {
        members: [
          { ...member, userId: "fixture-owner", email: "owner@nanfu.local", identity: "owner", displayName: "合成所有者" },
          { ...member, userId: "fixture-employee", email: "employee@nanfu.local", identity: "member", displayName: "合成员工" },
        ],
        roles: [], groups: [], grants: [], invites: [],
      };
      window.__nanfuMutations = [];
      const onMutate = async (action, input) => { window.__nanfuMutations.push({ action, input }); };
      const root = createRoot(document.getElementById("root"));
      window.__renderNanfu = (busy = false) => root.render(
        <section className="workspace nanfu-staff-page"><div className="settingspage">
          <NanfuManagement organization={organization} overview={overview}
            currentUserId="fixture-owner" busy={busy} onMutate={onMutate} />
        </div></section>
      );
      window.__renderNanfu();
    `);
    const build = await Bun.build({
      entrypoints: [entry], target: "browser", write: false,
      naming: "[name].[ext]", publicPath: "/", loader: { ".woff2": "file" },
    });
    if (!build.success) throw new Error(build.logs.map(String).join("\n"));
    const assets = new Map(build.outputs.map(output => [`/${basename(output.path)}`, output]));
    const script = build.outputs.find(output => output.path.endsWith(".js"));
    const styles = build.outputs.filter(output => output.path.endsWith(".css"));
    expect(script).toBeDefined();
    expect(styles.length).toBeGreaterThan(0);
    server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/") return new Response(`<!doctype html><html lang="zh-CN"><head>
          <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Nanfu management fixture</title>
          ${styles.map(style => `<link rel="stylesheet" href="/${basename(style.path)}">`).join("")}
          </head><body><div id="root"></div><script type="module" src="/${basename(script!.path)}"></script></body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } });
        if (path === "/favicon.ico") return new Response(null, { status: 204 });
        const asset = assets.get(path);
        return asset ? new Response(asset) : new Response("Not found", { status: 404 });
      },
    });
    const origin = `http://127.0.0.1:${server.port}`;
    chrome = await connectChrome();
    const context = await chrome.browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
    context.setDefaultTimeout(8_000);
    const externalRequests: string[] = [];
    const errors: string[] = [];
    await context.route("**/*", route => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      externalRequests.push(route.request().url());
      return route.abort();
    });
    const page = await context.newPage();
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin);
    const add = page.getByRole("form", { name: "添加账号", exact: true });
    await add.waitFor({ state: "visible" });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const mutations = () => page.evaluate(() => (window as any).__nanfuMutations);
    const created = [{ action: "create-account", input: {
      email: "测试员工", password: "Fixture123", identity: "member", quota: 0,
      managerUserId: undefined, roleId: undefined, groupIds: [], name: undefined,
    } }];
    await add.locator('[name="email"]').fill("测试员工");
    await add.locator('[name="password"]').fill("Fixture123");
    await add.getByRole("button", { name: "添加账号", exact: true }).click();
    await page.waitForFunction(() => (window as any).__nanfuMutations.length === 1);
    expect(await mutations()).toEqual(created);

    for (const [name, password, message] of [
      ["测试员工", "abcdef", "必须包含英文字母和数字"],
      ["张 三", "Fixture123", "不能包含空白"],
    ] as const) {
      await add.locator('[name="email"]').fill(name);
      await add.locator('[name="password"]').fill(password);
      await add.getByRole("button", { name: "添加账号", exact: true }).click();
      await page.waitForFunction(message => document.querySelector('form[aria-label="添加账号"] [role="alert"]')?.textContent?.includes(message), message);
      expect(await add.getByRole("alert").isVisible()).toBe(true);
      expect(await mutations()).toEqual(created);
    }

    const reset = page.getByRole("form", { name: "重置密码 合成员工", exact: true, includeHidden: true });
    const actions = page.locator("details.nanfu-row-actions").filter({ has: reset });
    await actions.locator(":scope > summary").click();
    await reset.locator('[name="password"]').fill("abcdef");
    await reset.getByRole("button", { name: "重置密码", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('form[aria-label="重置密码 合成员工"] [role="alert"]')?.textContent?.includes("必须包含英文字母和数字"));
    expect(await reset.getByRole("alert").isVisible()).toBe(true);
    expect(await mutations()).toEqual(created);
    await reset.locator('[name="password"]').fill("Reset123");
    await reset.getByRole("button", { name: "重置密码", exact: true }).click();
    await page.waitForFunction(() => (window as any).__nanfuMutations.length === 2);
    const completed = [...created, { action: "reset-password", input: { userId: "fixture-employee", password: "Reset123" } }];
    expect(await mutations()).toEqual(completed);
    expect(await reset.locator('[name="password"]').inputValue()).toBe("");

    for (const width of [1440, 800]) {
      await page.setViewportSize({ width, height: 1000 });
      await add.scrollIntoViewIfNeeded();
      const boxes = await add.locator('input:visible, select:visible, button[type="submit"]:visible').evaluateAll(nodes => nodes.map((node, index) => {
        const { left, right, top, bottom, width, height } = node.getBoundingClientRect();
        return { field: node.getAttribute("name") || `${node.tagName}-${index}`, left, right, top, bottom, width, height };
      }));
      expect(boxes.length).toBe(7);
      for (const box of boxes) {
        expect(box.width).toBeGreaterThan(0);
        expect(box.height).toBeGreaterThan(0);
        expect(box.left).toBeGreaterThanOrEqual(0);
        expect(box.right).toBeLessThanOrEqual(width);
      }
      const overlaps = boxes.flatMap((box, index) => boxes.slice(index + 1)
        .filter(other => Math.min(box.right, other.right) > Math.max(box.left, other.left)
          && Math.min(box.bottom, other.bottom) > Math.max(box.top, other.top))
        .map(other => `${width}: ${box.field} / ${other.field}`));
      expect(overlaps).toEqual([]);
      // Check the page containers, not tables: their own horizontal scrolling is intentional.
      const overflowing = await page.evaluate(() => ["html", "body", "#root", ".nanfu-staff-page", ".settingspage"].filter(selector => {
        const node = document.querySelector(selector)!;
        return node.scrollWidth > node.clientWidth + 1;
      }));
      expect(overflowing).toEqual([]);
    }

    await add.locator('[name="email"]').fill("测试员工");
    await add.locator('[name="password"]').fill("Fixture123");
    await page.evaluate(() => (window as any).__renderNanfu(true));
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('form[aria-label="添加账号"] button[type="submit"]')?.disabled);
    expect(await add.getByRole("button", { name: "添加账号", exact: true }).isDisabled()).toBe(true);
    expect(await reset.getByRole("button", { name: "重置密码", exact: true }).isDisabled()).toBe(true);
    // Also exercise the busy guard if a submission arrives without clicking the disabled button.
    await add.evaluate(form => (form as HTMLFormElement).requestSubmit());
    expect(await mutations()).toEqual(completed);
    expect(externalRequests).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    try { await chrome?.stop(); }
    finally {
      await server?.stop(true);
      rmSync(entryDir, { recursive: true, force: true });
    }
  }
}, 60_000);
