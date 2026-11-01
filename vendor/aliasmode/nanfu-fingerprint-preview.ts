/**
 * Show what the kernel actually composes for a window before it launches.
 *
 * `--fingerprint-explain` prints the full composition: the GPU anchor, CPU,
 * memory, panel, fonts, media topology, voices, battery, theme and every
 * limitation. That is the difference between a control panel and a shell: the
 * operator can see the real values instead of trusting an "Automatic" label.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveFingerprintFlags } from "./fingerprint.ts";
import type { Profile } from "./types.ts";

export interface FingerprintSurface {
  surface: string;
  layer: string;
  evidence: string;
  value: string;
}

export interface FingerprintPreview {
  surfaces: FingerprintSurface[];
  limitations: string[];
}

/** Parse the fixed-width table printed by --fingerprint-explain. */
export function parseFingerprintExplain(output: string): FingerprintPreview {
  const surfaces: FingerprintSurface[] = [];
  const limitations: string[] = [];
  let section: "none" | "surfaces" | "limitations" = "none";
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    if (/^surface\s+layer\s+evidence\s+value/.test(line.trim())) {
      section = "surfaces";
      continue;
    }
    if (line.trim() === "limitations") {
      section = "limitations";
      continue;
    }
    if (section === "limitations") {
      const match = /^\s*-\s+(.*)$/.exec(line);
      if (match?.[1]) limitations.push(match[1].trim());
      continue;
    }
    if (section !== "surfaces") continue;
    // Notes under a row start with "! " and belong to the previous surface.
    if (/^\s*!/.test(line)) continue;
    const parts = line.split(/\s{2,}/);
    if (parts.length < 4) continue;
    const [surface, layer, evidence, ...rest] = parts;
    surfaces.push({
      surface: surface!.trim(),
      layer: layer!.trim(),
      evidence: evidence!.trim(),
      value: rest.join("  ").trim(),
    });
  }
  return { surfaces, limitations };
}

/** The handful of surfaces a person recognises, in display order. */
export const PREVIEW_SURFACE_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["gpu_identity", "显卡"],
  ["webgpu", "WebGPU"],
  ["cpu", "CPU"],
  ["memory", "内存"],
  ["panel", "分辨率"],
  ["os_release", "系统版本"],
  ["machine_class", "机型"],
  ["font_packs/platform-core", "核心字体"],
  ["media_topology", "媒体设备"],
  ["voices", "语音"],
  ["audio", "音频"],
  ["battery", "电池"],
  ["theme", "主题"],
  ["locale.timezone", "时区"],
  ["locale.application", "语言"],
];

export function summarizeFingerprintPreview(preview: FingerprintPreview): FingerprintSurface[] {
  const byName = new Map(preview.surfaces.map((surface) => [surface.surface, surface]));
  const picked: FingerprintSurface[] = [];
  for (const [name, label] of PREVIEW_SURFACE_LABELS) {
    const surface = byName.get(name);
    if (surface) picked.push({ ...surface, surface: label });
  }
  return picked;
}

/** Run the kernel's own explain for this profile. */
export async function renderFingerprintPreview(
  executable: string,
  profile: Profile,
  timeoutMs = 20_000,
): Promise<FingerprintPreview> {
  const directory = mkdtempSync(join(tmpdir(), "nanfu-fp-preview-"));
  try {
    const proc = Bun.spawn([
      executable,
      "--headless=new",
      "--no-sandbox",
      "--fingerprint-explain",
      ...deriveFingerprintFlags(profile),
      `--user-data-dir=${directory}`,
      "--dump-dom",
      "about:blank",
    ], { stdout: "pipe", stderr: "pipe", windowsHide: true });
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* already gone */ }
    }, timeoutMs);
    // The composition table goes to stdout; launch errors go to stderr.
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    clearTimeout(timer);
    const preview = parseFingerprintExplain(`${stdout}\n${stderr}`);
    if (!preview.surfaces.length) {
      const first = stderr.split(/\r?\n/).find((line) => line.trim());
      throw new Error(first?.trim() || "内核没有返回指纹组合");
    }
    return preview;
  } finally {
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* a killed preview can hold the temp dir for a moment */
    }
  }
}
