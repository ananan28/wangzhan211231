/**
 * Nanfu's JS fingerprint layer: one MV3 helper written into each profile's
 * user-data directory and loaded with `--load-extension`.
 *
 * The engine already answers UA/UA-CH, platform, screen, timezone, locale,
 * canvas/WebGL/audio noise, core count and storage quota from the fingerprint
 * seed. This layer deliberately stays out of those: it covers only what the
 * engine leaves to the host machine, and every patch below first reads the
 * live value so an engine answer is never overwritten twice.
 *
 * The five surfaces this layer was asked to guarantee, and who answers each:
 *
 *  - navigator.webdriver: the engine, always. Its patch series drops the
 *    AutomationControlled feature from --enable-automation, --headless,
 *    --remote-debugging-pipe and --remote-debugging-port=0, so no launch switch
 *    sets it; a client that asks through Emulation.setAutomationOverride still
 *    gets it, by design. A JS answer would be a second answer to a settled
 *    question and would hide that explicit request, so this layer has none.
 *  - navigator.hardwareConcurrency: the engine, from
 *    --fingerprint-hardware-concurrency or its own seed draw. The launcher caps
 *    that flag at this computer's core count so Chromium starts at all. The only
 *    thing left for the page is a ceiling: never report more than the profile
 *    claims, never raise what the engine answered (see below).
 *  - WebRTC host/mDNS candidates: mostly the engine. A proxied launch gets the
 *    no-non-proxied-UDP page policy, and the engine's own patches rewrite
 *    candidate text to the proxy exit IP — but only on Windows and only once an
 *    exit IP was resolved. Until then the SDP a page reads still names the
 *    machine (a LAN address or an mDNS UUID), and nothing above the page can
 *    take that back out. So the page drops exactly those candidates, and keeps
 *    every srflx/relay one so a proxied call still has a path out.
 *  - navigator.plugins / navigator.mimeTypes: nobody. They follow whichever PDF
 *    viewer the build shipped; a build that ships none leaves a desktop Chrome's
 *    page looking at an empty list no desktop Chrome ever reports. Only the page
 *    can fill them, and only while the engine's own answer is empty.
 *  - Date.prototype.getTimezoneOffset + Intl.DateTimeFormat: the engine, at ICU
 *    startup, in every process. A JS patch could only move some of the clocks —
 *    Date#toString, Date#toLocaleString and worker realms would disagree with
 *    it — which is a stronger signal than the host zone it replaced, so this
 *    layer does not touch the clock. A zone the engine rejects is a profile-data
 *    problem, and the probe reports it.
 *
 * Everything here is a pure function of the stored profile. The same profile
 * produces the same directory content on every launch, and two profiles never
 * share a value drawn from the seed.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { hostPlatformOs, seedFraction } from "./fingerprint.ts";
import type { Profile } from "./types.ts";

/** Bump when a patch or the delivered manifest changes; launch rewrites the directory. */
export const FINGERPRINT_EXTENSION_REVISION = 2;

/**
 * Master switch for the JS layer. Off by default: the engine already answers
 * most of these surfaces, and a second, unverified source can only make a
 * profile inconsistent. Set NANFU_FINGERPRINT_JS=1 for a supervised comparison
 * against the fingerprint probe before turning it on by default.
 *
 * The launcher reads this once, in the process that spawns the browser, so the
 * variable must be in that process's environment at start-up.
 */
export function fingerprintExtensionEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.NANFU_FINGERPRINT_JS === "1";
}

export const FINGERPRINT_EXTENSION = fingerprintExtensionEnabled();

export const fingerprintExtensionDir = (userDataDir: string) => join(userDataDir, "nanfu-fingerprint");

export type FingerprintPlatform = "windows" | "macos" | "linux";

/**
 * A MAIN-world content script is the only place that can patch page built-ins
 * before the first page script runs, and it runs in every frame, including the
 * blank ones a page creates and then writes into.
 */
export const FINGERPRINT_MANIFEST = {
  manifest_version: 3,
  name: "Nanfu Fingerprint",
  version: "1.0.0",
  description: "Reports this environment's own device surface.",
  content_scripts: [{
    matches: ["<all_urls>"],
    js: ["content.js"],
    run_at: "document_start",
    all_frames: true,
    match_about_blank: true,
    match_origin_as_fallback: true,
    world: "MAIN",
  }],
};

export interface FingerprintVoice {
  name: string;
  lang: string;
  voiceURI: string;
  localService: boolean;
  default: boolean;
}

export interface FingerprintGpuLimits {
  maxTextureDimension2D: number;
  maxStorageBufferBindingSize: number;
  maxBufferSize: number;
  maxComputeInvocationsPerWorkgroup: number;
}

export interface FingerprintExtensionConfig {
  revision: number;
  seed: number;
  platform: FingerprintPlatform;
  locale: string;
  /** Largest subpixel offset added to a rect edge, in CSS pixels. */
  clientRects: { amplitude: number };
  webgpu: { vendor: string; architecture: string; device: string; description: string; limits: FingerprintGpuLimits };
  fonts: string[];
  voices: FingerprintVoice[];
  mediaDevices: {
    audioinput: string[];
    audiooutput: string[];
    videoinput: string[];
    groups: string[];
  };
  deviceMemory: number;
  /** Present only when the profile claims a core count; a ceiling over the engine's answer. */
  hardwareConcurrency?: number;
  /** Present only when the profile has a proxy: the page drops host candidates that still name this machine. */
  webRtc?: { filterHostCandidates: boolean };
}

interface GpuModel {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
  limits: FingerprintGpuLimits;
}

const DESKTOP_LIMITS: FingerprintGpuLimits = {
  maxTextureDimension2D: 16384,
  maxStorageBufferBindingSize: 2147483648,
  maxBufferSize: 2147483648,
  maxComputeInvocationsPerWorkgroup: 1024,
};

