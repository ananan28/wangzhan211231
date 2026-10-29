/**
 * Page-visible fingerprint coherence as a MAIN-world MV3 helper.
 *
 * What this is
 * ------------
 * The kernel already owns the identity: `--fingerprint=SEED` plus the derived
 * switches in fingerprint.ts produce canvas, WebGL, audio, fonts, screen, UA-CH
 * and the client hint brand list. This extension exists for the handful of
 * values a JS content script can see that a *stock* Chromium would report
 * wrongly, and it deliberately does not add a second source of identity noise.
 *
 * Why no canvas/WebGL/audio noise here (the gate)
 * -----------------------------------------------
 * Canvas, WebGL and AudioContext readings must be a pure function of
 * `profile.fingerprintSeed`, and the kernel already computes them from that seed
 * (see deriveFingerprintFlags: `--fingerprint=SEED`, and `--fingerprint-noise`
 * for the Chromium 155 runtime, which is what keeps two profiles on one computer
 * from sharing one image). A JS layer that added its own PRNG perturbation would
 * produce a *second*, differently-seeded image: the same profile would then
 * report a kernel-consistent WebGL renderer next to a canvas hash the kernel
 * never produced, and two launches could disagree depending on which layer wrote
 * last. That inconsistency is a stronger signal than the noise it hides, so this
 * file touches none of the three. If the kernel does not seed a surface, the fix
 * belongs in the kernel, not here.
 *
 * "Kernel first" rule
 * -------------------
 * Every assertion below is written so that a correctly patched kernel makes it a
 * no-op. The script reads the value the engine reports at document_start and only
 * corrects a residual contradiction, so:
 *   - webdriver:                patched only when the engine reports true;
 *   - hardwareConcurrency:      lowered to profile.hardware.cores only when the
 *                               engine reports *more* (the kernel flag wins and is
 *                               itself capped to the real host by fingerprint.ts),
 *                               never raised above what the kernel reports;
 *   - WebRTC:                   filters host/mDNS candidates only, and only for a
 *                               proxied profile (the launcher already passes
 *                               --force-webrtc-ip-handling-policy=disable_non_proxied_udp);
 *   - plugins/mimeTypes:        filled only when the array is empty;
 *   - timezone:                 armed only when the engine's own zone differs from
 *                               profile.timezone, i.e. a Chromium build without
 *                               --fingerprint-timezone. Firefox/Camoufox sets the
 *                               zone in its own config (firefox-config.ts) and this
 *                               MV3 content script is never loaded there, so the
 *                               Chromium kernel is the only "engine that can do it"
 *                               and it normally does.
 *
 * Known residuals (not hidden by this file)
 * -----------------------------------------
 *   - plugins/mimeTypes are plain objects: `Object.prototype.toString` says
 *     "[object Object]" and `instanceof Plugin` is false. The fix helps the
 *     classic `plugins.length === 0` headless tell and is worse against a probe
 *     that checks the interface identity. JS cannot manufacture native Plugin
 *     objects, so this is a trade, not a fix.
 *   - A timezone shim cannot make Date#toString/getHours/toLocaleString agree
 *     with getTimezoneOffset; those still follow the host. That is another
 *     reason the shim only arms when the kernel failed to apply the zone.
 *   - Worker globals are not reachable from a content script. A probe running in
 *     a Worker sees the kernel's values; that is only a difference if the kernel
 *     was wrong in the first place.
 *   - WebRTC SDP (`pc.localDescription`) is not rewritten. The kernel policy is
 *     the authority and rewriting SDP text in JS would desync the SDP from the
 *     live ICE agent.
 *
 * Determinism: every byte written is a pure function of the stored Profile.
 * Nothing is drawn from the clock, the host, the proxy credentials or the seed
 * (the seed must NOT appear here: the kernel owns it).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Profile } from "./types.ts";

/** Bumped only when the emitted files change semantics; the launcher can fold it into the persona digest. */
export const FINGERPRINT_EXTENSION_REVISION = 1;

/** Written beside aliasmode-autofill / aliasmode-translation, inside the profile's user-data dir. */
export const fingerprintExtensionDir = (userDataDir: string) => join(userDataDir, "aliasmode-fingerprint");

/**
 * MV3, single MAIN-world content script.
 * MAIN + document_start is the only combination that runs before page scripts
 * and can see/replace the page's own `navigator`; an isolated-world content
 * script would patch a private copy and change nothing a page can read.
 */
