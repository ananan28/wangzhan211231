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
        const page = context.pages()[0] ?? await context.newPage();
        await page.goto(url);
        const previous = await page.evaluate(() => localStorage.getItem("isolation-test"));
        if (setValue !== undefined) {
          await page.evaluate(value => localStorage.setItem("isolation-test", value), setValue);
        }
        return previous;
      } finally {
        await browser.close();
        child.kill();
        await child.exited;
        child = undefined;
      }
    }
    expect(await visit("a", "a")).toBeNull();
    expect(await visit("b", "b")).toBeNull();
    expect(await visit("a")).toBe("a");
    expect(await visit("b")).toBe("b");
  } finally {
    if (child) { child.kill(); await child.exited; }
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 240000);