const APPLE_LIMITS: FingerprintGpuLimits = {
  maxTextureDimension2D: 16384,
  maxStorageBufferBindingSize: 1073741824,
  maxBufferSize: 2147483648,
  maxComputeInvocationsPerWorkgroup: 1024,
};

// Cards a current desktop reports, with the limits that card really exposes.
const GPUS: Record<FingerprintPlatform, readonly GpuModel[]> = {
  windows: [
    { vendor: "nvidia", architecture: "ampere", device: "geforce-rtx-3060", description: "NVIDIA GeForce RTX 3060", limits: DESKTOP_LIMITS },
    { vendor: "nvidia", architecture: "ada", device: "geforce-rtx-4060", description: "NVIDIA GeForce RTX 4060", limits: DESKTOP_LIMITS },
    { vendor: "amd", architecture: "rdna-2", device: "rx-6700-xt", description: "AMD Radeon RX 6700 XT", limits: DESKTOP_LIMITS },
    { vendor: "intel", architecture: "xe-hpg", device: "arc-a770", description: "Intel Arc A770 Graphics", limits: DESKTOP_LIMITS },
  ],
  macos: [
    { vendor: "apple", architecture: "apple-m1", device: "apple-m1", description: "Apple M1", limits: APPLE_LIMITS },
    { vendor: "apple", architecture: "apple-m2", device: "apple-m2", description: "Apple M2", limits: APPLE_LIMITS },
    { vendor: "apple", architecture: "apple-m2-pro", device: "apple-m2-pro", description: "Apple M2 Pro", limits: APPLE_LIMITS },
  ],
  linux: [
    { vendor: "nvidia", architecture: "ampere", device: "geforce-rtx-3060", description: "NVIDIA GeForce RTX 3060", limits: DESKTOP_LIMITS },
    { vendor: "amd", architecture: "rdna-2", device: "rx-6600", description: "AMD Radeon RX 6600", limits: DESKTOP_LIMITS },
    { vendor: "intel", architecture: "xe-hpg", device: "arc-a750", description: "Intel Arc A750 Graphics", limits: DESKTOP_LIMITS },
  ],
};

const FONT_POOL: Record<FingerprintPlatform, readonly string[]> = {
  windows: [
    "Segoe UI", "Segoe UI Variable", "Tahoma", "Arial", "Verdana", "Calibri", "Cambria", "Candara",
    "Corbel", "Georgia", "Times New Roman", "Consolas", "Courier New", "Trebuchet MS", "Franklin Gothic Medium",
    "Palatino Linotype", "Microsoft Sans Serif", "Lucida Console", "SimSun", "Microsoft YaHei",
    "Malgun Gothic", "Yu Gothic",
  ],
  macos: [
    "SF Pro Text", "SF Pro Display", "Helvetica", "Helvetica Neue", "Arial", "Avenir", "Avenir Next",
    "Georgia", "Times New Roman", "Menlo", "Monaco", "Courier New", "Verdana", "Trebuchet MS",
    "Optima", "Palatino", "PingFang SC", "Hiragino Sans", "Apple SD Gothic Neo",
  ],
  linux: [
    "DejaVu Sans", "DejaVu Serif", "DejaVu Sans Mono", "Liberation Sans", "Liberation Serif",
    "Liberation Mono", "Noto Sans", "Noto Serif", "Ubuntu", "Cantarell", "FreeSans", "Arial",
    "Times New Roman", "Courier New", "Noto Sans CJK SC",
  ],
};

// Each voice pack lists names the platform really ships for that language.
const VOICE_NAMES: Record<FingerprintPlatform, Record<string, readonly string[]>> = {
  windows: {
    en: ["Microsoft David - English (United States)", "Microsoft Zira - English (United States)", "Microsoft Mark - English (United States)"],
    zh: ["Microsoft Huihui - Chinese (Simplified, PRC)", "Microsoft Kangkang - Chinese (Simplified, PRC)", "Microsoft Yaoyao - Chinese (Simplified, PRC)"],
    es: ["Microsoft Helena - Spanish (Spain)", "Microsoft Pablo - Spanish (Spain)"],
    fr: ["Microsoft Hortense - French (France)", "Microsoft Paul - French (France)"],
    de: ["Microsoft Hedda - German (Germany)", "Microsoft Stefan - German (Germany)"],
    pt: ["Microsoft Maria - Portuguese (Brazil)", "Microsoft Daniel - Portuguese (Brazil)"],
    ru: ["Microsoft Irina - Russian (Russia)", "Microsoft Pavel - Russian (Russia)"],
    ja: ["Microsoft Haruka - Japanese (Japan)", "Microsoft Ichiro - Japanese (Japan)"],
    ko: ["Microsoft Heami - Korean (Korea)"],
    it: ["Microsoft Elsa - Italian (Italy)"],
    nl: ["Microsoft Frank - Dutch (Netherlands)"],
    pl: ["Microsoft Paulina - Polish (Poland)"],
    tr: ["Microsoft Tolga - Turkish (Turkey)"],
    ar: ["Microsoft Hoda - Arabic (Saudi Arabia)"],
    hi: ["Microsoft Hemant - Hindi (India)"],
    vi: ["Microsoft An - Vietnamese (Vietnam)"],
    th: ["Microsoft Premwadee - Thai (Thailand)"],
    id: ["Microsoft Andika - Indonesian (Indonesia)"],
  },
  macos: {
    en: ["Alex", "Samantha", "Daniel"],
    zh: ["Ting-Ting", "Mei-Jia"],
    es: ["Monica", "Diego"],
    fr: ["Thomas", "Amelie"],
    de: ["Anna", "Markus"],
    pt: ["Luciana", "Felipe"],
    ru: ["Milena", "Yuri"],
    ja: ["Kyoko", "Otoya"],
    ko: ["Yuna", "Sora"],
    it: ["Alice", "Luca"],
    nl: ["Xander", "Femke"],
    pl: ["Zosia", "Krzysztof"],
    tr: ["Yelda", "Cem"],
    ar: ["Maged", "Tarik"],
    hi: ["Lekha", "Rishi"],
    vi: ["Linh", "Binh"],
    th: ["Kanya", "Niwat"],
    id: ["Damayanti", "Arif"],
  },
  linux: {
    en: ["English (America)", "English (Great Britain)"],
    zh: ["Chinese (Mandarin)", "Chinese (Cantonese)"],
    es: ["Spanish (Spain)", "Spanish (Latin America)"],
    fr: ["French (France)", "French (Belgium)"],
    de: ["German (Germany)", "German (Austria)"],
    pt: ["Portuguese (Brazil)", "Portuguese (Portugal)"],
    ru: ["Russian (Russia)"],
    ja: ["Japanese (Japan)"],
    ko: ["Korean (Korea)"],
    it: ["Italian (Italy)"],
    nl: ["Dutch (Netherlands)"],
    pl: ["Polish (Poland)"],
    tr: ["Turkish (Turkey)"],
    ar: ["Arabic (Saudi Arabia)"],
    hi: ["Hindi (India)"],
    vi: ["Vietnamese (Vietnam)"],
    th: ["Thai (Thailand)"],
    id: ["Indonesian (Indonesia)"],
  },
};

