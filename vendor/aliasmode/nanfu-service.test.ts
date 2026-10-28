import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NANFU_DEFAULT_SERVICE,
  NanfuServiceConfigError,
  loadNanfuService,
  normalizeNanfuPublishableKey,
  normalizeNanfuService,
  saveNanfuService,
} from "./nanfu-service.ts";

function serviceRoleJwt(): string {
  const payload = Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url");
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.signature`;
}

describe("Nanfu service configuration", () => {
  test("ships working defaults but keeps them replaceable", () => {
    const fromDefaults = normalizeNanfuService({ ...NANFU_DEFAULT_SERVICE });
    expect(fromDefaults.url).toBe("https://zojqxzaqumrtykcufqzg.supabase.co");
    expect(fromDefaults.publishableKey.startsWith("sb_publishable_")).toBe(true);

    const replaced = normalizeNanfuService({
      url: "https://example.supabase.co",
      publishableKey: NANFU_DEFAULT_SERVICE.publishableKey,
    });
    expect(replaced.url).toBe("https://example.supabase.co");
  });

  test("refuses a service-role key in any shape", () => {
    expect(() => normalizeNanfuPublishableKey("sb_secret_abcdefghijklmnopqrstuvwxyz")).toThrow(NanfuServiceConfigError);
    expect(() => normalizeNanfuPublishableKey(serviceRoleJwt())).toThrow(NanfuServiceConfigError);
    expect(() => normalizeNanfuPublishableKey("eyJhbGciOiJIUzI1NiJ9.notjson.sig")).toThrow(NanfuServiceConfigError);
  });

  test("refuses plaintext transport outside loopback", () => {
    expect(() =>
      normalizeNanfuService({ url: "http://example.supabase.co", publishableKey: NANFU_DEFAULT_SERVICE.publishableKey }),
    ).toThrow(NanfuServiceConfigError);
  });

  test("file and environment override the defaults, environment last", () => {
    const dir = mkdtempSync(join(tmpdir(), "nanfu-service-"));
    const file = join(dir, "nanfu-service.json");
    writeFileSync(
      file,
      JSON.stringify({ url: "https://file.supabase.co", publishableKey: NANFU_DEFAULT_SERVICE.publishableKey }),
    );
    expect(loadNanfuService({ file, env: {} }).url).toBe("https://file.supabase.co");
    expect(
      loadNanfuService({
        file,
        env: { NANFU_SUPABASE_URL: "https://env.supabase.co" },
      }).url,
    ).toBe("https://env.supabase.co");
  });

  test("a malformed file fails loudly instead of silently using defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "nanfu-service-"));
    const file = join(dir, "nanfu-service.json");
    writeFileSync(file, "{not json");
    expect(() => loadNanfuService({ file, env: {} })).toThrow(NanfuServiceConfigError);
  });

  test("save writes a private file that loads back unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "nanfu-service-"));
    const file = join(dir, "nanfu-service.json");
    const saved = saveNanfuService(file, {
      url: "https://saved.supabase.co",
      publishableKey: NANFU_DEFAULT_SERVICE.publishableKey,
    });
    expect(readFileSync(file, "utf8")).toContain("saved.supabase.co");
    expect(loadNanfuService({ file, env: {} })).toEqual(saved);
  });
});
