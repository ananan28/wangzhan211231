import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileStore } from "./store.ts";
import { buildNewProfile } from "./create.ts";
import { deriveFingerprintFlags } from "./fingerprint.ts";
import { handleUiRequest } from "./ui.ts";

test("language, timezone, CPU and seed can be chosen at creation and edited afterwards", async () => {
  const store = new ProfileStore(":memory:");
  const root = mkdtempSync(join(tmpdir(), "nanfu-fingerprint-"));
  try {
    const created = buildNewProfile({
      name: "Fingerprint round trip", engine: "chromium", chromiumRuntime: "aliasmode",
      locale: "fr-FR", timezone: "Europe/Paris", cores: "6", seed: "123456",
    }, () => false);
    expect(created).toMatchObject({
      locale: "fr-FR", timezone: "Europe/Paris", timezoneManual: true,
      fingerprintSeed: 123456, hardware: { cores: 6 },
    });
    const flags = deriveFingerprintFlags(created, 64);
    expect(flags).toContain("--fingerprint=123456");
    expect(flags).toContain("--fingerprint-locale=fr-FR");
    expect(flags).toContain("--fingerprint-timezone=Europe/Paris");
    expect(flags).toContain("--fingerprint-hardware-concurrency=6");
    store.upsertProfile(created);

    const response = await handleUiRequest(new Request(`http://x/ui/api/profiles/${created.id}/update`, {
      method: "POST", body: JSON.stringify({ set: { locale: "de-DE", cores: "8" } }),
    }), {} as never, store, null, { paths: { root } as never });
    expect(response!.status).toBe(200);

    const saved = store.getProfile(created.id)!;
    expect(saved).toMatchObject({ locale: "de-DE", timezone: "Europe/Paris", fingerprintSeed: 123456, hardware: { cores: 8 } });
    const edited = deriveFingerprintFlags(saved, 64);
    expect(edited).toContain("--fingerprint-locale=de-DE");
    expect(edited).toContain("--fingerprint-hardware-concurrency=8");

    const audit = readFileSync(join(root, "logs", "fingerprint-audit.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(audit.at(-1)).toMatchObject({
      profileId: created.id,
      changes: { locale: { from: "fr-FR", to: "de-DE" }, cores: { from: "6", to: "8" } },
    });
    expect(Object.keys(audit.at(-1).changes).sort()).toEqual(["cores", "locale"]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid creation-time fingerprint values are rejected instead of half-saved", () => {
  expect(() => buildNewProfile({ locale: "not a language tag" }, () => false)).toThrow();
  expect(() => buildNewProfile({ timezone: "Mars/Olympus" }, () => false)).toThrow();
  expect(() => buildNewProfile({ cores: "0" }, () => false)).toThrow();
  expect(() => buildNewProfile({ seed: "abc" }, () => false)).toThrow();
});

test("a typed timezone at creation survives a later proxy change", async () => {
  const store = new ProfileStore(":memory:");
  try {
    const created = buildNewProfile({ engine: "chromium", chromiumRuntime: "aliasmode", timezone: "Asia/Shanghai" }, () => false);
    store.upsertProfile(created);
    const response = await handleUiRequest(new Request(`http://x/ui/api/profiles/${created.id}/update`, {
      method: "POST", body: JSON.stringify({ set: { proxyType: "http", proxy: "new-proxy.example:8080" } }),
    }), {} as never, store, null, { timezoneFetch: async () => ({ json: async () => ({ status: "success", timezone: "Europe/Paris" }) }) } as never });
    expect(response!.status).toBe(200);
    expect(store.getProfile(created.id)!.timezone).toBe("Asia/Shanghai");
  } finally {
    store.close();
  }
});