/** One well-mixed value from the profile seed, kept apart from other draws by `salt`. */
const mix = (seed: number, salt: number): number => (seed ^ Math.imul(salt, 0x9e3779b1)) >>> 0;

function fraction(seed: number, salt: number): number {
  return seedFraction(mix(seed, salt));
}

function pick<T>(values: readonly T[], seed: number, salt: number, fallback: T): T {
  return values[Math.floor(fraction(seed, salt) * values.length)] ?? fallback;
}

/** A 64-hex-character identifier: the shape Chromium gives a media device. */
function hexId(seed: number, salt: number): string {
  let state = mix(seed, salt) || 1;
  let out = "";
  for (let index = 0; index < 8; index++) {
    state = Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) >>> 0;
    state = (state + Math.imul(index + 1, 0x297a2d39)) >>> 0;
    out += state.toString(16).padStart(8, "0");
  }
  return out;
}

function platformOf(profile: Profile): FingerprintPlatform {
  const stored = (profile.platformOs ?? "").toLowerCase();
  if (stored === "windows" || stored === "macos" || stored === "linux") return stored;
  return hostPlatformOs();
}

function languageOf(locale: string): string {
  return (locale.split(/[-_]/)[0] ?? "en").toLowerCase();
}

function voicesFor(platform: FingerprintPlatform, locale: string, seed: number): FingerprintVoice[] {
  const packs = VOICE_NAMES[platform];
  const language = languageOf(locale);
  const source = packs[language] ?? packs["en"] ?? [];
  if (!source.length) return [];
  const count = Math.min(source.length, 2 + Math.floor(fraction(seed, 811) * 3));
  const offset = Math.floor(fraction(seed, 821) * source.length);
  const voices: FingerprintVoice[] = [];
  for (let index = 0; index < count; index++) {
    const name = source[(offset + index) % source.length]!;
    voices.push({
      name,
      lang: locale,
      // The URI a Chromium build gives a Microsoft or Apple voice is its name.
      voiceURI: `${name}`,
      localService: true,
      default: index === 0,
    });
  }
  return voices;
}

function fontsFor(platform: FingerprintPlatform, locale: string, seed: number): string[] {
  const pool = FONT_POOL[platform];
  const count = Math.min(pool.length, 12 + Math.floor(fraction(seed, 701) * 5));
  const ranked = pool
    .map((family, index) => ({ family, rank: fraction(seed, 701 + index * 7) }))
    .sort((a, b) => a.rank - b.rank);
  const chosen = new Set(ranked.slice(0, count).map((entry) => entry.family));
  // A CJK interface must be able to name a CJK face, or the list contradicts the locale.
  const language = languageOf(locale);
  const cjk = language === "zh" ? /SimSun|YaHei|PingFang|Noto Sans CJK/
    : language === "ja" ? /Yu Gothic|Hiragino|Noto Sans CJK/
      : language === "ko" ? /Malgun Gothic|Apple SD Gothic Neo|Noto Sans CJK/
        : null;
  if (cjk) {
    const match = pool.find((family) => cjk.test(family));
    if (match) chosen.add(match);
  }
  // Pool order keeps the list looking like an install, not a shuffled draw.
  return pool.filter((family) => chosen.has(family));
}

/**
 * The values this profile's page-facing surfaces answer with. Pure: the same
 * profile always yields the same object, and no value is shared by two seeds.
 */
export function fingerprintExtensionConfig(profile: Profile): FingerprintExtensionConfig {
  const seed = profile.fingerprintSeed;
  const platform = platformOf(profile);
  const locale = profile.locale || "en-US";
  const gpu = pick(GPUS[platform], seed, 501, GPUS[platform][0]!);
  const deviceMemory = (profile.hardware?.cores ?? 8) >= 12 || fraction(seed, 1301) < 0.65 ? 8 : 4;
  const audioInputs = 1 + Math.floor(fraction(seed, 1201) * 2);
  const audioOutputs = 2 + Math.floor(fraction(seed, 1202) * 2);
  const videoInputs = 1 + Math.floor(fraction(seed, 1203) * 2);

  return {
    revision: FINGERPRINT_EXTENSION_REVISION,
    seed,
    platform,
    locale,
    clientRects: { amplitude: Math.round((0.008 + fraction(seed, 1401) * 0.044) * 10000) / 10000 },
    webgpu: { ...gpu, limits: { ...gpu.limits } },
    fonts: fontsFor(platform, locale, seed),
    voices: voicesFor(platform, locale, seed),
    mediaDevices: {
      audioinput: Array.from({ length: audioInputs }, (_, index) => hexId(seed, 1501 + index)),
      audiooutput: Array.from({ length: audioOutputs }, (_, index) => hexId(seed, 1601 + index)),
      videoinput: Array.from({ length: videoInputs }, (_, index) => hexId(seed, 1701 + index)),
      groups: Array.from({ length: 2 }, (_, index) => hexId(seed, 1801 + index)),
    },
    deviceMemory,
    // The engine's own launch switch carries these; they appear in config only so
    // the ceiling and the candidate filter know what the profile already claimed.
    ...(profile.hardware?.cores ? { hardwareConcurrency: profile.hardware.cores } : {}),
    ...(profile.proxy ? { webRtc: { filterHostCandidates: true } } : {}),
  };
}