export const FINGERPRINT_EXTENSION_MANIFEST = {
  manifest_version: 3,
  name: "Nanfu Fingerprint Coherence",
  version: "1.0.0",
  description: "Corrects page-visible values the browser kernel does not already assert for this profile.",
  // "world": "MAIN" in a declared content script needs Chrome 111+.
  minimum_chrome_version: "111",
  content_scripts: [
    {
      matches: ["http://*/*", "https://*/*"],
      js: ["content.js"],
      run_at: "document_start",
      world: "MAIN",
      // Frames share the same page-visible tells; about:blank frames inherit them too.
      all_frames: true,
      match_about_blank: true,
    },
  ],
};

export interface FingerprintExtensionPlan {
  /** profile.hardware.cores, or null. The kernel flag wins; this only caps an inflated value. */
  cores: number | null;
  /** True when the profile has a proxy: host/mDNS ICE candidates would reveal the real LAN address. */
  webrtc: boolean;
  /** IANA zone to fall back to when the engine did not apply profile.timezone itself; null if unusable. */
  timezone: string | null;
}

/** An IANA zone name, not a path and not arbitrary text: it is embedded into generated JS. */
const TIME_ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/;

/**
 * The only profile-derived input to the emitted files. This is exported so the
 * launcher and the tests can state exactly what a profile will assert.
 */
export function fingerprintExtensionPlan(profile: Profile): FingerprintExtensionPlan {
  const cores = profile.hardware?.cores;
  const zone = typeof profile.timezone === "string" && TIME_ZONE_NAME.test(profile.timezone.trim())
    ? profile.timezone.trim()
    : null;
  return {
    cores: typeof cores === "number" && Number.isInteger(cores) && cores > 0 ? cores : null,
    webrtc: Boolean(profile.proxy),
    timezone: zone,
  };
}

const CONTENT_HEAD = String.raw`(() => {
  "use strict";
  // The only per-profile input. Everything below is constant, so one profile always
  // writes the same bytes; the seed is deliberately absent (the kernel owns it).
  const cfg = `;

