import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { ensureAliasmodeChromium } from "../aliasmode-chromium.ts";

test("Chromium profiles keep local data isolated across a restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "nanfu-isolation-"));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("<!doctype html><title>Nanfu test</title>", {
      headers: { "content-type": "text/html" },
    }),
  });
  const contexts = [];
  try {
    const executablePath = await ensureAliasmodeChromium(join(root, "runtime"));
    const url = `http://127.0.0.1:${server.port}/`;
    for (const name of ["a", "b"]) {
      const context = await chromium.launchPersistentContext(join(root, name), {
        executablePath,
        headless: true,
      });
      contexts.push(context);
      const page = context.pages()[0] ?? await context.newPage();
      await page.goto(url);
      await page.evaluate(value => localStorage.setItem("isolation-test", value), name);
    }
    for (let index = 0; index < contexts.length; index++) {
      expect(await contexts[index].pages()[0].evaluate(() => localStorage.getItem("isolation-test")))
        .toBe(index === 0 ? "a" : "b");
      await contexts[index].close();
    }
    contexts.length = 0;
    const restored = await chromium.launchPersistentContext(join(root, "a"), {
      executablePath,
      headless: true,
    });
    contexts.push(restored);
    const page = restored.pages()[0] ?? await restored.newPage();
    await page.goto(url);
    expect(await page.evaluate(() => localStorage.getItem("isolation-test"))).toBe("a");
  } finally {
    for (const context of contexts) await context.close().catch(() => {});
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 180000);