/**
 * Page-side patch set. Every block reads the live value first and only answers
 * when the engine (or the host) left it unanswered; every block falls back to
 * the native property on any error.
 *
 * The values are inlined rather than fetched from config.json: this script runs
 * in the page's own world at document_start, where `chrome.runtime` does not
 * exist, so a fetch would resolve only after the page's first script had run.
 * config.json ships beside it as the exact source the content was rendered
 * from, so a launch can be audited file by file.
 */
export const FINGERPRINT_CONTENT_SOURCE = String.raw`
(() => {
  "use strict";
  const CONFIG = __NANFU_FP_CONFIG__;
  if (!CONFIG || typeof CONFIG !== "object") return;

  const patchedText = new WeakMap();

  // Keep the native name, arity and "function x() { [native code] }" text, so a
  // replaced member is indistinguishable from the built-in it replaced.
  const disguise = (patched, original) => {
    const name = original && original.name ? original.name : patched.name;
    try { Object.defineProperty(patched, "name", { value: name, configurable: true }); } catch (error) {}
    try { Object.defineProperty(patched, "length", { value: original && original.length ? original.length : 0, configurable: true }); } catch (error) {}
    patchedText.set(patched, "function " + name + "() { [native code] }");
    return patched;
  };

  // Replace one member in place, keeping its own descriptor flags exactly:
  // same enumerable/configurable, same writability, same accessor shape.
  const replace = (owner, key, factory) => {
    try {
      const descriptor = owner && Object.getOwnPropertyDescriptor(owner, key);
      if (!descriptor) return false;
      if (typeof descriptor.value === "function") {
        const patched = factory(descriptor.value);
        if (typeof patched !== "function") return false;
        Object.defineProperty(owner, key, {
          value: disguise(patched, descriptor.value),
          writable: descriptor.writable,
          enumerable: descriptor.enumerable,
          configurable: descriptor.configurable,
        });
        return true;
      }
      if (typeof descriptor.get === "function") {
        const patched = factory(descriptor.get);
        if (typeof patched !== "function") return false;
        Object.defineProperty(owner, key, {
          get: disguise(patched, descriptor.get),
          set: descriptor.set,
          enumerable: descriptor.enumerable,
          configurable: descriptor.configurable,
        });
        return true;
      }
    } catch (error) {}
    return false;
  };

  try {
    const descriptor = Object.getOwnPropertyDescriptor(Function.prototype, "toString");
    const native = descriptor && descriptor.value;
    if (typeof native === "function") {
      const patched = function toString() {
        const text = patchedText.get(this);
        return text === undefined ? native.call(this) : text;
      };
      patchedText.set(patched, "function toString() { [native code] }");
      Object.defineProperty(Function.prototype, "toString", {
        value: patched,
        writable: descriptor.writable,
        enumerable: descriptor.enumerable,
        configurable: descriptor.configurable,
      });
    }
  } catch (error) {}

  // ---------------------------------------------------------------- rectangles
  // Layout geometry is a per-machine value: identical CSS lands on the same
  // fractional edge on every machine with the same engine. A seed-determined
  // subpixel offset makes the edge this profile's own while staying far below
  // what a person or a layout-dependent script can notice.
  const amplitude = Math.max(0, Math.min(0.25, Number(CONFIG.clientRects && CONFIG.clientRects.amplitude) || 0));
  if (amplitude > 0 && typeof DOMRect === "function") {
    const elementIds = new WeakMap();
    let elementCounter = 0;

    const hash = (value) => {
      let mixed = value | 0;
      mixed = Math.imul(mixed ^ (mixed >>> 16), 0x21f0aaad);
      mixed = Math.imul(mixed ^ (mixed >>> 15), 0x735a2d97);
      return (mixed ^ (mixed >>> 15)) >>> 0;
    };
    const offset = (id, salt, a, b) => (hash(
      Math.imul(id, 2654435761) ^ Math.imul(salt, 40503) ^ Math.imul(a, 8191) ^ Math.imul(b, 131071),
    ) / 4294967296 - 0.5) * amplitude;
    const idOf = (element) => {
      let id = elementIds.get(element);
      if (id === undefined) {
        id = ++elementCounter;
        elementIds.set(element, id);
      }
      return id;
    };
    // The offset is derived from the element and its own geometry, so repeated
    // calls on unchanged layout answer identically, as a real engine does.
    const adjust = (element, index, rect) => {
      if (!rect || (!(rect.width > 0) && !(rect.height > 0))) return null;
      const id = idOf(element);
      const left = Math.round(rect.left * 64);
      const top = Math.round(rect.top * 64);
      const width = Math.max(0, rect.width + offset(id, index + 1, left, top));
      const height = Math.max(0, rect.height + offset(id, index + 2, left, top));
      return new DOMRect(
        rect.left + offset(id, index + 3, left, top),
        rect.top + offset(id, index + 4, left, top),
        width,
        height,
      );
    };

    replace(Element.prototype, "getBoundingClientRect", (original) => function getBoundingClientRect() {
      const rect = original.call(this);
      try {
        return adjust(this, 0, rect) || rect;
      } catch (error) {
        return rect;
      }
    });

    if (typeof DOMRectList === "function") {
      replace(Element.prototype, "getClientRects", (original) => function getClientRects() {
        const rects = original.call(this);
        try {
          if (!rects || !rects.length) return rects;
          const adjusted = [];
          for (let index = 0; index < rects.length; index++) {
            adjusted.push(adjust(this, index, rects[index]) || rects[index]);
          }
          const list = Object.create(DOMRectList.prototype);
          Object.defineProperty(list, "length", { value: adjusted.length, enumerable: true, configurable: true });
          adjusted.forEach((rect, index) => {
            Object.defineProperty(list, index, { value: rect, enumerable: true, configurable: true });
          });
          Object.defineProperty(list, "item", {
            value: disguise(function item(index) {
              const found = adjusted[index];
              return found === undefined ? null : found;
            }, { name: "item", length: 1 }),
            writable: true,
            enumerable: false,
            configurable: true,
          });
          return list;
        } catch (error) {
          return rects;
        }
      });
    }
  }

  // ------------------------------------------------------------------- WebGPU
  // A machine without a usable GPU, or one whose card the engine does not know,
  // reports an empty adapter info and the software renderer's small limits. Fill
  // both only then: a card the engine already names is left exactly as it is.
  if (typeof GPUAdapter === "function" && typeof GPUAdapterInfo === "function") {
    let nativeInfo = null;
    replace(GPUAdapter.prototype, "info", (original) => {
      nativeInfo = original;
      return function info() {
        const info = original.call(this);
        try {
          if (!info) return info;
          // The engine already named a card: its information and limits agree.
          if (String(info.vendor || "").length > 0) return info;
          const shape = {
            vendor: CONFIG.webgpu.vendor,
            architecture: CONFIG.webgpu.architecture,
            device: CONFIG.webgpu.device,
            description: CONFIG.webgpu.description,
          };
          const fake = Object.create(GPUAdapterInfo.prototype);
          for (const key of Object.keys(shape)) {
            Object.defineProperty(fake, key, { value: shape[key], enumerable: true, configurable: true });
          }
          return fake;
        } catch (error) {
          return info;
        }
      };
    });
    // Only a software adapter reaches this point, so put the card's real limits
    // in place of the renderer's smaller ones.
    {
      replace(GPUAdapter.prototype, "limits", (original) => function limits() {
        const limits = original.call(this);
        try {
          const info = typeof nativeInfo === "function" ? nativeInfo.call(this) : null;
          if (info && String(info.vendor || "").length > 0) return limits;
          const overrides = CONFIG.webgpu && CONFIG.webgpu.limits;
          if (!overrides || typeof Proxy !== "function") return limits;
          return new Proxy(limits, {
            get(target, key, receiver) {
              if (Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key];
              return Reflect.get(target, key, receiver);
            },
          });
        } catch (error) {
          return limits;
        }
      });
    }
  }

  // -------------------------------------------------------------- deviceMemory
  // The engine answers this on builds that have the flag. When it is absent the
  // host's memory size would otherwise be unreported for every profile on the
  // machine, so answer with the profile's own value in the native shape.
  try {
    if (typeof Navigator === "function" && !("deviceMemory" in navigator)) {
      const getter = disguise(function deviceMemory() {
        return CONFIG.deviceMemory;
      }, { name: "get deviceMemory", length: 0 });
      Object.defineProperty(Navigator.prototype, "deviceMemory", {
        get: getter,
        set: undefined,
        enumerable: true,
        configurable: true,
      });
    }
  } catch (error) {}

  // ------------------------------------------------- hardwareConcurrency ceiling
  // The engine answers this from --fingerprint-hardware-concurrency, or from its
  // own seed draw when the launcher has nothing to pass. This block runs after
  // the engine's bindings exist, so the live value is already the engine's
  // answer: it only ever lowers a count the profile never claimed, and never
  // raises the smaller number the engine had to report on this computer.
  if (typeof CONFIG.hardwareConcurrency === "number" && CONFIG.hardwareConcurrency > 0) {
    const ceiling = Math.floor(CONFIG.hardwareConcurrency);
    const clamp = (original) => function hardwareConcurrency() {
      const native = original.call(this);
      return typeof native === "number" && native > ceiling ? ceiling : native;
    };
    if (typeof Navigator === "function") replace(Navigator.prototype, "hardwareConcurrency", clamp);
    if (typeof WorkerNavigator === "function") replace(WorkerNavigator.prototype, "hardwareConcurrency", clamp);
  }

  // ------------------------------------------------------- plugins and mimeTypes
  // No engine patch touches these two lists: they follow the PDF viewer the build
  // ships, and a build that ships none leaves a desktop Chrome's page reporting an
  // empty list that no desktop Chrome reports. Nothing outside the page can add
  // them back, so fill them only while the engine's own answer is empty.
  if (typeof PluginArray === "function" && typeof Plugin === "function"
      && typeof MimeTypeArray === "function" && typeof MimeType === "function") {
    const PDF_MIMES = [
      { type: "application/pdf", suffixes: "pdf", description: "Portable Document Format" },
      { type: "text/pdf", suffixes: "pdf", description: "Portable Document Format" },
    ];
    const PDF_PLUGINS = [
      { name: "PDF Viewer", filename: "internal-pdf-viewer" },
      { name: "Chrome PDF Viewer", filename: "internal-pdf-viewer" },
      { name: "Chromium PDF Viewer", filename: "internal-pdf-viewer" },
    ];
    // A WebIDL array-like: the native prototype still supplies every member this
    // object does not own, so instanceof holds, while each data member is own —
    // a native accessor would throw on an object with no internal slot.
    const arrayLike = (proto, items, keyOf, extra) => {
      const target = Object.create(proto);
      Object.defineProperty(target, "length", { value: items.length, enumerable: true, configurable: true });
      items.forEach((item, index) => {
        Object.defineProperty(target, String(index), { value: item, enumerable: true, configurable: true });
      });
      Object.defineProperty(target, "item", {
        value: disguise(function item(index) {
          const found = items[index >>> 0];
          return found === undefined ? null : found;
        }, { name: "item", length: 1 }),
        writable: true, enumerable: true, configurable: true,
      });
      Object.defineProperty(target, "namedItem", {
        value: disguise(function namedItem(name) {
          const key = String(name);
          const exact = items.find((item) => keyOf(item) === key);
          if (exact !== undefined) return exact;
          const loose = items.find((item) => keyOf(item).toLowerCase() === key.toLowerCase());
          return loose === undefined ? null : loose;
        }, { name: "namedItem", length: 1 }),
        writable: true, enumerable: true, configurable: true,
      });
      if (extra) extra(target);
      return target;
    };
    const rebuild = () => {
      const mimes = PDF_MIMES.map((spec) => {
        const mime = Object.create(MimeType.prototype);
        for (const key of ["type", "suffixes", "description"]) {
          Object.defineProperty(mime, key, { value: spec[key], enumerable: true, configurable: true });
        }
        return mime;
      });
      const asMimeArray = () => arrayLike(MimeTypeArray.prototype, mimes, (mime) => mime.type);
      const plugins = PDF_PLUGINS.map((spec) => arrayLike(Plugin.prototype, mimes, (mime) => mime.type, (plugin) => {
        Object.defineProperty(plugin, "name", { value: spec.name, enumerable: true, configurable: true });
        Object.defineProperty(plugin, "filename", { value: spec.filename, enumerable: true, configurable: true });
        Object.defineProperty(plugin, "description", { value: "Portable Document Format", enumerable: true, configurable: true });
        Object.defineProperty(plugin, "mimeTypes", { value: asMimeArray(), enumerable: true, configurable: true });
      }));
      // Chrome names the first plugin as the one a PDF MIME type comes from.
      for (const mime of mimes) {
        Object.defineProperty(mime, "enabledPlugin", { value: plugins[0], enumerable: true, configurable: true });
      }
      const pluginArray = arrayLike(PluginArray.prototype, plugins, (plugin) => plugin.name, (target) => {
        Object.defineProperty(target, "refresh", {
          value: disguise(function refresh() {}, { name: "refresh", length: 0 }),
          writable: true, enumerable: true, configurable: true,
        });
      });
      return { plugins: pluginArray, mimeTypes: asMimeArray() };
    };
    let built = null;
    const fill = (pick) => (original) => function filledList() {
      const native = original.call(this);
      try {
        if (native && native.length > 0) return native;
      } catch (error) {
        return native;
      }
      if (!built) built = rebuild();
      return pick(built);
    };
    replace(Navigator.prototype, "plugins", fill((fake) => fake.plugins));
    replace(Navigator.prototype, "mimeTypes", fill((fake) => fake.mimeTypes));
  }

  // ------------------------------------------------------------ WebRTC candidates
  // A proxied profile gets the no-non-proxied-UDP page policy, and the engine's
  // own patches rewrite candidate text to the proxy exit IP — on Windows, once
  // that exit IP was resolved. In every other case the SDP a page reads still
  // carries this machine's LAN address or its mDNS name, and nothing above the
  // page can take one back out. Drop exactly those host candidates and keep every
  // srflx/relay candidate, so a proxied call keeps a path out.
  const webRtc = CONFIG.webRtc;
  if (webRtc && webRtc.filterHostCandidates && typeof RTCPeerConnection === "function"
      && typeof RTCSessionDescription === "function" && typeof EventTarget === "function") {
    const privateAddress = (address) => {
      const value = String(address || "").toLowerCase();
      if (!value || value === "0.0.0.0" || value === "::") return true;
      if (/\.local$/.test(value)) return true;
      if (/^::ffff:/.test(value)) return privateAddress(value.slice(7));
      if (/^f[cd][0-9a-f]{0,2}:/.test(value) || /^fe[89ab][0-9a-f]:/.test(value) || value === "::1") return true;
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(value)) return false;
      const [a, b] = value.split(".").map(Number);
      return a === 0 || a === 10 || a === 127
        || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
    };
    // A host candidate that names this machine; srflx, relay and prflx always
    // stay, and so does an end-of-candidates event (its candidate is empty).
    const leaks = (candidate) => {
      if (!candidate) return false;
      let type = candidate.type;
      let address = candidate.address;
      if (typeof type !== "string" || typeof address !== "string") {
        const match = /^candidate:\S+ \d+ \S+ \d+ (\S+) \d+ typ (\S+)/.exec(String(candidate.candidate || ""));
        if (match) {
          if (typeof address !== "string") address = match[1];
          if (typeof type !== "string") type = match[2];
        }
      }
      return type === "host" && privateAddress(address);
    };
    const scrub = (sdp) => {
      // Chrome writes CRLF; a page-built description may use LF alone.
      const eol = sdp.indexOf("\r\n") >= 0 ? "\r\n" : "\n";
      let dropped = false;
      const kept = sdp.split(eol).filter((line) => {
        const match = /^a=candidate:\S+ \d+ \S+ \d+ (\S+) \d+ typ (\S+)/.exec(line);
        if (!match || match[2].toLowerCase() !== "host" || !privateAddress(match[1])) return true;
        dropped = true;
        return false;
      });
      return dropped ? kept.join(eol) : sdp;
    };
    const scrubDescription = (description) => {
      if (!description || typeof description.sdp !== "string") return description;
      const sdp = scrub(description.sdp);
      if (sdp === description.sdp) return description;
      return new RTCSessionDescription({ type: description.type, sdp });
    };
    for (const key of ["localDescription", "currentLocalDescription", "pendingLocalDescription"]) {
      replace(RTCPeerConnection.prototype, key, (original) => function description() {
        const value = original.call(this);
        try {
          return scrubDescription(value);
        } catch (error) {
          return value;
        }
      });
    }

    const filterEvent = (event) => {
      try {
        return event && event.candidate && leaks(event.candidate) ? null : event;
      } catch (error) {
        return event;
      }
    };
    const wrapListener = (listener) => {
      if (typeof listener === "function") {
        return function icecandidate(event) {
          const kept = filterEvent(event);
          if (kept) return listener.call(this, kept);
        };
      }
      if (listener && typeof listener.handleEvent === "function") {
        return {
          handleEvent(event) {
            const kept = filterEvent(event);
            if (kept) listener.handleEvent(kept);
          },
        };
      }
      return listener;
    };
    // One wrapper per listener, so a later removeEventListener removes ours.
    const wrappers = new WeakMap();
    const wrapped = (listener, create) => {
      if (!listener || (typeof listener !== "function" && typeof listener !== "object")) return listener;
      let wrapper = wrappers.get(listener);
      if (!wrapper && create) {
        wrapper = wrapListener(listener);
        wrappers.set(listener, wrapper);
      }
      return wrapper || listener;
    };
    // A candidate event a page must not see is dropped, not rewritten: the engine
    // would only accept an RTCIceCandidate it built itself. The wrap sits on
    // EventTarget and is guarded by instanceof, so RTCPeerConnection.prototype
    // gains no own member that a stock engine does not have.
    for (const entry of [["addEventListener", true], ["removeEventListener", false]]) {
      const method = entry[0];
      const create = entry[1];
      replace(EventTarget.prototype, method, (original) => function listen(type, handler, options) {
        try {
          if (this instanceof RTCPeerConnection && String(type).toLowerCase() === "icecandidate") {
            return original.call(this, type, wrapped(handler, create), options);
          }
        } catch (error) {}
        return original.call(this, type, handler, options);
      });
    }

    {
      const descriptor = Object.getOwnPropertyDescriptor(RTCPeerConnection.prototype, "onicecandidate");
      if (descriptor && typeof descriptor.get === "function" && typeof descriptor.set === "function") {
        const handlers = new WeakMap();
        Object.defineProperty(RTCPeerConnection.prototype, "onicecandidate", {
          // The page must read back the handler it assigned, not our wrapper.
          get: disguise(function onicecandidate() {
            return handlers.has(this) ? handlers.get(this) : descriptor.get.call(this);
          }, descriptor.get),
          set: disguise(function onicecandidate(handler) {
            if (handler) handlers.set(this, handler);
            else handlers.delete(this);
            descriptor.set.call(this, handler ? wrapListener(handler) : handler);
          }, descriptor.set),
          enumerable: descriptor.enumerable,
          configurable: descriptor.configurable,
        });
      }
    }
  }

  // ----------------------------------------------------------- media devices
  // Chromium salts device ids per profile but reports the machine's real device
  // list; the ids and groups are what a page links sessions by. Keep the real
  // list and order, and give the ids this profile's stable values.
  if (typeof MediaDevices === "function" && typeof MediaDeviceInfo === "function") {
    const plan = CONFIG.mediaDevices || {};
    const groupIds = new Map();
    const toFake = new Map();
    const toReal = new Map();

    const fakeGroup = (nativeGroup, index) => {
      if (!nativeGroup) return "";
      const known = groupIds.get(nativeGroup);
      if (known !== undefined) return known;
      const groups = Array.isArray(plan.groups) && plan.groups.length ? plan.groups : [""];
      const next = groups[groupIds.size % groups.length];
      groupIds.set(nativeGroup, next);
      return next;
    };

    replace(MediaDevices.prototype, "enumerateDevices", (original) => function enumerateDevices() {
      return original.apply(this).then((devices) => {
        try {
          if (!Array.isArray(devices)) return devices;
          return devices.map((device, index) => {
            // Without permission the native answer is already anonymous.
            if (!device || !device.deviceId) return device;
            const ids = plan[device.kind];
            if (!Array.isArray(ids) || !ids.length) return device;
            const fake = ids[index % ids.length];
            const group = fakeGroup(device.groupId, index);
            toFake.set(device.deviceId, fake);
            toReal.set(fake, device.deviceId);
            const shape = { deviceId: fake, groupId: group };
            return new Proxy(device, {
              get(target, key, receiver) {
                if (Object.prototype.hasOwnProperty.call(shape, key)) return shape[key];
                return Reflect.get(target, key, receiver);
              },
            });
          });
        } catch (error) {
          return devices;
        }
      });
    });

    const translate = (value) => {
      if (typeof value === "string") return toReal.get(value);
      if (Array.isArray(value)) {
        const mapped = value.map((item) => toReal.get(item)).filter((item) => typeof item === "string");
        return mapped.length ? mapped : undefined;
      }
      if (value && typeof value === "object") {
        const exact = toReal.get(value.exact);
        const ideal = toReal.get(value.ideal);
        if (typeof exact === "string") return { exact };
        if (typeof ideal === "string") return { ideal };
        return undefined;
      }
      return undefined;
    };
    const constraints = (value) => {
      if (!value || typeof value !== "object") return value;
      const next = {};
      for (const key of Object.keys(value)) next[key] = value[key];
      for (const kind of ["audio", "video"]) {
        const track = next[kind];
        if (!track || typeof track !== "object" || !("deviceId" in track)) continue;
        const mapped = translate(track.deviceId);
        const copy = {};
        for (const key of Object.keys(track)) if (key !== "deviceId") copy[key] = track[key];
        // A stored id this profile never had must not become an OverconstrainedError.
        if (mapped !== undefined) copy.deviceId = mapped;
        next[kind] = copy;
      }
      return next;
    };

    replace(MediaDevices.prototype, "getUserMedia", (original) => function getUserMedia(asked) {
      let request = asked;
      try {
        request = constraints(asked);
      } catch (error) {
        request = asked;
      }
      return original.call(this, request);
    });

    if (typeof MediaStreamTrack === "function") {
      replace(MediaStreamTrack.prototype, "getSettings", (original) => function getSettings() {
        const settings = original.call(this);
        try {
          if (!settings) return settings;
          const fake = toFake.get(settings.deviceId);
          if (fake === undefined) return settings;
          const copy = {};
          for (const key of Object.keys(settings)) copy[key] = settings[key];
          copy.deviceId = fake;
          const group = fakeGroup(settings.groupId, 0);
          if (group) copy.groupId = group;
          return copy;
        } catch (error) {
          return settings;
        }
      });
    }
  }

  // ---------------------------------------------------------------- voices
  // A host in one language answers a persona in another, which is both a leak and
  // a contradiction. Answer the persona's voices instead. A host that already has
  // only the persona's language is left alone.
  if (typeof SpeechSynthesis === "function" && typeof SpeechSynthesisVoice === "function") {
    const voices = Array.isArray(CONFIG.voices) ? CONFIG.voices : [];
    const base = String(CONFIG.locale || "en").toLowerCase().split(/[-_]/)[0];
    if (voices.length) {
      replace(SpeechSynthesis.prototype, "getVoices", (original) => function getVoices() {
        const native = original.call(this) || [];
        try {
          const coherent = native.length > 0 && native.every((voice) => String(voice && voice.lang || "").toLowerCase().split(/[-_]/)[0] === base);
          if (coherent) return native;
          return voices.map((voice, index) => {
            const shape = {
              name: voice.name,
              lang: voice.lang,
              voiceURI: voice.voiceURI,
              localService: voice.localService,
              default: voice.default,
            };
            const host = native.length ? native[index % native.length] : null;
            if (!host) {
              const fake = Object.create(SpeechSynthesisVoice.prototype);
              for (const key of Object.keys(shape)) {
                Object.defineProperty(fake, key, { value: shape[key], enumerable: true, configurable: true });
              }
              return fake;
            }
            return new Proxy(host, {
              get(target, key, receiver) {
                if (Object.prototype.hasOwnProperty.call(shape, key)) return shape[key];
                return Reflect.get(target, key, receiver);
              },
            });
          });
        } catch (error) {
          return native;
        }
      });
      // A page may speak with a voice it just read from us; the engine only knows
      // its own names, so hand it the default voice rather than an error.
      replace(SpeechSynthesis.prototype, "speak", (original) => function speak(utterance) {
        try {
          const chosen = utterance && utterance.voice;
          if (chosen && typeof chosen.voiceURI === "string" && !voices.some((voice) => voice.voiceURI === chosen.voiceURI)) {
            utterance.voice = null;
          }
        } catch (error) {}
        return original.call(this, utterance);
      });
    }
  }

  // ------------------------------------------------------------------ fonts
  // Font enumeration is the one surface the engine leaves entirely to the host.
  // Only the permission-gated enumeration is answered; the loaded-font set that
  // document.fonts exposes drives real rendering and is left untouched, so the
  // page's measurements and its enumeration still agree.
  if (typeof FontData === "function" && typeof Window === "function" && "queryLocalFonts" in window) {
    const fonts = Array.isArray(CONFIG.fonts) ? CONFIG.fonts : [];
    const owner = Object.getOwnPropertyDescriptor(Window.prototype, "queryLocalFonts") ? Window.prototype : window;
    replace(owner, "queryLocalFonts", (original) => function queryLocalFonts() {
      return original.apply(this, arguments).then((host) => {
        try {
          if (!Array.isArray(host) || !host.length || !fonts.length) return host;
          return fonts.map((family, index) => {
            const shape = {
              family,
              fullName: family,
              postscriptName: family.replace(/\s+/g, ""),
              style: "Regular",
              weight: "400",
              stretch: "normal",
              italic: false,
              monospace: /mono|consolas|courier|menlo/i.test(family),
            };
            return new Proxy(host[index % host.length], {
              get(target, key, receiver) {
                if (Object.prototype.hasOwnProperty.call(shape, key)) return shape[key];
                return Reflect.get(target, key, receiver);
              },
            });
          });
        } catch (error) {
          return host;
        }
      });
    });
  }
})();
`;