const CONTENT_BODY = String.raw`

  const nativeToString = Function.prototype.toString;
  const nativeSources = new WeakMap();
  let masked = 0;
  const mark = (fn, source) => {
    try { nativeSources.set(fn, source); masked += 1; } catch (error) { /* frozen */ }
    return fn;
  };
  const navProto = Object.getPrototypeOf(navigator);

  // An accessor built in an object literal is named "get <key>", like Chrome's.
  const accessor = (key, value) => Object.getOwnPropertyDescriptor({ get [key]() { return value; } }, key).get;
  const assertAccessor = (target, key, value) => {
    try {
      const getter = mark(accessor(key, value), "function get " + key + "() { [native code] }");
      Object.defineProperty(target, key, { get: getter, set: undefined, enumerable: true, configurable: true });
    } catch (error) { /* a frozen global is left alone rather than half-patched */ }
  };

  // 1. navigator.webdriver. Normal launches are headful without --enable-automation,
  //    so the engine already answers false; this only matters when an automation
  //    flag leaked in, and then a masked descriptor is strictly better than true.
  if (navigator.webdriver) assertAccessor(navProto, "webdriver", false);

  // 2. navigator.hardwareConcurrency. The kernel flag wins: --fingerprint-hardware-concurrency
  //    is already emitted from profile.hardware.cores (and capped to the real host by
  //    fingerprint.ts), so an equal value is left untouched and nothing is ever raised.
  if (cfg.cores) {
    const reported = navigator.hardwareConcurrency;
    if (typeof reported === "number" && reported > cfg.cores) assertAccessor(navProto, "hardwareConcurrency", cfg.cores);
  }

  // 3. WebRTC. Only a proxied profile arms this: the launcher already forces
  //    disable_non_proxied_udp, so host candidates are normally absent and this filter
  //    removes nothing. It is a second line for a kernel that ignored the switch, and it
  //    drops only candidates that name the LAN (typ host, *.local); srflx/relay survive,
  //    which is what keeps calls working through the proxy exit.
  if (cfg.webrtc && typeof window.RTCPeerConnection === "function") {
    const proto = window.RTCPeerConnection.prototype;
    const revealsLan = (candidate) => {
      if (!candidate) return false;
      const text = String(candidate.candidate || "");
      if (!text) return false;
      if (/\.local(\s|$)/.test(text)) return true;
      if (typeof candidate.type === "string" && candidate.type) return candidate.type === "host";
      const match = /\btyp\s+(\S+)/.exec(text);
      return !!match && match[1] === "host";
    };
    const keep = (event) => !revealsLan(event && event.candidate);
    const wrappers = new WeakMap();
    const wrapListener = (listener) => {
      if (typeof listener === "function") {
        const wrapped = function wrappedListener(event) {
          if (!keep(event)) return undefined;
          return listener.call(this, event);
        };
        wrappers.set(listener, wrapped);
        return wrapped;
      }
      if (listener && typeof listener.handleEvent === "function") {
        const target = listener;
        const wrapped = function wrappedListener(event) {
          if (!keep(event)) return undefined;
          return target.handleEvent(event);
        };
        wrappers.set(listener, wrapped);
        return wrapped;
      }
      return listener;
    };
    const nativeAdd = proto.addEventListener;
    const nativeRemove = proto.removeEventListener;
    proto.addEventListener = mark(function addEventListener(type, listener, options) {
      return nativeAdd.call(this, type, type === "icecandidate" ? wrapListener(listener) : listener, options);
    }, "function addEventListener() { [native code] }");
    proto.removeEventListener = mark(function removeEventListener(type, listener, options) {
      const wrapped = type === "icecandidate" && listener ? wrappers.get(listener) : undefined;
      return nativeRemove.call(this, type, wrapped || listener, options);
    }, "function removeEventListener() { [native code] }");
    const descriptor = Object.getOwnPropertyDescriptor(proto, "onicecandidate");
    if (descriptor && descriptor.get && descriptor.set) {
      const originals = new WeakMap();
      Object.defineProperty(proto, "onicecandidate", {
        configurable: true,
        enumerable: true,
        // Reading the handler back returns what the page assigned, not the wrapper.
        get: function get() {
          const current = descriptor.get.call(this);
          return (current && originals.get(current)) || current;
        },
        set: function set(handler) {
          if (typeof handler !== "function") { descriptor.set.call(this, handler); return; }
          const wrapped = function wrappedHandler(event) {
            if (!keep(event)) return undefined;
            return handler.call(this, event);
          };
          originals.set(wrapped, handler);
          descriptor.set.call(this, wrapped);
        },
      });
    }
  }

  // 4. plugins/mimeTypes. An empty array is the classic headless tell and the kernel does
  //    not synthesize it. Only filled when empty: a non-empty array is never rewritten.
  //    The objects are plain and cannot claim the native Plugin/PluginArray interfaces.
  if (navigator.plugins && navigator.plugins.length === 0) {
    const mimes = [
      { type: "application/pdf", suffixes: "pdf", description: "Portable Document Format", enabledPlugin: null },
      { type: "text/pdf", suffixes: "pdf", description: "Portable Document Format", enabledPlugin: null },
    ];
    const findMime = (value) => {
      for (const mime of mimes) if (mime.type === value) return mime;
      return null;
    };
    const plugins = ["PDF Viewer", "Chrome PDF Viewer", "Chromium PDF Viewer"].map((name) => {
      const plugin = { name: name, filename: "internal-pdf-viewer", description: "Portable Document Format", length: mimes.length };
      mimes.forEach((mime, index) => { plugin[index] = mime; });
      plugin.item = (index) => plugin[index] || null;
      plugin.namedItem = (value) => findMime(value);
      return plugin;
    });
    for (const mime of mimes) mime.enabledPlugin = plugins[0];
    const collection = (entries, find) => {
      const array = { length: entries.length };
      for (let index = 0; index < entries.length; index += 1) array[index] = entries[index];
      array.item = (index) => array[index] || null;
      array.namedItem = (value) => find(value);
      array[Symbol.iterator] = function* iterator() {
        for (let index = 0; index < this.length; index += 1) yield this[index];
      };
      return array;
    };
    const pluginArray = collection(plugins, (value) => {
      for (const plugin of plugins) if (plugin.name === value) return plugin;
      return null;
    });
    pluginArray.refresh = () => {};
    assertAccessor(navProto, "plugins", pluginArray);
    assertAccessor(navProto, "mimeTypes", collection(mimes, findMime));
  }

  // 5. Timezone. The Chromium kernel applies --fingerprint-timezone (fingerprint.ts), so
  //    the engine already reports profile.timezone and this block does nothing. It arms
  //    only for a Chromium build that lacks or ignored that switch, where the page would
  //    otherwise show the host zone beside a proxy-exit IP. See the module header for the
  //    parts of Date that this cannot fix, which is why the kernel remains the owner.
  if (cfg.timezone) {
    const target = cfg.timezone;
    let usable = false;
    try { new Intl.DateTimeFormat("en-US", { timeZone: target }); usable = true; } catch (error) { usable = false; }
    let reported = "";
    try { reported = String(Intl.DateTimeFormat().resolvedOptions().timeZone || ""); } catch (error) { reported = ""; }
    if (usable && reported.toLowerCase() !== target.toLowerCase()) {
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: target,
        hourCycle: "h23",
        era: "short",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      const offsetMinutes = (time) => {
        const value = Number(time);
        if (!isFinite(value)) return 0;
        const parts = {};
        for (const part of formatter.formatToParts(new Date(value))) parts[part.type] = part.value;
        const year = Number(parts.year);
        // Date.UTC folds years 0-99 into the 1900s, so such instants are left alone.
        if (!isFinite(year) || year < 1000 || year > 9999) return 0;
        const asUtc = Date.UTC(year, Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
        return -Math.round((asUtc - value) / 60000);
      };
      try {
        Object.defineProperty(Date.prototype, "getTimezoneOffset", {
          value: mark(function getTimezoneOffset() { return offsetMinutes(this.getTime()); }, "function getTimezoneOffset() { [native code] }"),
          writable: true,
          enumerable: false,
          configurable: true,
        });
      } catch (error) { /* frozen Date.prototype */ }
      const NativeDateTimeFormat = Intl.DateTimeFormat;
      const DateTimeFormat = mark(function DateTimeFormat(locales, options) {
        if (options === undefined || options === null) return new NativeDateTimeFormat(locales, { timeZone: target });
        if (typeof options === "object" && options.timeZone === undefined) {
          const copy = {};
          for (const key in options) if (Object.prototype.hasOwnProperty.call(options, key)) copy[key] = options[key];
          copy.timeZone = target;
          return new NativeDateTimeFormat(locales, copy);
        }
        return new NativeDateTimeFormat(locales, options);
      }, "function DateTimeFormat() { [native code] }");
      DateTimeFormat.prototype = NativeDateTimeFormat.prototype;
      DateTimeFormat.supportedLocalesOf = mark(
        NativeDateTimeFormat.supportedLocalesOf.bind(NativeDateTimeFormat),
        "function supportedLocalesOf() { [native code] }",
      );
      try {
        Object.defineProperty(Intl, "DateTimeFormat", { value: DateTimeFormat, writable: true, enumerable: false, configurable: true });
      } catch (error) { /* frozen Intl */ }
    }
  }

  // The mask is installed only if something above was actually replaced, and only for the
  // functions this script replaced: every other function keeps the real native source.
  // It is itself observable (the wrapper is not a native function), which is the price of
  // any JS-level patch and another reason nothing is patched that the kernel already got right.
  if (masked > 0) {
    const replacement = function toString() {
      const source = nativeSources.get(this);
      return typeof source === "string" ? source : nativeToString.call(this);
    };
    nativeSources.set(replacement, "function toString() { [native code] }");
    try {
      Object.defineProperty(Function.prototype, "toString", { value: replacement, writable: true, enumerable: false, configurable: true });
    } catch (error) { /* frozen Function.prototype */ }
  }
})();
`;

