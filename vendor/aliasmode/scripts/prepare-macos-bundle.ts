/**
 * Stages the Nanfu macOS bundle: the Chromium kernel, the Bun sidecar(s) and the agent runtime.
 *
 * The Windows bundle ships the same three things (see prepare-windows-bundle.ts); macOS differs in
 * three ways, all handled here:
 *   - the kernel is a per-run artifact of .github/workflows/nanfu-macos-kernel.yml, so it arrives as
 *     an archive whose SHA-256 the caller passes in rather than a published release;
 *   - the runtime is a full Chromium.app bundle, which the app looks up under
 *     <App>.app/Contents/Resources/chromium/chromium-<version>/Chromium.app (Tauri maps
 *     src-tauri/resources/chromium/ there), and whose executable hash the packager records because
 *     code signing changes it;
 *   - no Firefox is staged: the Nanfu macOS app is Chromium-only, matching the Windows installer.
 */
import { chmodSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sha256File } from "../browser-install.ts";
import { installSourceNode } from "../source-runtime.ts";
import { ALIASMODE_VERSION } from "../version.ts";
import { compileSidecar, stageAgentRuntime } from "./prepare-windows-bundle.ts";

/** The executable inside Chromium.app; the same relative path the sidecar's macOS pin uses. */
export const MACOS_CHROMIUM_EXECUTABLE = "Chromium.app/Contents/MacOS/Chromium";
/** The resource subdirectory Tauri maps src-tauri/resources/chromium/ to. */
export const MACOS_CHROMIUM_RESOURCE = "chromium";

export const MACOS_SIDECAR_TARGETS = ["aarch64-apple-darwin", "x86_64-apple-darwin"] as const;
export type MacosSidecarTarget = typeof MACOS_SIDECAR_TARGETS[number];

const BUN_TARGETS: Record<MacosSidecarTarget, string> = {
  "aarch64-apple-darwin": "bun-darwin-arm64",
  "x86_64-apple-darwin": "bun-darwin-x64",
};
const NODE_ARCHES: Record<MacosSidecarTarget, string> = {
  "aarch64-apple-darwin": "arm64",
  "x86_64-apple-darwin": "x64",
};
/** The architecture `lipo -archs` reports for a target's executable. */
const LIPO_ARCHES: Record<MacosSidecarTarget, string> = {
  "aarch64-apple-darwin": "arm64",
  "x86_64-apple-darwin": "x86_64",
};

export interface PreparedChromiumMetadata {
  executable: string;
  sha256: string;
  version: string;
  archiveSha256: string;
}

export interface PrepareMacosBundleOptions {
  cwd?: string;
  /** The sidecar targets to compile; NANFU_MACOS_TARGET by default. Both mean a universal app. */
  targets?: readonly string[];
  /** The Nanfu macOS kernel zip; NANFU_CHROMIUM_ARCHIVE by default. */
  chromiumArchive?: string;
  /** The archive's required SHA-256; NANFU_CHROMIUM_SHA256 by default. */
  chromiumSha256?: string;
  /** The version directory suffix; read from Chromium.app/Contents/Info.plist by default. */
  chromiumVersion?: string;
  compileSidecar?: (output: string, target: MacosSidecarTarget) => Promise<void>;
  installNode?: (target: MacosSidecarTarget) => Promise<string>;
}

function isMacosSidecarTarget(value: string): value is MacosSidecarTarget {
  return (MACOS_SIDECAR_TARGETS as readonly string[]).includes(value);
}

/**
 * The targets NANFU_MACOS_TARGET asks for: one Rust target triple, a comma-separated list, or
 * `universal`. It defaults to this Mac's processor.
 */
