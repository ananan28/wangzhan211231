/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const UUID = /^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/i;

export function validateProfile(value) {
  if (!value || value.version !== 1 || !UUID.test(value.seed) ||
      typeof value.rotateOnReload !== "boolean") {
    throw new Error("Invalid tab fingerprint state");
  }
  const result = { version: 1, seed: value.seed,
    rotateOnReload: value.rotateOnReload };
  if (typeof value.language !== "string" ||
      Intl.getCanonicalLocales(value.language).length !== 1) {
    throw new Error("Enter one valid language tag, such as en-US");
  }
  result.language = Intl.getCanonicalLocales(value.language)[0];
  if (typeof value.timezone !== "string" || !value.timezone) {
    throw new Error("Timezone is required");
  }
  result.timezone = new Intl.DateTimeFormat("en", {
    timeZone: value.timezone,
  }).resolvedOptions().timeZone;
  for (const name of ["width", "height"]) {
    if (!Number.isSafeInteger(value[name]) || value[name] < 320 || value[name] > 16384) {
      throw new Error("Screen dimensions must be integers from 320 to 16384");
    }
    result[name] = value[name];
  }
  if (typeof value.userAgent !== "string" || !value.userAgent ||
      value.userAgent.length > 1024 || /[\r\n\x00]/.test(value.userAgent)) {
    throw new Error("Invalid user agent");
  }
  result.userAgent = value.userAgent;
  if (value.location !== null) {
    const loc = value.location;
    if (!loc || !Number.isFinite(loc.latitude) || Math.abs(loc.latitude) > 90 ||
        !Number.isFinite(loc.longitude) || Math.abs(loc.longitude) > 180 ||
        !Number.isFinite(loc.accuracy) || loc.accuracy <= 0) {
      throw new Error("Invalid geographic coordinates");
    }
    result.location = { latitude: loc.latitude, longitude: loc.longitude,
      accuracy: loc.accuracy };
  } else {
    result.location = null;
  }
  return result;
}

export function createProfile(defaults, makeUUID) {
  return validateProfile({ ...defaults, version: 1, seed: makeUUID(),
    rotateOnReload: false, location: defaults.location ?? null });
}

export function onReload(profile, makeUUID) {
  const next = validateProfile(profile);
  // Geographic configuration remains stable when a canvas/WebGL key rotates.
  // Only a proxy plugin knows whether its exit region changed.
  if (next.rotateOnReload) {
    next.seed = makeUUID();
  }
  return validateProfile(next);
}

export function cloneProfile(profile, makeUUID) {
  return validateProfile({ ...profile, seed: makeUUID() });
}
