import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildNewProfile, type NewProfileInput } from "./create.ts";
import {
  FINGERPRINT_CONTENT_SOURCE,
  FINGERPRINT_EXTENSION,
  FINGERPRINT_EXTENSION_REVISION,
  FINGERPRINT_MANIFEST,
  fingerprintExtensionConfig,
  fingerprintExtensionContent,
  fingerprintExtensionDir,
  fingerprintExtensionEnabled,
  installFingerprintExtension,
} from "./fingerprint-extension.ts";
import type { Profile } from "./types.ts";

const seeded = (seed: string, locale = "en-US", extra: Partial<NewProfileInput> = {}): Profile => buildNewProfile({
  engine: "chromium", chromiumRuntime: "aliasmode", seed, locale, timezone: "America/New_York", ...extra,
}, () => false);

/** A proxy on a private address, so a config that depended on the proxy would be visible. */
const PROXY = { type: "socks5", host: "10.1.2.3", port: "1080", user: "operator", pass: "secret" };

const withProfileDir = <T>(run: (userDataDir: string) => T): T => {
  const root = mkdtempSync(join(tmpdir(), "nanfu-fp-extension-"));
  try {
    return run(join(root, "profile"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

interface Delivered {
  manifest: Buffer;
  config: Buffer;
  content: Buffer;
  stamp: Buffer;
}

/** The exact bytes a launch would deliver for one profile. */
const deliver = (profile: Profile): Delivered => withProfileDir((userDataDir) => {
  const installed = installFingerprintExtension(userDataDir, profile);
  const read = (name: string) => readFileSync(join(installed.directory, name));
  return { manifest: read("manifest.json"), config: read("config.json"), content: read("content.js"), stamp: read("stamp") };
});

const changedFields = (a: object, b: object): string[] => {
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].filter((key) => JSON.stringify(left[key]) !== JSON.stringify(right[key])).sort();
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

test("the same profile delivers byte-identical files on every generation", () => {
  const profile = seeded("1200001", "en-US", { cores: "12", proxy: PROXY });
  const first = deliver(profile);
  const second = deliver(profile);
  for (const name of ["manifest", "config", "content", "stamp"] as const) {
    expect(second[name].equals(first[name])).toBe(true);
  }
  // The stamp covers both files, so an unchanged launch can reuse the directory.
  const stamp = first.stamp.toString("utf8").trim();
  expect(stamp.startsWith(`${FINGERPRINT_EXTENSION_REVISION} `)).toBe(true);
  expect(stamp.split(" ")[1]!).toMatch(/^[0-9a-f]{64}$/);
});

test("a different seed changes only the seed-derived fields", () => {
  const first = fingerprintExtensionConfig(seeded("1200001", "en-US", { cores: "12", proxy: PROXY }));
  const second = fingerprintExtensionConfig(seeded("9900777", "en-US", { cores: "12", proxy: PROXY }));
  const changed = changedFields(first, second);
  expect(changed).toContain("seed");
  expect(changed).toContain("mediaDevices");
  for (const key of changed) {
    expect(["seed", "clientRects", "webgpu", "fonts", "voices", "mediaDevices", "deviceMemory"]).toContain(key);
  }
  // The profile's own claims and the switch attributes do not move with the seed.
  expect(second.hardwareConcurrency).toBe(12);
  expect(second.webRtc).toEqual({ filterHostCandidates: true });
  expect(second.revision).toBe(first.revision);
  expect(second.platform).toBe(first.platform);
  expect(second.locale).toBe(first.locale);
});

test("a different proxy changes only the WebRTC field, and nothing when both have one", () => {
  const direct = seeded("1200001");
  const proxied = seeded("1200001", "en-US", { proxy: PROXY });
  const otherProxy = seeded("1200001", "en-US", { proxy: { ...PROXY, host: "203.0.113.7", port: "8080" } });
  const directConfig = fingerprintExtensionConfig(direct);
  const proxiedConfig = fingerprintExtensionConfig(proxied);

  expect(directConfig).not.toHaveProperty("webRtc");
  expect(proxiedConfig.webRtc).toEqual({ filterHostCandidates: true });
  expect(changedFields(directConfig, proxiedConfig)).toEqual(["webRtc"]);
  // The proxy address itself is never part of the delivered file.
  expect(fingerprintExtensionContent(proxiedConfig)).not.toContain(PROXY.host);
  expect(fingerprintExtensionContent(proxiedConfig)).not.toContain(PROXY.pass);
  // Two proxies for one persona deliver the same bytes: only "has a proxy" matters.
  expect(fingerprintExtensionConfig(otherProxy)).toEqual(proxiedConfig);
  expect(fingerprintExtensionContent(fingerprintExtensionConfig(otherProxy)))
    .toBe(fingerprintExtensionContent(proxiedConfig));
});

test("the profile's core count is delivered as a ceiling, and nothing when unset", () => {
  const bare = fingerprintExtensionConfig(seeded("1200001"));
  expect(bare).not.toHaveProperty("hardwareConcurrency");
  const claimed = fingerprintExtensionConfig(seeded("1200001", "en-US", { cores: "8" }));
  expect(claimed.hardwareConcurrency).toBe(8);
  expect(changedFields(bare, claimed)).toEqual(["hardwareConcurrency"]);
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
    expect(Object.keys(manifest).sort()).toEqual(["content_scripts", "description", "manifest_version", "name", "version"]);
    expect(typeof manifest.name).toBe("string");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    const scripts = manifest.content_scripts;
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toMatchObject({
      js: ["content.js"],
      run_at: "document_start",
      all_frames: true,
      match_about_blank: true,
      match_origin_as_fallback: true,
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

test("no delivered file names a path on this computer", () => {
  withProfileDir((userDataDir) => {
    const profile = seeded("1200001", "en-US", { cores: "12", proxy: PROXY });
    const installed = installFingerprintExtension(userDataDir, profile);
    const delivered = ["manifest.json", "config.json", "content.js", "stamp"].map((name) => ({
      name,
      text: readFileSync(join(installed.directory, name), "utf8"),
    }));
    for (const file of delivered) {
      // No file URL, no Windows drive path, no POSIX home or temp path, no UNC path.
      expect(file.text).not.toMatch(/file:\/\//i);
      expect(file.text).not.toMatch(/(^|[^A-Za-z0-9._-])[A-Za-z]:[\\/]/m);
      expect(file.text).not.toMatch(/(^|[^A-Za-z0-9._-])\/(?:Users|home|tmp|var\/folders)\//);
      expect(file.text).not.toMatch(/\\\\[A-Za-z0-9._-]+\\/);
      // And specifically not this profile's own directory or its temporary root.
      expect(file.text).not.toContain(installed.directory);
      expect(file.text).not.toContain(userDataDir);
      expect(file.text).not.toContain(tmpdir());
    }
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

test("the layer leaves the surfaces the engine already answers alone", () => {
  const source = FINGERPRINT_CONTENT_SOURCE;
  // The engine's patch series keeps navigator.webdriver false from every launch
  // switch; a JS override would only mask a client's explicit request.
  expect(source).not.toContain("webdriver");
  // The engine sets the ICU zone in every process, which is the only way Date,
  // Intl and Date#toString can agree. A JS clock patch cannot, so there is none.
  expect(source).not.toContain("getTimezoneOffset");
  expect(source).not.toContain("DateTimeFormat");
  expect(source).not.toContain("toLocaleString");
});

test("the core-count patch is a ceiling over the engine's own answer", () => {
  const source = FINGERPRINT_CONTENT_SOURCE;
  expect(source).toContain("CONFIG.hardwareConcurrency");
  expect(source).toContain("native > ceiling ? ceiling : native");
  expect(source).toContain('replace(Navigator.prototype, "hardwareConcurrency"');
  expect(source).toContain('replace(WorkerNavigator.prototype, "hardwareConcurrency"');
});

test("the plugin patch fills only an empty list and keeps the desktop PDF triple", () => {
  const source = FINGERPRINT_CONTENT_SOURCE;
  expect(source).toContain("if (native && native.length > 0) return native;");
  expect(source).toContain('"PDF Viewer"');
  expect(source).toContain('"Chrome PDF Viewer"');
  expect(source).toContain('"Chromium PDF Viewer"');
  expect(source).toContain('"application/pdf"');
  expect(source).toContain('"text/pdf"');
  expect(source).toContain('replace(Navigator.prototype, "plugins"');
  expect(source).toContain('replace(Navigator.prototype, "mimeTypes"');
});

test("the candidate filter keeps srflx and relay and is off without a proxy", () => {
  const source = FINGERPRINT_CONTENT_SOURCE;
  expect(source).toContain("CONFIG.webRtc");
  expect(source).toContain("filterHostCandidates");
  // Only host candidates are candidates for removal; srflx/relay/prflx never are.
  expect(source).toContain('return type === "host" && privateAddress(address);');
  expect(source).toContain('match[2].toLowerCase() !== "host"');
  // Both the candidate events and the local SDP are covered, and a listener is
  // still removable after being wrapped.
  expect(source).toContain('"onicecandidate"');
  expect(source).toContain('"localDescription", "currentLocalDescription", "pendingLocalDescription"');
  expect(source).toContain('"removeEventListener", false');
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

test("the switch is off unless NANFU_FINGERPRINT_JS=1, and the layer stays inside the Chromium runtime", () => {
  expect(fingerprintExtensionEnabled({})).toBe(false);
  expect(fingerprintExtensionEnabled({ NANFU_FINGERPRINT_JS: "" })).toBe(false);
  expect(fingerprintExtensionEnabled({ NANFU_FINGERPRINT_JS: "0" })).toBe(false);
  expect(fingerprintExtensionEnabled({ NANFU_FINGERPRINT_JS: "true" })).toBe(false);
  expect(fingerprintExtensionEnabled({ NANFU_FINGERPRINT_JS: "1" })).toBe(true);
  // The exported constant is that same decision for this process.
  expect(FINGERPRINT_EXTENSION).toBe(fingerprintExtensionEnabled(process.env));
  expect(FINGERPRINT_EXTENSION).toBe(process.env.NANFU_FINGERPRINT_JS === "1");
  expect(FINGERPRINT_EXTENSION_REVISION).toBeGreaterThanOrEqual(2);
});
