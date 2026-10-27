import { test, expect } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { ensureAliasmodeChromium } from "../aliasmode-chromium.ts";

const liveTest = process.env.NANFU_LIVE_PROXY_TEST === "1" ? test : test.skip;

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No port"));
      resolve(address.port);
    });
  });
}

liveTest("Chromium uses configured HTTP proxy and does not fall back after it stops", async () => {
  const root = await mkdtemp(join(tmpdir(), "nanfu-proxy-"));
  let directRequests = 0;
  let proxyRequests = 0;
  const origin = createServer((_req, res) => { directRequests++; res.end("direct"); });
  const proxy = createServer((_req, res) => {
    proxyRequests++;
    res.setHeader("content-type", "text/plain");
    res.end("through-proxy");
  });
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const originPort = await listen(origin);
    const proxyPort = await listen(proxy);
    const executablePath = await ensureAliasmodeChromium(join(root, "runtime"));
    child = Bun.spawn([executablePath, `--user-data-dir=${join(root, "profile")}`,
      "--headless=new", "--disable-gpu", "--no-first-run", "--disable-background-networking",
      "--remote-debugging-port=19224", `--proxy-server=http://127.0.0.1:${proxyPort}`,
      "--host-resolver-rules=MAP nanfu-test.example 127.0.0.1", "about:blank"],
      { stdout: "ignore", stderr: "ignore" });
    let ready = false;
    for (let i = 0; i < 45; i++) {
      try { if ((await fetch("http://127.0.0.1:19224/json/version")).ok) { ready = true; break; } } catch {}
      await Bun.sleep(1000);
    }
    if (!ready) throw new Error("Chromium CDP did not become ready");
    const browser = await chromium.connectOverCDP("http://127.0.0.1:19224");
    try {
      const context = browser.contexts()[0];
      if (!context) throw new Error("No browser context");
      const page = context.pages()[0] ?? await context.newPage();
      await page.goto(`http://nanfu-test.example:${originPort}/first`);
      expect(await page.locator("body").innerText()).toBe("through-proxy");
      expect(proxyRequests).toBeGreaterThan(0);
      expect(directRequests).toBe(0);
      await new Promise<void>((resolve, reject) => {
        proxy.close(error => error ? reject(error) : resolve());
        proxy.closeAllConnections();
      });
      let navigationFailed = false;
      try {
        await page.goto(`http://nanfu-test.example:${originPort}/after-proxy-stop`, { timeout: 15000 });
      } catch { navigationFailed = true; }
      expect(navigationFailed).toBe(true);
      expect(directRequests).toBe(0);
    } finally {
      const session = await browser.newBrowserCDPSession();
      await session.send("Browser.close").catch(() => {});
      const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(15000).then(() => false)]);
      if (!exited) { child.kill(); await child.exited; }
      child = undefined;
    }
  } finally {
    if (child) { child.kill(); await child.exited; }
    if (proxy.listening) await new Promise<void>(resolve => proxy.close(() => resolve()));
    if (origin.listening) await new Promise<void>(resolve => origin.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 240000);
