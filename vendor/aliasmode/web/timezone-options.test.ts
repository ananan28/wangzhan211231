import { test, expect } from "bun:test";
import {
  FALLBACK_TIMEZONES,
  groupTimezones,
  isValidIanaTimezone,
  resolveTimezoneSelection,
  timezoneForSave,
  timezoneList,
} from "./timezone-options";

test("falls back to the pinned list when the runtime cannot enumerate zones", () => {
  const fallback = timezoneList(null);
  expect(fallback).toContain("America/New_York");
  expect(fallback).toContain("Asia/Shanghai");
  expect(fallback.length).toBe(FALLBACK_TIMEZONES.length);

  const broken = timezoneList(() => {
    throw new RangeError("unsupported key");
  });
  expect(broken).toContain("Europe/Paris");

  const empty = timezoneList(() => []);
  expect(empty).toContain("Pacific/Honolulu");

  const runtime = timezoneList((key) => {
    expect(key).toBe("timeZone");
    return ["Custom/One", "Custom/Two"];
  });
  expect(runtime).toEqual(["Custom/One", "Custom/Two"]);
});

test("groups zones by continent with Chinese labels", () => {
  const groups = groupTimezones([
    "America/New_York",
    "Europe/Paris",
    "Asia/Shanghai",
    "Pacific/Auckland",
    "US/Eastern",
    "UTC",
  ]);
  expect(groups.map((group) => group.label)).toEqual(["美洲", "欧洲", "亚洲", "太平洋", "其他"]);
  expect(groups[0]!.zones).toEqual(["America/New_York", "US/Eastern"]);
  expect(groups[4]!.zones).toEqual(["UTC"]);
});

test("reads automatic, known and unknown timezone values without losing the typed tag", () => {
  expect(resolveTimezoneSelection("")).toEqual({ kind: "auto", value: "" });
  expect(resolveTimezoneSelection("   ")).toEqual({ kind: "auto", value: "" });
  expect(resolveTimezoneSelection(" America/New_York ")).toEqual({ kind: "known", value: "America/New_York" });
  expect(resolveTimezoneSelection("Mars/Olympus")).toEqual({ kind: "custom", value: "Mars/Olympus" });
  expect(resolveTimezoneSelection("America/New_York", ["Europe/Paris"])).toEqual({
    kind: "custom",
    value: "America/New_York",
  });
});

test("keeps the save format unchanged for known and custom values", () => {
  expect(timezoneForSave("")).toBe("");
  expect(timezoneForSave("  Asia/Shanghai ")).toBe("Asia/Shanghai");
  expect(timezoneForSave("Mars/Olympus")).toBe("Mars/Olympus");
});

test("validates IANA tags the same way the server does", () => {
  expect(isValidIanaTimezone("")).toBe(true);
  expect(isValidIanaTimezone("America/New_York")).toBe(true);
  expect(isValidIanaTimezone("Asia/Shanghai")).toBe(true);
  expect(isValidIanaTimezone("Mars/Olympus")).toBe(false);
  expect(isValidIanaTimezone("not a zone")).toBe(false);
});
