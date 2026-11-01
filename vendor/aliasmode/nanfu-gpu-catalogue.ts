/**
 * The GPU identities this computer's kernel can actually serve.
 *
 * The kernel composes a GPU from the fingerprint seed and anchors its GL /
 * WebGPU capability tables to this host's physical adapter cluster. An
 * operator override is honoured only when the vendor/renderer pair belongs to
 * that cluster; anything else stops the browser at startup with the list below.
 * We use that rejection deliberately: one headless probe per app session gives
 * the exact menu the edit dialog can offer, so a stored GPU can never make a
 * window unlaunchable.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ServableGpu {
  /** WebGL UNMASKED_VENDOR_WEBGL, e.g. "Google Inc. (NVIDIA)". */
  vendor: string;
  /** WebGL UNMASKED_RENDERER_WEBGL, e.g. "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 ...)". */
  renderer: string;
  /** Short human label, e.g. "NVIDIA GeForce RTX 4060". */
  label: string;
}

/** A display label that keeps the model but drops the ANGLE/D3D boilerplate. */
export function gpuLabel(renderer: string): string {
  const angle = /^ANGLE \((?:[^,]+,\s*)?(.+?)(?:\s+\(0x[0-9A-Fa-f]+\))?\s+Direct3D/m.exec(renderer);
  if (angle?.[1]) return angle[1].trim();
  const metal = /^ANGLE \((?:[^,]+,\s*)?(ANGLE Metal Renderer: [^,)]+)/.exec(renderer);
  if (metal?.[1]) return metal[1].trim();
  return renderer.trim();
}

/** Parse the kernel's "Servable on this host:" block from a rejected override. */
export function parseServableGpus(output: string): ServableGpu[] {
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
    gpus.push({ vendor, renderer, label: gpuLabel(renderer) });
  }
  return gpus;
}

/**
 * Ask the kernel which GPU identities this host can serve. The probe points at
 * a temporary profile and exits immediately with the rejection message; it
 * never touches an operator profile.
 */
export async function probeServableGpus(
  executable: string,
  seed = 12345,
  timeoutMs = 20_000,
): Promise<ServableGpu[]> {
  const directory = mkdtempSync(join(tmpdir(), "nanfu-gpu-probe-"));
  try {
    const proc = Bun.spawn([
      executable,
      "--headless=new",
      "--no-sandbox",
      `--fingerprint=${seed}`,
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
    return parseServableGpus(stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
