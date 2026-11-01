/**
 * The GPU identities this computer's kernel can serve.
 *
 * The kernel embeds a capability table per GPU cluster ("anchor"): GL limits,
 * extensions, shader precisions and the WebGPU adapter. It will serve any
 * cluster named by --fingerprint-anchor, even a different vendor from the
 * physical GPU, as long as the renderer belongs to that cluster. We use that
 * to offer a real cross-vendor menu (NVIDIA / Intel / Qualcomm on Windows,
 * Apple on macOS) instead of only the host's own GPU.
 *
 * The menu is discovered from the kernel itself: point it at an anchor with a
 * bogus vendor, and its rejection lists exactly what that cluster serves.
 * This is one headless probe per anchor per app session, never a guess.
 *
 * Cross-OS anchors are deliberately not offered: a Metal (macOS) cluster on a
 * D3D11 Windows host makes the GPU process fail (error 63), so a Windows
 * window can only claim a Windows cluster and a Mac window an Apple one.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GpuAnchor {
  id: string;
  platform: "windows" | "macos";
  vendorLabel: string;
}

export interface ServableGpu {
  /** The capability cluster this identity belongs to. */
  anchor: string;
  /** Persona platform the cluster belongs to. */
  platform: "windows" | "macos";
  /** WebGL UNMASKED_VENDOR_WEBGL, e.g. "Google Inc. (NVIDIA)". */
  vendor: string;
  /** WebGL UNMASKED_RENDERER_WEBGL, e.g. "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 ...)". */
  renderer: string;
  /** Short human label, e.g. "NVIDIA GeForce RTX 4060". */
  label: string;
}

const WINDOWS_ANCHORS: readonly GpuAnchor[] = [
  { id: "windows-d3d11-nvidia-0947761dfbe9", platform: "windows", vendorLabel: "NVIDIA" },
  { id: "windows-d3d11-intel-79dfeb5b4f99", platform: "windows", vendorLabel: "Intel" },
  { id: "windows-d3d11-qualcomm-6388f9914f3f", platform: "windows", vendorLabel: "Qualcomm" },
];

const MACOS_ANCHORS: readonly GpuAnchor[] = [
  { id: "macos-metal-apple-850a91233555", platform: "macos", vendorLabel: "Apple" },
];

/** The clusters a host can honestly launch. Cross-OS clusters crash the GPU process. */
export function anchorsForHost(platform: NodeJS.Platform = process.platform): readonly GpuAnchor[] {
  if (platform === "win32") return WINDOWS_ANCHORS;
  if (platform === "darwin") return MACOS_ANCHORS;
  return [];
}

/** A display label that keeps the model but drops the ANGLE/D3D boilerplate. */
export function gpuLabel(renderer: string): string {
  const angle = /^ANGLE \((?:[^,]+,\s*)?(.+?)(?:\s+\(0x[0-9A-Fa-f]+\))?\s+Direct3D/m.exec(renderer);
  if (angle?.[1]) return angle[1].trim();
  const metal = /^ANGLE \((?:[^,]+,\s*)?(ANGLE Metal Renderer: [^,)]+)/.exec(renderer);
  if (metal?.[1]) return metal[1].trim();
  return renderer.trim();
}

/** Parse the kernel's "Servable on this host:" block for one anchor. */
export function parseServableGpus(
  output: string,
  anchor: GpuAnchor = WINDOWS_ANCHORS[0]!,
): ServableGpu[] {
  const marker = "Servable on this host:";
  const at = output.indexOf(marker);
  if (at < 0) return [];
  const gpus: ServableGpu[] = [];
  const seen = new Set<string>();
  for (const raw of output.slice(at + marker.length).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      if (gpus.length) break;
      continue;
    }
    if (line.startsWith("Pass --fingerprint-anchor")) break;
    const separator = line.indexOf(" / ");
    if (separator <= 0) continue;
    const vendor = line.slice(0, separator).trim();
    const renderer = line.slice(separator + 3).trim();
    if (!vendor || !renderer) continue;
    const key = `${vendor}\n${renderer}`;
    if (seen.has(key)) continue;
    seen.add(key);
    gpus.push({ anchor: anchor.id, platform: anchor.platform, vendor, renderer, label: gpuLabel(renderer) });
  }
  return gpus;
}

async function probeAnchor(
  executable: string,
  anchor: GpuAnchor,
  seed: number,
  timeoutMs: number,
): Promise<ServableGpu[]> {
  const directory = mkdtempSync(join(tmpdir(), "nanfu-gpu-probe-"));
  try {
    const proc = Bun.spawn([
      executable,
      "--headless=new",
      "--no-sandbox",
      `--fingerprint=${seed}`,
      `--fingerprint-anchor=${anchor.id}`,
      "--fingerprint-gpu-vendor=__nanfu_probe__",
      `--user-data-dir=${directory}`,
      "--dump-dom",
      "about:blank",
    ], { stdout: "ignore", stderr: "pipe", windowsHide: true });
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* already gone */ }
    }, timeoutMs);
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;
    clearTimeout(timer);
    return parseServableGpus(stderr, anchor);
  } finally {
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* a killed probe can hold the temp dir for a moment; leave it to the OS */
    }
  }
}

/**
 * Ask the kernel which GPU identities each same-OS cluster serves. One probe
 * per anchor; a failed anchor is skipped, never guessed.
 */
export async function probeServableGpus(
  executable: string,
  seed = 12345,
  timeoutMs = 20_000,
): Promise<ServableGpu[]> {
  const anchors = anchorsForHost();
  const results: ServableGpu[] = [];
  for (const anchor of anchors) {
    try {
      results.push(...await probeAnchor(executable, anchor, seed, timeoutMs));
    } catch {
      /* a cluster this host cannot serve is simply absent from the menu */
    }
  }
  return results;
}
