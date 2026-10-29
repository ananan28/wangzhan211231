import { test, expect } from "bun:test";
import {
  NEW_PROFILE_LOCALE,
  US_TIMEZONES,
  draftTimezoneSeed,
  estimateBatchDiskBytes,
  formatBatchDiskEstimate,
  usTimezoneForSeed,
} from "./creation-defaults";

const ZONES: readonly string[] = US_TIMEZONES;

test("new profiles follow this computer's language by default", () => {
  expect(NEW_PROFILE_LOCALE).toBe("");
});

test("the default US timezone is repeatable for the same seed", () => {
  for (const seed of ["draft-1", "env-42", "  spaced seed  ", "指纹种子"]) {
    const first = usTimezoneForSeed(seed);
    const second = usTimezoneForSeed(seed);
    expect(first).toBe(second);
    expect(ZONES.includes(first)).toBe(true);
  }
});

test("different seeds reach more than one US zone", () => {
  const zones = new Set(Array.from({ length: 64 }, (_, index) => usTimezoneForSeed(String(index))));
  expect(zones.size).toBeGreaterThan(1);
  for (const zone of zones) expect(ZONES.includes(zone)).toBe(true);
});

test("a blank seed still produces a stable US zone", () => {
  const zone = usTimezoneForSeed("");
  expect(ZONES.includes(zone)).toBe(true);
  expect(usTimezoneForSeed("   ")).toBe(zone);
});

test("draft seeds differ between dialogs", () => {
  const seeds = new Set(Array.from({ length: 5 }, () => draftTimezoneSeed()));
  expect(seeds.size).toBe(5);
});

test("the large-batch disk estimate is labelled as an estimate range", () => {
  expect(estimateBatchDiskBytes(0)).toEqual({ minBytes: 0, maxBytes: 0 });
  expect(estimateBatchDiskBytes(50)).toEqual({ minBytes: 50 * 300 * 1024 ** 2, maxBytes: 50 * 600 * 1024 ** 2 });
  expect(formatBatchDiskEstimate(50)).toBe("14.6–29.3 GB");
  expect(formatBatchDiskEstimate(1000)).toBe("293.0–585.9 GB");
});