/** The injected script for one plan. Deterministic: same plan, same bytes. */
export function fingerprintExtensionContent(plan: FingerprintExtensionPlan): string {
  return `${CONTENT_HEAD}${JSON.stringify({
    cores: plan.cores,
    webrtc: plan.webrtc,
    timezone: plan.timezone,
  })};${CONTENT_BODY}`;
}

/** The two files as they will be written. Separated so tests can diff bytes without touching disk. */
export function fingerprintExtensionFiles(plan: FingerprintExtensionPlan): { manifest: string; content: string } {
  return {
    manifest: `${JSON.stringify(FINGERPRINT_EXTENSION_MANIFEST, null, 2)}\n`,
    content: fingerprintExtensionContent(plan),
  };
}

/**
 * Write the helper into the profile's user-data dir and return that dir, ready for
 * `--load-extension`. Must be called after the launch-time proxy-exit timezone update
 * (launcher.ts rewrites profile.timezone from the exit IP) and before the browser spawns.
 */
export function writeFingerprintExtension(profile: Profile, userDataDir: string): string {
  const directory = fingerprintExtensionDir(userDataDir);
  const files = fingerprintExtensionFiles(fingerprintExtensionPlan(profile));
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, "manifest.json"), files.manifest);
    writeFileSync(join(directory, "content.js"), files.content);
  } catch {
    throw new Error("could not prepare the profile fingerprint helper");
  }
  return directory;
}
