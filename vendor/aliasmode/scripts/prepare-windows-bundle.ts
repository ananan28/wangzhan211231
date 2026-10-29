import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { extractZipTo } from "../unzip.ts";
import { ALIASMODE_VERSION } from "../version.ts";
import { WINDOWS_CHROMIUM_DIR, WINDOWS_CHROMIUM_METADATA } from "../aliasmode-chromium.ts";
import { sha256File } from "../browser-install.ts";

export const NODE_WINDOWS_X64_VERSION = "22.23.2";
export const NODE_WINDOWS_X64_SHA256 = "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97";
export const NODE_WINDOWS_X64_URL = `https://nodejs.org/dist/v${NODE_WINDOWS_X64_VERSION}/node-v${NODE_WINDOWS_X64_VERSION}-win-x64.zip`;

export interface PreparedBrowserMetadata {
  chromium: typeof WINDOWS_CHROMIUM_METADATA;
}

export interface PrepareWindowsBundleOptions {
  cwd?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  compileSidecar?: (output: string) => Promise<void>;
  downloadNode?: () => Promise<Uint8Array>;
  installNode?: (playwrightRoot: string) => Promise<void>;
  /** The extracted pinned Chromium build that the installer ships; NANFU_CHROMIUM_RUNTIME by default. */
  chromiumRuntime?: string;
  /** The executable hash to require of that build; the pinned one unless a test supplies a stand-in. */
  expectedChromiumSha256?: string;
}

export const WINDOWS_SIDECAR_TARGET = "bun-windows-x64-baseline";

