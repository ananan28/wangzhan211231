import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareWindowsBundle, stageAgentRuntime, WINDOWS_SIDECAR_TARGET } from "./prepare-windows-bundle.ts";
import { WINDOWS_CHROMIUM_METADATA } from "../aliasmode-chromium.ts";
import { MCP_MODE } from "../sidecar-entry.ts";
import { ALIASMODE_VERSION } from "../version.ts";

test("Windows sidecar supports x64 CPUs without AVX2", () => {
  expect(WINDOWS_SIDECAR_TARGET).toBe("bun-windows-x64-baseline");
});

test("one sidecar program also runs the MCP helper behind the aliasmode-mcp launcher", () => {
  const repo = join(import.meta.dir, "..");
  const tauri = JSON.parse(readFileSync(join(repo, "src-tauri", "tauri.conf.json"), "utf8"));
  expect(tauri.bundle.externalBin).toEqual(["binaries/aliasmode-sidecar"]);
  const cargo = readFileSync(join(repo, "src-tauri", "Cargo.toml"), "utf8");
  expect(cargo).toContain(`default-run = "aliasmode"`);
  expect(cargo).toContain(`name = "aliasmode-mcp"\npath = "src/bin/aliasmode-mcp.rs"`);
  const launcher = readFileSync(join(repo, "src-tauri", "src", "bin", "aliasmode-mcp.rs"), "utf8");
  expect(launcher).toContain(`const MCP_MODE: &str = "${MCP_MODE}";`);

  const helper = Bun.spawnSync([process.execPath, "sidecar-entry.ts", MCP_MODE, "version"], { cwd: repo });
  expect(helper.exitCode).toBe(0);
  expect(JSON.parse(helper.stdout.toString())).toEqual({ ok: true, result: { version: ALIASMODE_VERSION } });
  const failed = Bun.spawnSync([process.execPath, "sidecar-entry.ts", MCP_MODE, "unknown"], { cwd: repo });
  expect(failed.exitCode).toBe(1);
  expect(JSON.parse(failed.stdout.toString())).toMatchObject({ ok: false });
});

function workspace(): string {
  const cwd = mkdtempSync(join(tmpdir(), "aliasmode-windows-bundle-"));
  mkdirSync(join(cwd, "src-tauri"), { recursive: true });
  writeFileSync(join(cwd, "playwright-worker.mjs"), "worker");
  mkdirSync(join(cwd, "agent"), { recursive: true });
  for (const file of [
    "mcp-host.mjs",
    "playwright-proxy.mjs",
    "playwright-runner.mjs",
    "script-runner.mjs",
    "script-runner.py",
    "runtime-client.mjs",
  ]) {
    writeFileSync(join(cwd, "agent", file), file);
  }
  const dependencies: Record<string, { version: string; dependencies?: Record<string, string> }> = {
    "playwright-core": { version: "1.58.2" },
    "ws": { version: "8.21.0" },
    "@modelcontextprotocol/sdk": { version: "1.30.0", dependencies: { zod: "1.0.0" } },
    "@playwright/mcp": {
      version: "0.0.56",
      dependencies: { playwright: "1.58.0-alpha-2026-01-16", "playwright-core": "1.58.0-alpha-2026-01-16" },
    },
    "playwright": { version: "1.58.0-alpha-2026-01-16", dependencies: { "playwright-core": "1.58.0-alpha-2026-01-16" } },
    "zod": { version: "1.0.0" },
  };
  for (const [dependency, manifest] of Object.entries(dependencies)) {
    const root = join(cwd, "node_modules", ...dependency.split("/"));
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: dependency, ...manifest }));
  }
  return cwd;
}

async function installTestNode(root: string): Promise<void> {
  mkdirSync(join(root, "node"), { recursive: true });
  writeFileSync(join(root, "node", "node.exe"), "node");
}

const compileTestSidecar = async (output: string) => { writeFileSync(output, "sidecar"); };

