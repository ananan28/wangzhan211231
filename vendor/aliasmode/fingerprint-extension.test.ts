import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Profile } from "./types.ts";
import {
  FINGERPRINT_EXTENSION_MANIFEST,
  fingerprintExtensionContent,
  fingerprintExtensionDir,
  fingerprintExtensionFiles,
  fingerprintExtensionPlan,
  writeFingerprintExtension,
} from "./fingerprint-extension.ts";

/** A synthetic profile: no real account, proxy or cookie data. */
function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: "k1d0cd11",
    accId: "acc-fixture",
    name: "Fixture profile",
    group: "default",
    username: "fixture-user",
    password: "fixture-password",
    twofa: "",
    proxy: null,
    ua: "",
    timezone: "Asia/Shanghai",
    locale: "zh-CN",
    screenWidth: 1920,
    screenHeight: 1080,
    fingerprintSeed: 123456789,
    cookies: [],
    seeded: false,
    ...overrides,
  };
}

const proxied = () => profile({
  proxy: { type: "socks5" as const, host: "203.0.113.10", port: "1080", user: "exit-user", pass: "exit-pass" },
});

const contentFor = (value: Profile) => fingerprintExtensionContent(fingerprintExtensionPlan(value));

function written(userDataDir: string, value: Profile = profile()) {
  const dir = writeFingerprintExtension(value, userDataDir);
  return {
    dir,
    manifestText: readFileSync(join(dir, "manifest.json"), "utf8"),
    contentText: readFileSync(join(dir, "content.js"), "utf8"),
  };
}

test("writes a valid MV3 manifest whose content script runs first in the page world", () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "nanfu-fingerprint-"));
  const { dir, manifestText, contentText } = written(userDataDir);

  expect(dir).toBe(fingerprintExtensionDir(userDataDir));
  expect(dir.startsWith(userDataDir)).toBe(true);
  expect(existsSync(join(dir, "content.js"))).toBe(true);

  const manifest = JSON.parse(manifestText);
  expect(manifest).toEqual(FINGERPRINT_EXTENSION_MANIFEST);
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.content_scripts).toHaveLength(1);
  const script = manifest.content_scripts[0];
  // An isolated-world script would patch a copy of navigator that no page can read.
  expect(script.world).toBe("MAIN");
  expect(script.run_at).toBe("document_start");
  expect(script.js).toEqual(["content.js"]);
  expect(script.matches).toEqual(["http://*/*", "https://*/*"]);
  expect(script.all_frames).toBe(true);

  // The emitted script must at least parse as JavaScript.
  expect(() => new Function(contentText)).not.toThrow();
});

test("one profile writes the same bytes on every launch", () => {
  const first = written(mkdtempSync(join(tmpdir(), "nanfu-fingerprint-a-")));
  const second = written(mkdtempSync(join(tmpdir(), "nanfu-fingerprint-b-")));

  expect(first.manifestText).toBe(second.manifestText);
  expect(first.contentText).toBe(second.contentText);
  // What the writer produces is exactly the documented pair of files.
  const files = fingerprintExtensionFiles(fingerprintExtensionPlan(profile()));
  expect(files.manifest).toBe(first.manifestText);
  expect(files.content).toBe(first.contentText);
});

test("the fingerprint seed never reaches the extension, so the kernel stays the only noise source", () => {
  const one = profile({ fingerprintSeed: 1 });
  const other = profile({ fingerprintSeed: 987654321 });
  expect(fingerprintExtensionPlan(one)).toEqual(fingerprintExtensionPlan(other));
  expect(contentFor(one)).toBe(contentFor(other));
  // Neither the seed nor anything derived from it may appear.
  expect(contentFor(one)).not.toContain("987654321");
});

test("a proxy changes only the WebRTC switch, and nothing about the proxy itself is embedded", () => {
  const direct = profile();
  const proxiedProfile = proxied();
  const before = fingerprintExtensionPlan(direct);
  const after = fingerprintExtensionPlan(proxiedProfile);

  expect(before.webrtc).toBe(false);
  expect(after.webrtc).toBe(true);
  expect({ ...after, webrtc: false }).toEqual(before);

  // The plan blob is the only per-profile region of the script.
  expect(contentFor(proxiedProfile)).toBe(contentFor(direct).replace(JSON.stringify(before), JSON.stringify(after)));
  for (const secret of ["203.0.113.10", "exit-user", "exit-pass"]) {
    expect(contentFor(proxiedProfile)).not.toContain(secret);
  }
});

test("cores are taken only from stored hardware and the kernel value is never raised", () => {
  expect(fingerprintExtensionPlan(profile()).cores).toBeNull();
  expect(fingerprintExtensionPlan(profile({ hardware: { cores: 12 } })).cores).toBe(12);
  // The kernel flag wins: the script lowers an inflated value and leaves anything below it.
  expect(contentFor(profile({ hardware: { cores: 12 } }))).toContain("reported > cfg.cores");
});

test("only a plausible IANA zone is embedded, and it is inert once the kernel applied it", () => {
  expect(fingerprintExtensionPlan(profile({ timezone: "America/New_York" })).timezone).toBe("America/New_York");
  expect(fingerprintExtensionPlan(profile({ timezone: "" })).timezone).toBeNull();
  // A zone name is embedded into generated JS, so a path-shaped value must never be used.
  expect(fingerprintExtensionPlan(profile({ timezone: "../../etc/passwd" })).timezone).toBeNull();
  expect(fingerprintExtensionPlan(profile({ timezone: "Asia/Shanghai;alert(1)" })).timezone).toBeNull();
  expect(contentFor(profile({ timezone: "America/New_York" }))).toContain("reported.toLowerCase() !== target.toLowerCase()");
});

test("no absolute host path leaks into the generated extension", () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "nanfu-fingerprint-path-"));
  const { dir, manifestText, contentText } = written(userDataDir);

  for (const text of [manifestText, contentText]) {
    expect(text).not.toContain(userDataDir);
    expect(text).not.toContain(dir);
    expect(text).not.toContain(tmpdir());
    // Windows drive letter and POSIX home/root prefixes.
    expect(text).not.toMatch(/(?:^|[^A-Za-z])[A-Za-z]:\\/);
    expect(text).not.toMatch(/(?:^|["'\s=:(])\/(?:home|Users|root|tmp|var|etc|opt)\//);
  }
  // Every referenced file is relative to the extension directory.
  for (const entry of JSON.parse(manifestText).content_scripts) {
    for (const file of entry.js) expect(file).not.toMatch(/^([A-Za-z]:|[\\/])/);
  }
});
