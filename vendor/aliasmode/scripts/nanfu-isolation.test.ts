import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { ensureAliasmodeChromium } from "../aliasmode-chromium.ts";
import { windowsAcceptanceProfiles } from "../cli.ts";

test("Windows acceptance uses the selected Chromium runtime for both sessions", () => {
  const profiles = windowsAcceptanceProfiles(["--chromium-runtime", "aliasmode"]);
  expect(profiles).toHaveLength(2);
  expect(profiles.map(profile => profile.chromiumRuntime)).toEqual(["aliasmode", "aliasmode"]);
  expect(profiles[0]!.id).not.toBe(profiles[1]!.id);
  expect(profiles[0]!.fingerprintSeed).not.toBe(profiles[1]!.fingerprintSeed);
  expect(windowsAcceptanceProfiles([]).every(profile => profile.chromiumRuntime === undefined)).toBe(true);
});

const liveTest = process.env.NANFU_LIVE_ISOLATION === "1" ? test : test.skip;

liveTest("Chromium sessions persist isolated cookies, IndexedDB, caches and identity across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "nanfu-isolation-"));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: request => new URL(request.url).pathname === "/headers"
      ? Response.json({ ua: request.headers.get("user-agent") })
      : new Response("<!doctype html><title>Nanfu test</title>", {
        headers: { "content-type": "text/html" },
      }),
  });
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    console.log("isolation: downloading and verifying Chromium");
    const executablePath = await ensureAliasmodeChromium(join(root, "runtime"));
    const url = `http://127.0.0.1:${server.port}/`;
    async function visit(name: string, setValue?: string) {
      console.log(`isolation: launching ${name}`);
      child = Bun.spawn([executablePath, `--user-data-dir=${join(root, name)}`,
        "--headless=new", "--disable-gpu", "--no-first-run",
        `--fingerprint=${name === "a" ? 314159 : 271828}`, "--fingerprint-platform=windows", "--fingerprint-noise",
        "--remote-debugging-port=19223", "about:blank"], { stdout: "ignore", stderr: "ignore" });
      let ready = false;
      for (let i = 0; i < 45; i++) {
        try {
          const response = await fetch("http://127.0.0.1:19223/json/version");
          if (response.ok) { ready = true; break; }
        } catch {}
        await Bun.sleep(1000);
      }
      if (!ready) throw new Error(`Chromium CDP did not become ready for ${name}`);
      const browser = await chromium.connectOverCDP("http://127.0.0.1:19223", { timeout: 30000 });
      try {
        const context = browser.contexts()[0];
        if (!context) throw new Error("Chromium did not expose a default context");
        const page = context.pages()[0] ?? await context.newPage();
        await page.goto(url);
        const previous = await page.evaluate(async value => {
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open("nanfu-isolation", 1);
            request.onupgradeneeded = () => request.result.createObjectStore("state");
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          try {
            const indexed = await new Promise<string | undefined>((resolve, reject) => {
              const transaction = db.transaction("state", "readonly");
              const request = transaction.objectStore("state").get("owner");
              transaction.oncomplete = () => resolve(request.result);
              transaction.onabort = () => reject(transaction.error);
            });
            const cache = await caches.open("nanfu-isolation");
            const cached = await cache.match("/owner");
            const previous = {
              local: localStorage.getItem("isolation-test"),
              cookie: document.cookie,
              indexed: indexed ?? null,
              cached: cached ? await cached.text() : null,
            };
            if (value !== undefined) {
              localStorage.setItem("isolation-test", value);
              document.cookie = `owner=${value}; Path=/; Max-Age=86400; SameSite=Lax`;
              await new Promise<void>((resolve, reject) => {
                const transaction = db.transaction("state", "readwrite");
                transaction.objectStore("state").put(value, "owner");
                transaction.oncomplete = () => resolve();
                transaction.onabort = () => reject(transaction.error);
              });
              await cache.put("/owner", new Response(value));
            }
            return previous;
          } finally {
            db.close();
          }
        }, setValue);
        const identity = await page.evaluate(async () => {
          const ua = navigator.userAgent;
          const platform = navigator.platform;
          const headers = await fetch("/headers").then(response => response.json()) as { ua: string };
          const workerUrl = URL.createObjectURL(new Blob([
            "postMessage({ ua: navigator.userAgent, platform: navigator.platform })",
          ], { type: "text/javascript" }));
          const worker = new Worker(workerUrl);
          try {
            const observed = await new Promise<{ ua: string; platform: string }>((resolve, reject) => {
              worker.onmessage = event => resolve(event.data);
              worker.onerror = event => reject(new Error(event.message));
            });
            return { ua, platform, headerUa: headers.ua, worker: observed };
          } finally {
            worker.terminate();
            URL.revokeObjectURL(workerUrl);
          }
        });
        expect(identity.ua).toContain("Chrome/");
        expect(identity.headerUa).toBe(identity.ua);
        expect(identity.worker).toEqual({ ua: identity.ua, platform: identity.platform });
        const canvas = await page.evaluate(() => {
          const canvas = document.createElement("canvas");
          canvas.width = 200;
          canvas.height = 60;
          const ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("Canvas unavailable");
          ctx.fillStyle = "#12ac84";
          ctx.fillRect(3, 2, 194, 54);
          ctx.font = "17px sans-serif";
          ctx.fillStyle = "#421ec9";
          ctx.fillText("Nanfu canvas sample 0123456789", 5, 30);
          return canvas.toDataURL();
        });
        return { previous, canvas, identity };
      } finally {
        const session = await browser.newBrowserCDPSession();
        await session.send("Browser.close").catch(() => {});
        const completed = await Promise.race([
          child.exited.then(() => true),
          Bun.sleep(15000).then(() => false),
        ]);
        if (!completed) {
          child.kill();
          await child.exited;
          child = undefined;
          throw new Error("Chromium did not close cleanly");
        }
        child = undefined;
      }
    }
    const firstA = await visit("a", "a");
    const firstB = await visit("b", "b");
    const restoredA = await visit("a");
    const restoredB = await visit("b");
    const empty = { local: null, cookie: "", indexed: null, cached: null };
    expect(firstA.previous).toEqual(empty);
    expect(firstB.previous).toEqual(empty);
    expect(restoredA.previous).toEqual({ local: "a", cookie: "owner=a", indexed: "a", cached: "a" });
    expect(restoredB.previous).toEqual({ local: "b", cookie: "owner=b", indexed: "b", cached: "b" });
    expect(restoredA.identity).toEqual(firstA.identity);
    expect(restoredB.identity).toEqual(firstB.identity);
    console.log("isolation: UA is kernel/platform-derived, not a unique account identifier", {
      sameUaAcrossSessions: firstA.identity.ua === firstB.identity.ua,
    });
    expect(restoredA.canvas).toBe(firstA.canvas);
    expect(restoredB.canvas).toBe(firstB.canvas);
    expect(firstA.canvas).not.toBe(firstB.canvas);
  } finally {
    if (child) { child.kill(); await child.exited; }
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 240000);

