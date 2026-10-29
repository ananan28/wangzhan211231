import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildNewProfile } from "./create.ts";
import {
  FINGERPRINT_CONTENT_SOURCE,
  FINGERPRINT_EXTENSION,
  FINGERPRINT_EXTENSION_REVISION,
  FINGERPRINT_MANIFEST,
  fingerprintExtensionConfig,
  fingerprintExtensionContent,
  fingerprintExtensionDir,
  installFingerprintExtension,
} from "./fingerprint-extension.ts";
import type { Profile } from "./types.ts";

const seeded = (seed: string, locale = "en-US"): Profile => buildNewProfile({
  engine: "chromium", chromiumRuntime: "aliasmode", seed, locale, timezone: "America/New_York",
}, () => false);

const withProfileDir = <T>(run: (userDataDir: string) => T): T => {
  const root = mkdtempSync(join(tmpdir(), "nanfu-fp-extension-"));
  try {
    return run(join(root, "profile"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("the config is a pure function of the stored profile", () => {
  const profile = seeded("1200001");
  const first = fingerprintExtensionConfig(profile);
  const second = fingerprintExtensionConfig({ ...profile });
  expect(second).toEqual(first);
  expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  expect(first).toMatchObject({ revision: FINGERPRINT_EXTENSION_REVISION, seed: 1200001, locale: "en-US" });
  // Every derived value keeps the shape a real engine reports.
  expect(first.clientRects.amplitude).toBeGreaterThan(0);
  expect(first.clientRects.amplitude).toBeLessThan(0.06);
  expect([4, 8]).toContain(first.deviceMemory);
  expect(first.voices.length).toBeGreaterThanOrEqual(2);
  expect(first.voices[0]!.default).toBe(true);
  expect(first.fonts.length).toBeGreaterThanOrEqual(12);
  for (const ids of [first.mediaDevices.audioinput, first.mediaDevices.audiooutput, first.mediaDevices.videoinput]) {
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{64}$/);
  }
  for (const group of first.mediaDevices.groups) expect(group).toMatch(/^[0-9a-f]{64}$/);
  expect(first.webgpu.limits.maxTextureDimension2D).toBeGreaterThan(0);
});

test("two profiles never share a seed-derived value", () => {
  const a = fingerprintExtensionConfig(seeded("1200001"));
  const b = fingerprintExtensionConfig(seeded("9900777"));
  expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  expect(a.mediaDevices.audioinput[0]).not.toBe(b.mediaDevices.audioinput[0]);
  expect(a.mediaDevices.groups[0]).not.toBe(b.mediaDevices.groups[0]);
  expect(a.clientRects.amplitude).not.toBe(b.clientRects.amplitude);
  expect(a.mediaDevices.videoinput[0]).not.toBe(b.mediaDevices.videoinput[0]);

  // The locale the page will read follows the profile, not the host.
  const chinese = fingerprintExtensionConfig(seeded("1200001", "zh-CN"));
  expect(chinese.voices.every((voice) => voice.lang === "zh-CN")).toBe(true);
  expect(chinese.fonts.some((family) => /SimSun|YaHei|PingFang|Noto Sans CJK/.test(family))).toBe(true);
});

test("the helper carries no upstream vendor name", () => {
  const config = fingerprintExtensionConfig(seeded("1200001"));
  const delivered = [
    JSON.stringify(FINGERPRINT_MANIFEST),
    JSON.stringify(config),
    fingerprintExtensionContent(config),
  ].join("\n").toLowerCase();
  for (const brand of ["cloakbrowser", "camoufox", "adspower", "aliasmode"]) {
    expect(delivered).not.toContain(brand);
  }
});

test("the written directory is a valid document_start MV3 helper", () => {
  withProfileDir((userDataDir) => {
    const profile = seeded("1200001");
    const installed = installFingerprintExtension(userDataDir, profile);
    expect(installed.directory).toBe(fingerprintExtensionDir(userDataDir));
    expect(installed.rewritten).toBe(true);
    for (const asset of ["manifest.json", "config.json", "content.js"]) {
      expect(existsSync(join(installed.directory, asset))).toBe(true);
    }
    const manifest = JSON.parse(readFileSync(join(installed.directory, "manifest.json"), "utf8"));
    expect(manifest).toEqual(FINGERPRINT_MANIFEST);
    expect(manifest.manifest_version).toBe(3);
    const scripts = manifest.content_scripts;
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toMatchObject({
      js: ["content.js"],
      run_at: "document_start",
      all_frames: true,
      match_about_blank: true,
      world: "MAIN",
      matches: ["<all_urls>"],
    });
    // The delivered config is the exact object the pure function produced.
    expect(JSON.parse(readFileSync(join(installed.directory, "config.json"), "utf8"))).toEqual(fingerprintExtensionConfig(profile));
    const content = readFileSync(join(installed.directory, "content.js"), "utf8");
    expect(content).toContain(JSON.stringify(fingerprintExtensionConfig(profile)));
    expect(content).not.toContain("__NANFU_FP_CONFIG__");
  });
});

test("patches keep native shapes and never leak a global", () => {
  const source = FINGERPRINT_CONTENT_SOURCE;
  expect(source).toContain("Object.getOwnPropertyDescriptor");
  expect(source).toContain("[native code]");
  expect(source).toContain('"deviceMemory" in navigator');
  expect(source).toContain("queryLocalFonts");
  expect(source).toContain("SpeechSynthesis");
  expect(source).toContain("GPUAdapter");
  expect(source).toContain("enumerateDevices");
  expect(source).toContain("getBoundingClientRect");
  expect(source).toContain("getClientRects");
  // The gap-fill guards: an engine answer wins over ours.
  expect(source).toContain('String(info.vendor || "").length > 0');
  expect(source).toContain("if (coherent) return native;");
  // Nothing may be published on window or document for a page to read.
  expect(source).not.toMatch(/window\.[A-Za-z_$][\w$]*\s*=[^=]/);
  expect(source).not.toMatch(/document\.[A-Za-z_$][\w$]*\s*=[^=]/);
});

test("a revision change, a changed config or a stale file rewrites the directory", () => {
  withProfileDir((userDataDir) => {
    const profile = seeded("1200001");
    installFingerprintExtension(userDataDir, profile);
    // An unchanged launch reuses the copy instead of touching the disk.
    expect(installFingerprintExtension(userDataDir, profile).rewritten).toBe(false);

    const directory = fingerprintExtensionDir(userDataDir);
    writeFileSync(join(directory, "content.js"), "left over from an older helper");
    writeFileSync(join(directory, "stamp"), "0 deadbeef");
    mkdirSync(join(directory, "nested"));
    writeFileSync(join(directory, "nested", "old.js"), "stale");
    const rewritten = installFingerprintExtension(userDataDir, profile);
    expect(rewritten.rewritten).toBe(true);
    expect(existsSync(join(directory, "nested"))).toBe(false);
    const restored = readFileSync(join(directory, "content.js"), "utf8");
    expect(restored).toContain("getVoices");
    expect(restored).not.toContain("left over");

    // A different persona re-renders the same directory in place.
    const other = seeded("9900777");
    expect(installFingerprintExtension(userDataDir, other).rewritten).toBe(true);
    expect(JSON.parse(readFileSync(join(directory, "config.json"), "utf8"))).toEqual(fingerprintExtensionConfig(other));
  });
});

test("the layer is on by default and stays inside the Chromium runtime", () => {
  expect(FINGERPRINT_EXTENSION).toBe(true);
  expect(FINGERPRINT_EXTENSION_REVISION).toBeGreaterThan(0);
});