export function requestedMacosTargets(value = process.env.NANFU_MACOS_TARGET): MacosSidecarTarget[] {
  const requested = value?.trim() || (process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin");
  if (requested === "universal") return [...MACOS_SIDECAR_TARGETS];
  const targets = [...new Set(requested.split(",").map((entry) => entry.trim()).filter(Boolean))];
  if (!targets.length) throw new Error("NANFU_MACOS_TARGET names no target");
  for (const target of targets) {
    if (!isMacosSidecarTarget(target)) {
      throw new Error(
        `NANFU_MACOS_TARGET must be aarch64-apple-darwin, x86_64-apple-darwin or universal; got ${JSON.stringify(target)}`,
      );
    }
  }
  // Keep the lipo input order stable so the universal binary is reproducible.
  return MACOS_SIDECAR_TARGETS.filter((target) => targets.includes(target));
}

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${command[0]} exited with code ${code}`);
}

async function runQuietly(command: string[]): Promise<number> {
  const child = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
  return child.exited;
}

async function capture(command: string[]): Promise<string> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "inherit" });
  const output = await new Response(child.stdout).text();
  const code = await child.exited;
  if (code !== 0) throw new Error(`${command[0]} exited with code ${code}`);
  return output;
}

/** Chromium.app, either at the archive root or one folder down as package-artifact.sh writes it. */
function findChromiumApp(root: string, depth = 2): string | undefined {
  const direct = join(root, "Chromium.app");
  if (statSync(direct, { throwIfNoEntry: false })?.isDirectory()) return direct;
  if (depth === 0) return undefined;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const found = findChromiumApp(join(root, entry.name), depth - 1);
    if (found) return found;
  }
  return undefined;
}

/** CFBundleShortVersionString, the version of the binary that was actually built. */
function chromiumAppVersion(app: string): string | undefined {
  try {
    const plist = readFileSync(join(app, "Contents", "Info.plist"), "utf8");
    return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1]?.trim();
  } catch {
    return undefined;
  }
}

/** apostate-<version>-macos-<arch>.zip / nanfu-chromium-<version>-macos-x64.zip */
function archiveVersion(archive: string): string | undefined {
  return /(\d+\.\d+\.\d+(?:\.\d+)*)-macos-(?:arm64|x64)\.zip$/i.exec(archive)?.[1];
}

function resolveChromiumVersion(options: PrepareMacosBundleOptions, app: string, archive: string): string {
  const version = (options.chromiumVersion ?? process.env.NANFU_CHROMIUM_VERSION ?? chromiumAppVersion(app) ?? archiveVersion(archive) ?? "").trim();
  if (!/^\d+\.\d+\.\d+(\.\d+)*$/.test(version)) {
    throw new Error(
      `could not read the Chromium version of the kernel archive (${archive}); set NANFU_CHROMIUM_VERSION`,
    );
  }
  return version;
}

export async function prepareMacosBundle(
  options: PrepareMacosBundleOptions = {},
): Promise<{ chromium: PreparedChromiumMetadata }> {
  if (process.platform !== "darwin") throw new Error("macOS bundle preparation requires macOS");
  const cwd = resolve(options.cwd ?? process.cwd());
  const targets = requestedMacosTargets(
    options.targets ? options.targets.join(",") : undefined,
  );

  const tauri = join(cwd, "src-tauri");
  const generated = join(tauri, "generated");
  const binaries = join(tauri, "binaries");
  const resources = join(tauri, "resources");
  const staging = join(tauri, "target", "desktop-staging");
  const chromiumRoot = join(resources, MACOS_CHROMIUM_RESOURCE);
  const playwrightRoot = join(resources, "playwright");
  const firefoxRoot = join(resources, "firefox");

  // Chromium-only: a Firefox stage left by an earlier preparation must never reach this bundle.
  for (const path of [staging, chromiumRoot, playwrightRoot, firefoxRoot]) rmSync(path, { recursive: true, force: true });
  for (const path of [staging, generated, binaries, resources, chromiumRoot, join(playwrightRoot, "node")]) {
    mkdirSync(path, { recursive: true });
  }

  // 1. The sidecar, compiled for each requested target; Tauri's externalBin naming.
  for (const target of targets) {
    const output = join(binaries, `aliasmode-sidecar-${target}`);
    await (options.compileSidecar
      ?? ((file: string, arch: MacosSidecarTarget) => compileSidecar(cwd, file, BUN_TARGETS[arch])))(output, target);
    if (statSync(output, { throwIfNoEntry: false })?.isFile() !== true) {
      throw new Error(`sidecar compiler did not create src-tauri/binaries/aliasmode-sidecar-${target}`);
    }
  }
  if (targets.length > 1) {
    const universal = join(binaries, "aliasmode-sidecar-universal-apple-darwin");
    await run([
      "lipo", "-create",
      ...targets.map((target) => join(binaries, `aliasmode-sidecar-${target}`)),
      "-output", universal,
    ]);
  }

  // 2. The Playwright runtime: the official Node build plus the worker and agent scripts.
  const nodeExecutables: string[] = [];
  for (const target of targets) {
    nodeExecutables.push(
      await (options.installNode
        ?? ((arch: MacosSidecarTarget) => installSourceNode(staging, { platform: "darwin", arch: NODE_ARCHES[arch] })))(target),
    );
  }
  const nodeOutput = join(playwrightRoot, "node", "node");
  if (nodeExecutables.length > 1) {
    await run(["lipo", "-create", ...nodeExecutables, "-output", nodeOutput]);
  } else {
    cpSync(nodeExecutables[0]!, nodeOutput);
  }
  chmodSync(nodeOutput, 0o755);
  stageAgentRuntime(cwd, playwrightRoot);
  for (const path of [
    nodeOutput,
    join(playwrightRoot, "worker.mjs"),
    join(playwrightRoot, "playwright-worker.mjs"),
    join(playwrightRoot, "agent", "mcp-host.mjs"),
    join(playwrightRoot, "agent", "playwright-proxy.mjs"),
    join(playwrightRoot, "agent", "playwright-runner.mjs"),
    join(playwrightRoot, "agent", "runtime-client.mjs"),
    join(playwrightRoot, "node_modules", "playwright-core", "package.json"),
  ]) {
    if (statSync(path, { throwIfNoEntry: false })?.isFile() !== true) {
      throw new Error(`the staged Playwright runtime is incomplete: ${path}`);
    }
  }

  // 3. The Chromium kernel.
  const archive = resolve(
    options.chromiumArchive
      ?? process.env.NANFU_CHROMIUM_ARCHIVE?.trim()
      ?? join(tauri, "target", "nanfu-chromium", "apostate-macos.zip"),
  );
  if (statSync(archive, { throwIfNoEntry: false })?.isFile() !== true) {
    throw new Error(
      `the Nanfu macOS Chromium kernel archive is missing: ${archive}. ` +
      "Set NANFU_CHROMIUM_ARCHIVE to the apostate-<version>-macos-<arch>.zip from the kernel build.",
    );
  }
  const archiveSha256 = await sha256File(archive);
  const expectedArchive = (options.chromiumSha256 ?? process.env.NANFU_CHROMIUM_SHA256)?.trim().toLowerCase();
  if (expectedArchive && expectedArchive !== archiveSha256) {
    throw new Error(
      `the Chromium kernel archive SHA-256 mismatch: expected ${expectedArchive}, measured ${archiveSha256}`,
    );
  }

  const extracted = join(staging, "chromium-kernel");
  mkdirSync(extracted, { recursive: true });
  // ditto, not the streaming unzip the extension code uses: Chromium Framework is held together by
  // symlinks, and an extraction that stores them as ordinary files loses the bundle's signature.
  await run(["ditto", "-x", "-k", archive, extracted]);
  const app = findChromiumApp(extracted);
  if (!app) throw new Error(`the Chromium kernel archive does not contain Chromium.app: ${archive}`);
  const sourceExecutable = join(app, MACOS_CHROMIUM_EXECUTABLE);
  if (statSync(sourceExecutable, { throwIfNoEntry: false })?.isFile() !== true) {
    // Diagnose the real bundle layout instead of only saying the expected path is absent.
    const listing = (() => {
      try { return readdirSync(join(app, "Contents/MacOS")).join(", "); } catch { return "<no Contents/MacOS>"; }
    })();
    throw new Error(`the Chromium kernel archive has no ${MACOS_CHROMIUM_EXECUTABLE}: ${archive} (app=${app}; Contents/MacOS has: ${listing})`);
  }

  // One kernel is staged per bundle. Refuse a kernel built for a different processor instead of
  // shipping one that cannot exec; a universal app reports which slice it carries.
  const archs = (await capture(["lipo", "-archs", sourceExecutable])).trim().split(/\s+/);
  if (targets.length === 1 && !archs.includes(LIPO_ARCHES[targets[0]!])) {
    throw new Error(
      `the Chromium kernel is built for ${archs.join("/")} but this bundle targets ${targets[0]}`,
    );
  }

  // The kernel workflow signs with a Developer ID when it can; otherwise the bundle is unsigned,
  // which Apple Silicon refuses to run. The copy below is flattened, so a Developer ID seal cannot
  // survive: re-seal every staged copy ad-hoc, then record the hash of the sealed executable.
  const version = resolveChromiumVersion(options, app, archive);
  const directory = `chromium-${version}`;
  const destination = join(chromiumRoot, directory);
  // Tauri copies resources file by file and rejects a directory symlink, while Chromium Framework
  // is held together by them (Versions/Current, the framework binary, the helper apps). Resolve
  // them here so the staged bundle is exactly what the bundler will ship, and sign that tree.
  await run(["cp", "-R", "-L", app, destination]);
  const remainingLinks = (await capture(["find", destination, "-type", "l"])).trim();
  if (remainingLinks) {
    throw new Error(
      `the staged Chromium kernel still contains symbolic links, which Tauri's resource bundler cannot copy: ${remainingLinks.split("\n")[0]}`,
    );
  }
  chmodSync(join(destination, MACOS_CHROMIUM_EXECUTABLE), 0o755);
  // Quarantine or Finder metadata on a copied bundle makes codesign refuse to seal it.
  await run(["xattr", "-cr", destination]);
  await run(["codesign", "--force", "--deep", "--sign", "-", destination]);
  if (await runQuietly(["codesign", "--verify", "--deep", "--strict", destination]) !== 0) {
    throw new Error(`the staged Chromium kernel has an invalid code signature: ${destination}`);
  }
  const executable = join(destination, MACOS_CHROMIUM_EXECUTABLE);
  if (statSync(executable, { throwIfNoEntry: false })?.isFile() !== true) {
    throw new Error(`staging the Chromium kernel did not produce ${executable}`);
  }
  const sha256 = await sha256File(executable);

  const chromium: PreparedChromiumMetadata = {
    executable: MACOS_CHROMIUM_EXECUTABLE,
    sha256,
    version,
    archiveSha256,
  };
  writeFileSync(join(generated, "browser.json"), `${JSON.stringify({ chromium }, null, 2)}\n`, "utf8");
  writeFileSync(join(generated, "VERSION.txt"), `${ALIASMODE_VERSION}\n`, "utf8");
  return { chromium };
}

if (import.meta.main) {
  try {
    const metadata = await prepareMacosBundle();
    console.log(
      `prepared the Nanfu macOS bundle for Chromium ${metadata.chromium.version}, SHA-256 ${metadata.chromium.sha256}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