/** The exact script written for one profile. */
export function fingerprintExtensionContent(config: FingerprintExtensionConfig): string {
  // A replacer function keeps "$" sequences in the JSON literal.
  return FINGERPRINT_CONTENT_SOURCE.replace("__NANFU_FP_CONFIG__", () => JSON.stringify(config));
}

export interface InstalledFingerprintExtension {
  directory: string;
  revision: number;
  /** True when this launch replaced an older or missing copy. */
  rewritten: boolean;
}

/**
 * Write the helper for one launch. A revision change, a changed config or a
 * half-written directory all replace the whole directory, so an older script
 * can never be loaded beside a newer one.
 */
export function installFingerprintExtension(userDataDir: string, profile: Profile): InstalledFingerprintExtension {
  const directory = fingerprintExtensionDir(userDataDir);
  const config = fingerprintExtensionConfig(profile);
  const configJson = `${JSON.stringify(config, null, 2)}\n`;
  const content = fingerprintExtensionContent(config);
  const stamp = `${FINGERPRINT_EXTENSION_REVISION} ${createHash("sha256").update(configJson).update(content).digest("hex")}`;

  const current = (() => {
    try {
      return readFileSync(join(directory, "stamp"), "utf8");
    } catch {
      return "";
    }
  })();
  if (current === stamp && existsSync(join(directory, "manifest.json")) && existsSync(join(directory, "content.js"))) {
    return { directory, revision: FINGERPRINT_EXTENSION_REVISION, rewritten: false };
  }

  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, "manifest.json"), `${JSON.stringify(FINGERPRINT_MANIFEST, null, 2)}\n`);
  writeFileSync(join(directory, "config.json"), configJson);
  writeFileSync(join(directory, "content.js"), content);
  writeFileSync(join(directory, "stamp"), stamp);
  return { directory, revision: FINGERPRINT_EXTENSION_REVISION, rewritten: true };
}
