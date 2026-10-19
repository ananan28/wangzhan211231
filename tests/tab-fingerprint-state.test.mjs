import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createProfile, validateProfile, onReload, cloneProfile } from
  "../firefox/browser/modules/TabFingerprintState.sys.mjs";

const uuid = () => `{${randomUUID()}}`;
const defaults = { language: "en-US", timezone: "America/New_York",
  width: 1920, height: 1080, userAgent: "Mozilla/5.0 Firefox/150.0" };

test("new tabs have distinct keys and rotation is disabled", () => {
  const profiles = Array.from({ length: 1000 }, () => createProfile(defaults, uuid));
  assert.equal(new Set(profiles.map(p => p.seed)).size, 1000);
  assert.ok(profiles.every(p => p.rotateOnReload === false));
});
test("fixed key survives reload and serialized restart", () => {
  let profile = createProfile(defaults, uuid);
  const original = structuredClone(profile);
  for (let i = 0; i < 100; i++) { profile = onReload(profile, uuid); }
  assert.deepEqual(profile, original);
  assert.deepEqual(validateProfile(JSON.parse(JSON.stringify(profile))), original);
});
test("rotation changes only the requested tab and freezes when disabled", () => {
  const other = createProfile(defaults, uuid);
  let profile = { ...createProfile(defaults, uuid), rotateOnReload: true };
  const old = structuredClone(profile);
  profile = onReload(profile, uuid);
  assert.notEqual(profile.seed, old.seed);
  assert.equal(profile.timezone, old.timezone);
  assert.equal(profile.language, old.language);
  assert.deepEqual(other, onReload(other, uuid));
  profile.rotateOnReload = false;
  assert.deepEqual(onReload(profile, uuid), profile);
});
test("duplicate tabs get independent state without mutating the original", () => {
  const original = createProfile(defaults, uuid);
  const duplicate = cloneProfile(original, uuid);
  assert.notEqual(duplicate.seed, original.seed);
  assert.equal(duplicate.rotateOnReload, false);
  duplicate.language = "de-DE";
  assert.equal(original.language, "en-US");
});
test("invalid persistent or user-entered state fails validation", () => {
  const p = createProfile(defaults, uuid);
  for (const change of [ { seed: "" }, { rotateOnReload: "false" },
    { timezone: "Bad/Zone" }, { language: "en_US" }, { width: NaN },
    { height: -1 }, { userAgent: "ua\r\nX-Header: value" },
    { location: { latitude: 91, longitude: 0, accuracy: 100 } },
    { location: { latitude: 0, longitude: 0, accuracy: 0 } } ]) {
    assert.throws(() => validateProfile({ ...p, ...change }));
  }
});
test("manual geography is validated and preserved on rotation", () => {
  const p = validateProfile({ ...createProfile(defaults, uuid),
    rotateOnReload: true, location: { latitude: 40.7, longitude: -74, accuracy: 100 } });
  assert.deepEqual(onReload(p, uuid).location, p.location);
});