test("Windows bundle prepares Chromium without Firefox input or resources", async () => {
  const cwd = workspace();
  const staging = join(cwd, "src-tauri", "target", "desktop-staging");
  const resources = join(cwd, "src-tauri", "resources");
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, "stale"), "remove");
  mkdirSync(join(resources, "firefox"), { recursive: true });
  writeFileSync(join(resources, "firefox", "aliasmode.exe"), "stale runtime");
  try {
    const metadata = await prepareWindowsBundle({
      cwd, platform: "win32", arch: "x64",
      compileSidecar: compileTestSidecar, installNode: installTestNode,
    });
    expect(metadata).toEqual({ chromium: WINDOWS_CHROMIUM_METADATA });
    expect(metadata.chromium.version).toBe("155.0.8059.85-aliasmode.4");
    expect(metadata.chromium.sha256).toBe("0ef4de1bef7c12534031318e07ac89fa7942916a3abc89057985aafefbca619f");
    expect(metadata.chromium.archiveSha256).toBe("cfea275e4b7f3274b701e64c0483b46cbf6cd12ead9a6cfda6ff77b2680e7a23");
    expect(existsSync(join(staging, "stale"))).toBe(false);
    expect(existsSync(join(resources, "firefox"))).toBe(false);
    expect(existsSync(join(resources, "cloakbrowser"))).toBe(false);
    expect(existsSync(join(resources, "playwright", "firefox-worker.mjs"))).toBe(false);
    expect(readFileSync(join(resources, "playwright", "node", "node.exe"), "utf8")).toBe("node");
    expect(existsSync(join(resources, "playwright", "python"))).toBe(false);
    expect(readFileSync(join(resources, "playwright", "agent", "script-runner.mjs"), "utf8")).toBe("script-runner.mjs");
    expect(readFileSync(join(resources, "playwright", "agent", "script-runner.py"), "utf8")).toBe("script-runner.py");
    expect(readFileSync(join(resources, "playwright", "worker.mjs"), "utf8")).toBe("worker");
    expect(readFileSync(join(resources, "playwright", "playwright-worker.mjs"), "utf8")).toBe("worker");
    for (const [name, version] of Object.entries({
      "playwright-core": "1.58.2", "ws": "8.21.0", "@modelcontextprotocol/sdk": "1.30.0",
      "@playwright/mcp": "0.0.56", "playwright": "1.58.0-alpha-2026-01-16", "zod": "1.0.0",
    })) {
      const manifest = JSON.parse(readFileSync(join(resources, "playwright", "node_modules", ...name.split("/"), "package.json"), "utf8"));
      expect(manifest.version).toBe(version);
    }
    expect(readFileSync(join(resources, "playwright", "agent", "mcp-host.mjs"), "utf8")).toBe("mcp-host.mjs");
    expect(readFileSync(join(cwd, "src-tauri", "binaries", "aliasmode-sidecar-x86_64-pc-windows-msvc.exe"), "utf8")).toBe("sidecar");
    expect(JSON.parse(readFileSync(join(cwd, "src-tauri", "generated", "browser.json"), "utf8"))).toEqual(metadata);
    expect(readFileSync(join(cwd, "src-tauri", "generated", "VERSION.txt"), "utf8")).toBe(`${ALIASMODE_VERSION}\n`);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("Windows bundle rejects a replaced Node archive", async () => {
  const cwd = workspace();
  try {
    await expect(prepareWindowsBundle({
      cwd, platform: "win32", arch: "x64", compileSidecar: compileTestSidecar,
      downloadNode: async () => new TextEncoder().encode("replaced Node archive"),
    })).rejects.toThrow("official Node runtime SHA-256 mismatch");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("Windows bundle rejects a missing Node executable", async () => {
  const cwd = workspace();
  try {
    await expect(prepareWindowsBundle({
      cwd, platform: "win32", arch: "x64", compileSidecar: compileTestSidecar,
      installNode: async () => {},
    })).rejects.toThrow("official Node runtime is incomplete");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("Windows bundle still rejects missing Playwright workers", async () => {
  const cwd = workspace();
  rmSync(join(cwd, "playwright-worker.mjs"));
  try {
    await expect(prepareWindowsBundle({
      cwd, platform: "win32", arch: "x64", compileSidecar: compileTestSidecar,
      installNode: installTestNode,
    })).rejects.toThrow();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("Windows bundle still enforces pinned Playwright versions", async () => {
  const cwd = workspace();
  writeFileSync(join(cwd, "node_modules", "playwright-core", "package.json"), JSON.stringify({ name: "playwright-core", version: "0.0.0" }));
  try {
    await expect(prepareWindowsBundle({
      cwd, platform: "win32", arch: "x64", compileSidecar: compileTestSidecar,
      installNode: installTestNode,
    })).rejects.toThrow("desktop dependency version mismatch: playwright-core");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("non-Windows agent staging keeps the Firefox worker", () => {
  for (const platform of ["darwin", "linux"] as const) {
    const cwd = workspace();
    const target = join(cwd, "staged", platform);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(cwd, "firefox-worker.mjs"), "firefox worker");
    try {
      stageAgentRuntime(cwd, target, platform);
      expect(readFileSync(join(target, "firefox-worker.mjs"), "utf8")).toBe("firefox worker");
      expect(readFileSync(join(target, "playwright-worker.mjs"), "utf8")).toBe("worker");
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  }
});

test("desktop resource manifests keep Firefox on non-Windows targets only", () => {
  const root = join(import.meta.dir, "..", "src-tauri");
  const base = JSON.parse(readFileSync(join(root, "tauri.conf.json"), "utf8"));
  expect(base.bundle.resources).toEqual({ "resources/playwright/": "playwright/" });
  for (const platform of ["macos", "linux"]) {
    const override = JSON.parse(readFileSync(join(root, `tauri.${platform}.conf.json`), "utf8"));
    expect(override.bundle.resources["resources/firefox/"]).toBe("firefox/");
  }
});

test("desktop bundle preparation is Windows x64 only", async () => {
  await expect(prepareWindowsBundle({ platform: "linux", arch: "x64" })).rejects.toThrow("Windows x64");
  await expect(prepareWindowsBundle({ platform: "win32", arch: "arm64" })).rejects.toThrow("Windows x64");
});
