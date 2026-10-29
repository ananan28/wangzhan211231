/**
 * Deterministic defaults for a new environment. The timezone is drawn from
 * common US zones, but the draw is a pure function of the draft seed so the
 * dialog never re-rolls on a re-render and the same seed reproduces the zone.
 */

export const US_TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
] as const;

/** Empty means "follow this computer" for the language tag. */
export const NEW_PROFILE_LOCALE = "";

/** FNV-1a over code units: small, stable, and independent of host ICU data. */
function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function usTimezoneForSeed(seed: string): string {
  const text = seed.trim() || "nanfu";
  return US_TIMEZONES[hashSeed(text) % US_TIMEZONES.length] ?? US_TIMEZONES[0];
}

/** A fresh seed for one create-dialog draft; the timezone stays put until the dialog closes. */
export function draftTimezoneSeed(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    // Fall through to the timestamp seed below.
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export const PROFILE_DISK_MB_MIN = 300;
export const PROFILE_DISK_MB_MAX = 600;

export function estimateBatchDiskBytes(count: number): { minBytes: number; maxBytes: number } {
  const safeCount = Number.isFinite(count) && count > 0 ? Math.ceil(count) : 0;
  return {
    minBytes: safeCount * PROFILE_DISK_MB_MIN * 1024 ** 2,
    maxBytes: safeCount * PROFILE_DISK_MB_MAX * 1024 ** 2,
  };
}

/** Human-readable estimate for the large-batch confirmation. */
export function formatBatchDiskEstimate(count: number): string {
  const { minBytes, maxBytes } = estimateBatchDiskBytes(count);
  const gigabytes = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
  return `${gigabytes(minBytes)}–${gigabytes(maxBytes)} GB`;
}
