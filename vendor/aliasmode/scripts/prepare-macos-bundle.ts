/**
 * Stages the Nanfu macOS bundle: the Chromium kernel archive, the Bun sidecar(s) and the agent runtime.
 *
 * The Windows bundle ships the same three things (see prepare-windows-bundle.ts); macOS differs in
 * three ways, all handled here:
 *   - the kernel is a per-run artifact of .github/workflows/nanfu-macos-kernel.yml, so it arrives as
 *     an archive whose SHA-256 the caller passes in rather than a published release;
 *   - the kernel is staged as that archive plus a manifest, never as an unpacked Chromium.app:
 *     Tauri copies resources file by file and resolves symlinks, which flattens Chromium Framework
 *     and invalidates its signature. The app extracts the archive with ditto on first launch into
 *     its data directory, where the symlinks survive, and runs the kernel from there;
 *   - no Firefox is staged: the Nanfu macOS app is Chromium-only, matching the Windows installer.
 */
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sha256File } from "../browser-install.ts";
import { installSourceNode } from "../source-runtime.ts";
import { ALIASMODE_VERSION } from "../version.ts";
import { compileSidecar, stageAgentRuntime } from "./prepare-windows-bundle.ts";

/** The executable inside Chromium.app; the same relative path the sidecar's macOS pin uses. */
export const MACOS_CHROMIUM_EXECUTABLE = "Chromium.app/Contents/MacOS/Chromium";
/** The resource subdirectory Tauri maps src-tauri/resources/chromium/ to. */
export const MACOS_CHROMIUM_RESOURCE = "chromium";
/** The kernel archive staged as a resource; the app extracts it into its data directory. */
export const MACOS_KERNEL_ARCHIVE = "nanfu-kernel.zip";
/** Version, executable and SHA-256 of the staged kernel; src-tauri/src/browser.rs reads it. */
export const MACOS_KERNEL_MANIFEST = "nanfu-kernel.json";

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

async function capture(command: string[]): Promise<string> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "inherit" });
  const output = await new Response(child.stdout).text();
  const code = await child.exited;
  if (code !== 0) throw new Error(`${command[0]} exited with code ${code}`);
  return output;
}

/** The zip's entry names; listing reads the central directory, never the 650 MB payload. */
async function archiveEntries(archive: string): Promise<string[]> {
  const listing = await capture(["unzip", "-Z1", archive]);
  return listing.split(/\r?\n/).filter(Boolean);
}

/** Extracts only the named entries, so hashing the executable never unpacks the whole tree. */
async function extractArchiveEntries(archive: string, entries: readonly string[], destination: string): Promise<void> {
  await run(["unzip", "-o", "-q", archive, ...entries, "-d", destination]);
}

/** apostate-<version>-macos-<arch>.zip / nanfu-chromium-<version>-macos-x64.zip */
function archiveVersion(archive: string): string | undefined {
  return /(\d+\.\d+\.\d+(?:\.\d+)*)-macos-(?:arm64|x64)\.zip$/i.exec(archive)?.[1];
}

/** apostate-<version>-macos-<arch>/, the folder package-artifact.sh puts Chromium.app in. */
function folderVersion(folder: string): string | undefined {
  return /(\d+\.\d+\.\d+(?:\.\d+)*)-macos-(?:arm64|x64)\//i.exec(folder)?.[1];
}

function resolveChromiumVersion(
  options: PrepareMacosBundleOptions,
  sourceVersion: string | undefined,
  archive: string,
): string {
  const version = (options.chromiumVersion ?? process.env.NANFU_CHROMIUM_VERSION ?? sourceVersion ?? archiveVersion(archive) ?? "").trim();
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

  const entries = await archiveEntries(archive);
  const executableEntry = entries.find(
    (entry) => entry === MACOS_CHROMIUM_EXECUTABLE || entry.endsWith(`/${MACOS_CHROMIUM_EXECUTABLE}`),
  );
  if (!executableEntry) {
    throw new Error(`the Chromium kernel archive contains no ${MACOS_CHROMIUM_EXECUTABLE}: ${archive}`);
  }
  // Everything before Contents/MacOS/Chromium: "" at the archive root, or its top-level folder.
  const appPrefix = executableEntry.slice(0, executableEntry.length - MACOS_CHROMIUM_EXECUTABLE.length);
  const infoPlistEntry = `${appPrefix}Contents/Info.plist`;
  const wanted = entries.includes(infoPlistEntry) ? [executableEntry, infoPlistEntry] : [executableEntry];

  // Hash the executable as the app will find it inside the archive. Extracting only these entries
  // keeps preparation fast; the whole tree is never unpacked here.
  const scratch = mkdtempSync(join(tmpdir(), "nanfu-kernel-"));
  let executableSha256: string | undefined;
  let plistVersion: string | undefined;
  try {
    await extractArchiveEntries(archive, wanted, scratch);
    const executableFile = join(scratch, ...executableEntry.split("/"));
    if (statSync(executableFile, { throwIfNoEntry: false })?.isFile() !== true) {
      throw new Error(`unzip did not extract ${executableEntry} from the kernel archive: ${archive}`);
    }
    executableSha256 = await sha256File(executableFile);
    if (wanted.length > 1) {
      const plist = readFileSync(join(scratch, ...infoPlistEntry.split("/")), "utf8");
      plistVersion = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1]?.trim();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (!executableSha256) {
    throw new Error(`could not hash ${executableEntry} inside the kernel archive: ${archive}`);
  }
  const version = resolveChromiumVersion(options, plistVersion || folderVersion(appPrefix), archive);

  // Stage the archive itself. Tauri copies resources file by file and resolves symlinks, which
  // flattens Chromium Framework and invalidates the nested signature; an opaque zip keeps the
  // bundle exactly as the kernel workflow signed it. The app extracts it on first launch.
  cpSync(archive, join(chromiumRoot, MACOS_KERNEL_ARCHIVE));
  const chromium: PreparedChromiumMetadata = {
    executable: MACOS_CHROMIUM_EXECUTABLE,
    sha256: executableSha256,
    version,
    archiveSha256,
  };
  // src-tauri/src/browser.rs validates this manifest, then extracts the archive into the app's
  // data directory and runs Chromium.app from there.
  writeFileSync(
    join(chromiumRoot, MACOS_KERNEL_MANIFEST),
    `${JSON.stringify(chromium, null, 2)}\n`,
    "utf8",
  );
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
