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
        `--fingerprint=${name === "a" ? 314159 : 271828}`, "--fingerprint-platform=windows",
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
