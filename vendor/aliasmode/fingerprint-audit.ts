import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Profile } from "./types.ts";

const FINGERPRINT_KEYS = ["resolution", "platformOs", "timezone", "locale", "cores", "fingerprintSeed"] as const;
type FingerprintKey = (typeof FINGERPRINT_KEYS)[number];
export type FingerprintValues = Record<FingerprintKey, string>;

export interface FingerprintAuditEntry {
  at: string;
  profileId: string;
  changes: Partial<Record<FingerprintKey, { from: string; to: string }>>;
}

/** The fingerprint fields a launch derives from, as display strings. Never includes account secrets or cookies. */
export function fingerprintValues(profile: Profile): FingerprintValues {
  return {
    resolution: `${profile.screenWidth}x${profile.screenHeight}`,
    platformOs: profile.platformOs ?? "",
    timezone: profile.timezone ?? "",
    locale: profile.locale ?? "",
    cores: profile.hardware ? String(profile.hardware.cores) : "",
    fingerprintSeed: String(profile.fingerprintSeed),
  };
}

/** The audit record for an edit, or null when no fingerprint field changed. */
export function fingerprintAuditEntry(before: FingerprintValues, after: FingerprintValues, profileId: string): FingerprintAuditEntry | null {
  const changes: FingerprintAuditEntry["changes"] = {};
  for (const key of FINGERPRINT_KEYS) {
    if (before[key] !== after[key]) changes[key] = { from: before[key], to: after[key] };
  }
  return Object.keys(changes).length ? { at: new Date().toISOString(), profileId, changes } : null;
}

/** Append one JSON line to logs/fingerprint-audit.jsonl under the state root. Best effort: a log failure never blocks a save. */
export function appendFingerprintAudit(root: string | undefined, entry: FingerprintAuditEntry | null): void {
  if (!root || !entry) return;
  try {
    const dir = join(root, "logs");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "fingerprint-audit.jsonl"), `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {}
}