export async function compileSidecar(cwd: string, output: string, target = WINDOWS_SIDECAR_TARGET): Promise<void> {
  const child = Bun.spawn([
    process.execPath,
    "build",
    "--compile",
    `--target=${target}`,
    "--define=ALIASMODE_COMPILED=true",
    "--external=playwright-core",
    "--external=chromium-bidi",
    "--external=electron",
    // One program for the sidecar and the MCP helper; Cargo builds the aliasmode-mcp launcher.
    "sidecar-entry.ts",
    "--outfile",
    output,
  ], { cwd, stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) throw new Error(`sidecar compilation exited with code ${code}`);
}

const AGENT_PACKAGE_VERSIONS: Record<string, string> = {
  "@modelcontextprotocol/sdk": "1.32.2",
  "@playwright/mcp": "0.0.56",
  "playwright": "1.58.0-alpha-2026-01-16",
  "playwright-core": "1.62.1",
"ws": "8.22.0",
};

function packageDirectory(root: string, name: string): string {
  return join(root, "node_modules", ...name.split("/"));
}

function copyRuntimePackage(
  cwd: string,
  destinationRoot: string,
  name: string,
  copied = new Set<string>(),
): void {
  if (copied.has(name)) return;
  const source = packageDirectory(cwd, name);
  const manifestPath = join(source, "package.json");
  if (!statSync(source).isDirectory() || !statSync(manifestPath).isFile()) {
    throw new Error(`desktop dependency is missing: ${name}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    version?: string;
    dependencies?: Record<string, string>;
  };
  const expected = AGENT_PACKAGE_VERSIONS[name];
  if (expected && manifest.version !== expected) {
    throw new Error(`desktop dependency version mismatch: ${name}`);
  }
  const destination = packageDirectory(destinationRoot, name);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
  copied.add(name);
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    if (statSync(join(source, "node_modules", ...dependency.split("/")), { throwIfNoEntry: false })?.isDirectory()) {
      continue;
    }
    copyRuntimePackage(cwd, destinationRoot, dependency, copied);
  }
}

/** Copies the worker scripts, agent files and their Node packages; every desktop bundle needs them. */
export function stageAgentRuntime(cwd: string, playwrightRoot: string, platform: NodeJS.Platform = process.platform): void {
  cpSync(join(cwd, "playwright-worker.mjs"), join(playwrightRoot, "worker.mjs"));
  cpSync(join(cwd, "playwright-worker.mjs"), join(playwrightRoot, "playwright-worker.mjs"));
  if (platform !== "win32") {
    cpSync(join(cwd, "firefox-worker.mjs"), join(playwrightRoot, "firefox-worker.mjs"));
  }

  const agentRoot = join(playwrightRoot, "agent");
  mkdirSync(agentRoot, { recursive: true });
  for (const file of [
    "mcp-host.mjs",
    "playwright-proxy.mjs",
    "playwright-runner.mjs",
    "script-runner.mjs",
    "script-runner.py",
    "runtime-client.mjs",
  ]) {
    cpSync(join(cwd, "agent", file), join(agentRoot, file));
  }
  const copied = new Set<string>();
  for (const dependency of [
    "playwright-core",
    "ws",
    "@modelcontextprotocol/sdk",
    "@playwright/mcp",
    "playwright",
  ]) {
    copyRuntimePackage(cwd, playwrightRoot, dependency, copied);
  }
}

// The interface languages 南孚 ships a locale pack for; Chromium falls back to en-US for the rest.
const BUNDLED_LOCALES = new Set(["en-US.pak", "en-GB.pak", "zh-CN.pak", "zh-TW.pak", "ja.pak", "ko.pak", "ru.pak"]);

function keepBundledRuntimeFile(source: string, path: string): boolean {
  const parts = relative(source, path).split(/[\\/]/);
  return parts[0] !== "locales" || parts.length === 1 || BUNDLED_LOCALES.has(parts[1]!);
}

/** Copy the pinned build next to the app, so a profile never waits for a download. */
export function stageBundledChromium(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, filter: (path) => keepBundledRuntimeFile(source, path) });
}

export async function prepareWindowsBundle(
  options: PrepareWindowsBundleOptions = {},
): Promise<PreparedBrowserMetadata> {
  const cwd = resolve(options.cwd ?? process.cwd());
  if ((options.platform ?? process.platform) !== "win32" || (options.arch ?? process.arch) !== "x64") {
    throw new Error("desktop bundle preparation requires Windows x64");
  }

  const tauri = join(cwd, "src-tauri");
  const generated = join(tauri, "generated");
  const binaries = join(tauri, "binaries");
  const resources = join(tauri, "resources");
  const staging = join(tauri, "target", "desktop-staging");
  const firefoxRoot = join(resources, "firefox");
  const playwrightRoot = join(resources, "playwright");
  const sidecar = join(binaries, "aliasmode-sidecar-x86_64-pc-windows-msvc.exe");

  rmSync(staging, { recursive: true, force: true });
  rmSync(firefoxRoot, { recursive: true, force: true });
  rmSync(playwrightRoot, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  mkdirSync(generated, { recursive: true });
  mkdirSync(binaries, { recursive: true });
  mkdirSync(resources, { recursive: true });

  await (options.compileSidecar ?? ((output) => compileSidecar(cwd, output)))(sidecar);
  if (!statSync(sidecar).isFile()) throw new Error("sidecar compiler did not create the expected Windows executable");

  if (options.installNode) {
    await options.installNode(playwrightRoot);
  } else {
    const nodeStaging = join(staging, "node");
    const nodeBytes = await (options.downloadNode ?? (async () => {
      const response = await fetch(NODE_WINDOWS_X64_URL, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error("official Node runtime download failed");
      return new Uint8Array(await response.arrayBuffer());
    }))();
    const nodeHash = createHash("sha256").update(nodeBytes).digest("hex");
    if (nodeHash !== NODE_WINDOWS_X64_SHA256) throw new Error("official Node runtime SHA-256 mismatch");
    await extractZipTo(nodeBytes, nodeStaging);
    const extractedNode = join(nodeStaging, `node-v${NODE_WINDOWS_X64_VERSION}-win-x64`, "node.exe");
    if (!statSync(extractedNode).isFile()) throw new Error("official Node runtime archive is incomplete");
    mkdirSync(join(playwrightRoot, "node"), { recursive: true });
    cpSync(extractedNode, join(playwrightRoot, "node", "node.exe"));
  }
  if (!statSync(join(playwrightRoot, "node", "node.exe"), { throwIfNoEntry: false })?.isFile()) throw new Error("official Node runtime is incomplete");
  stageAgentRuntime(cwd, playwrightRoot, "win32");

  const chromiumRoot = join(resources, "chromium");
  rmSync(chromiumRoot, { recursive: true, force: true });
  mkdirSync(chromiumRoot, { recursive: true });
  const bundled = options.chromiumRuntime ?? process.env.NANFU_CHROMIUM_RUNTIME;
  if (bundled) {
    const source = resolve(bundled);
    const executable = join(source, WINDOWS_CHROMIUM_METADATA.executable);
    if (!statSync(executable, { throwIfNoEntry: false })?.isFile()) throw new Error("bundled Chromium runtime is incomplete");
    if (await sha256File(executable) !== (options.expectedChromiumSha256 ?? WINDOWS_CHROMIUM_METADATA.sha256)) {
      throw new Error("bundled Chromium executable SHA-256 mismatch");
    }
    stageBundledChromium(source, join(chromiumRoot, WINDOWS_CHROMIUM_DIR));
  }

  const metadata: PreparedBrowserMetadata = { chromium: WINDOWS_CHROMIUM_METADATA };
  writeFileSync(join(generated, "browser.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  writeFileSync(join(generated, "VERSION.txt"), `${ALIASMODE_VERSION}\n`, "utf8");
  return metadata;
}

if (import.meta.main) {
  try {
    const metadata = await prepareWindowsBundle();
    console.log(`prepared Windows bundle for Chromium ${metadata.chromium.version}, SHA-256 ${metadata.chromium.sha256}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
