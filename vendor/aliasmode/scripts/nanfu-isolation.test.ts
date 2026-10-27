import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { ensureAliasmodeChromium } from "../aliasmode-chromium.ts";

const liveTest = process.env.NANFU_LIVE_ISOLATION === "1" ? test : test.skip;

liveTest("Chromium profiles keep local data isolated across a restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "nanfu-isolation-"));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("<!doctype html><title>Nanfu test</title>", {
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
        const previous = await page.evaluate(() => localStorage.getItem("isolation-test"));
        if (setValue !== undefined) {
          await page.evaluate(value => localStorage.setItem("isolation-test", value), setValue);
        }
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
        return { previous, canvas };
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
    expect(firstA.previous).toBeNull();
    expect(firstB.previous).toBeNull();
    expect(restoredA.previous).toBe("a");
    expect(restoredB.previous).toBe("b");
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
          port = (await Bun.file(join(dataDir, "DevToolsActivePort")).text()).split("\n")[0].trim();
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
    const results = await Promise.allSettled([launch("a", 314159), launch("b", 271828)]);
    if (results[0].status === "rejected") throw results[0].reason;
    if (results[1].status === "rejected") throw results[1].reason;
    const [a, b] = [results[0].value, results[1].value];
    const read = (page: typeof a) => page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 200; canvas.height = 60;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas unavailable");
      ctx.fillStyle = "#12ac84"; ctx.fillRect(3, 2, 194, 54);
      ctx.font = "17px sans-serif"; ctx.fillStyle = "#421ec9";
      ctx.fillText("Nanfu canvas sample 0123456789", 5, 30);
      return { value: localStorage.getItem("parallel"), cookie: document.cookie, canvas: canvas.toDataURL() };
    });
    await a.evaluate(() => { localStorage.setItem("parallel", "A"); document.cookie = "parallel=A; path=/"; });
    expect((await read(b)).value).toBeNull();
    expect((await read(b)).cookie).not.toContain("parallel=A");
    await b.evaluate(() => { localStorage.setItem("parallel", "B"); document.cookie = "parallel=B; path=/"; });
    const [stateA, stateB] = await Promise.all([read(a), read(b)]);
    expect(stateA.value).toBe("A"); expect(stateB.value).toBe("B");
    expect(stateA.cookie).toContain("parallel=A"); expect(stateB.cookie).toContain("parallel=B");
    expect(stateA.canvas).not.toBe(stateB.canvas);
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