liveTest("simultaneous Chromium profiles isolate cookies, local storage and canvas", async () => {
  const root = await mkdtemp(join(tmpdir(), "nanfu-parallel-"));
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: () => new Response("<!doctype html><title>Parallel isolation</title>", {
      headers: { "content-type": "text/html" },
    }),
  });
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const browsers: Awaited<ReturnType<typeof chromium.connectOverCDP>>[] = [];
  try {
    const executable = await ensureAliasmodeChromium(join(root, "runtime"));
    const launch = async (name: string, seed: number) => {
      const dataDir = join(root, name);
      const child = Bun.spawn([executable, `--user-data-dir=${dataDir}`, "--headless=new",
        "--disable-gpu", "--no-first-run", `--fingerprint=${seed}`,
        "--fingerprint-platform=windows", "--fingerprint-noise",
        "--remote-debugging-port=0", "about:blank"], { stdout: "ignore", stderr: "ignore" });
      children.push(child);
      let port = "";
      for (let i = 0; i < 60; i++) {
        try {
          port = (await Bun.file(join(dataDir, "DevToolsActivePort")).text()).split("\n")[0]?.trim() ?? "";
          if (/^\d+$/.test(port)) break;
        } catch {}
        await Bun.sleep(1000);
      }
      if (!port) throw new Error(`CDP did not become ready for ${name}`);
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 30000 });
      browsers.push(browser);
      const context = browser.contexts()[0];
      if (!context) throw new Error(`No default context for ${name}`);
      const page = context.pages()[0] ?? await context.newPage();
      await page.goto(`http://127.0.0.1:${server.port}/`);
      return page;
    };
    const [resultA, resultB] = await Promise.allSettled([launch("a", 314159), launch("b", 271828)] as const);
    if (resultA.status === "rejected") throw resultA.reason;
    if (resultB.status === "rejected") throw resultB.reason;
    const a = resultA.value;
    const b = resultB.value;
    const read = (page: typeof a) => page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 200; canvas.height = 60;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas unavailable");
      ctx.fillStyle = "#12ac84"; ctx.fillRect(3, 2, 194, 54);
      ctx.font = "17px sans-serif"; ctx.fillStyle = "#421ec9";
      ctx.fillText("Nanfu canvas sample 0123456789", 5, 30);
      return { value: localStorage.getItem("parallel"), cookie: document.cookie, canvas: canvas.toDataURL(), session: sessionStorage.getItem("parallel") };
    });
    await a.evaluate(() => { localStorage.setItem("parallel", "A"); sessionStorage.setItem("parallel", "A-tab"); document.cookie = "parallel=A; path=/"; });
    expect((await read(b)).value).toBeNull();
    expect((await read(b)).cookie).not.toContain("parallel=A");
    await b.evaluate(() => { localStorage.setItem("parallel", "B"); document.cookie = "parallel=B; path=/"; });
    const [stateA, stateB] = await Promise.all([read(a), read(b)]);
    expect(stateA.value).toBe("A"); expect(stateB.value).toBe("B");
    expect(stateA.cookie).toContain("parallel=A"); expect(stateB.cookie).toContain("parallel=B");
    expect(stateA.canvas).not.toBe(stateB.canvas);
    expect(stateA.session).toBe("A-tab");
    expect(stateB.session).toBeNull();
    const sameSessionTab = await a.context().newPage();
    await sameSessionTab.goto(`http://127.0.0.1:${server.port}/`);
    const tabState = await read(sameSessionTab);
    expect(tabState.value).toBe("A");
    expect(tabState.cookie).toContain("parallel=A");
    expect(tabState.canvas).toBe(stateA.canvas);
    expect(tabState.session).toBeNull();
    await sameSessionTab.close();
    await Promise.all([a.reload(), b.reload()]);
    expect((await read(a)).canvas).toBe(stateA.canvas);
    expect((await read(b)).canvas).toBe(stateB.canvas);
  } finally {
    await Promise.all(browsers.map(async browser => {
      try { const session = await browser.newBrowserCDPSession(); await session.send("Browser.close"); } catch {}
    }));
    await Promise.all(children.map(async child => {
      const closed = await Promise.race([child.exited.then(() => true), Bun.sleep(15000).then(() => false)]);
      if (!closed) { child.kill(); await child.exited; }
    }));
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 240000);
