/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { SessionStore } from "resource:///modules/sessionstore/SessionStore.sys.mjs";
import { createProfile, validateProfile, onReload, cloneProfile } from
  "resource:///modules/TabFingerprintState.sys.mjs";

const KEY = "tab-fingerprint-v1";
const states = new WeakMap();
const uuid = () => Services.uuid.generateUUID().toString();

function defaults(win) {
  return {
    language: win.navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    width: win.screen.width,
    height: win.screen.height,
    userAgent: win.navigator.userAgent,
    location: null,
  };
}

function save(tab, state) {
  states.set(tab, state);
  SessionStore.setCustomTabValue(tab, KEY, JSON.stringify(state));
}

function read(tab) {
  if (states.has(tab)) {
    return states.get(tab);
  }
  const stored = SessionStore.getCustomTabValue(tab, KEY);
  if (stored) {
    try {
      const state = validateProfile(JSON.parse(stored));
      states.set(tab, state);
      return state;
    } catch (error) {
      console.error("Discarding invalid saved tab fingerprint", error);
    }
  }
  const state = createProfile(defaults(tab.ownerGlobal), uuid);
  save(tab, state);
  return state;
}

function position(location) {
  const coords = { ...location, altitude: NaN, altitudeAccuracy: NaN,
    heading: NaN, speed: NaN,
    QueryInterface: ChromeUtils.generateQI(["nsIDOMGeoPositionCoords"]) };
  return { coords, timestamp: Date.now(),
    QueryInterface: ChromeUtils.generateQI(["nsIDOMGeoPosition"]) };
}

function apply(tab) {
  const browser = tab.linkedBrowser;
  const bc = browser.browsingContext;
  if (!bc) {
    return;
  }
  const state = read(tab);
  bc.fingerprintSeed = state.seed;
  bc.customUserAgent = state.userAgent;
  bc.languageOverride = state.language;
  bc.timezoneOverride = state.timezone;
  bc.setScreenAreaOverride(state.width, state.height);
  // The native override does not grant the website geolocation permission.
  if (state.location) {
    bc.setGeolocationServiceOverride(position(state.location));
  } else {
    bc.setGeolocationServiceOverride();
  }
  browser._tabFingerprintBeforeReload = () => {
    const next = onReload(read(tab), uuid);
    save(tab, next);
    apply(tab);
  };
}

function ensureUnique(tab) {
  const state = read(tab);
  // Duplicated tabs copy SessionStore extData. Give the copy its own seed,
  // while a closed tab restored without a live original retains its seed.
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    for (const other of win.gBrowser?.tabs ?? []) {
      if (other === tab || other.closing) {
        continue;
      }
      const otherState = states.get(other);
      if (otherState?.seed === state.seed) {
        save(tab, cloneProfile(state, uuid));
        return;
      }
    }
  }
}

function ask(win, title, text, initial) {
  const value = { value: initial };
  return Services.prompt.prompt(win, title, text, value, null, {})
    ? value.value : null;
}

function configure(tab) {
  const win = tab.ownerGlobal;
  const old = read(tab);
  const language = ask(win, "标签页指纹", "语言，例如 en-US", old.language);
  if (language === null) { return; }
  const timezone = ask(win, "标签页指纹", "时区，例如 America/New_York", old.timezone);
  if (timezone === null) { return; }
  const screen = ask(win, "标签页指纹", "屏幕尺寸，例如 1920x1080", `${old.width}x${old.height}`);
  if (screen === null) { return; }
  const location = ask(win, "标签页指纹", "网页定位：纬度,经度；留空使用浏览器原有定位。不会自动读取代理插件的出口地区。",
    old.location ? `${old.location.latitude},${old.location.longitude}` : "");
  if (location === null) { return; }
  try {
    const match = /^(\d+)\s*[x×]\s*(\d+)$/.exec(screen.trim());
    if (!match) { throw new Error("屏幕尺寸格式不正确"); }
    let loc = null;
    if (location.trim()) {
      const parts = location.split(",");
      if (parts.length !== 2 || parts.some(x => !x.trim())) {
        throw new Error("定位格式应为 纬度,经度");
      }
      loc = { latitude: Number(parts[0]), longitude: Number(parts[1]), accuracy: 100 };
    }
    const next = validateProfile({ ...old, language, timezone,
      width: Number(match[1]), height: Number(match[2]), location: loc });
    save(tab, next);
    apply(tab);
    // Applying settings does not navigate or resend an outstanding POST.
    Services.prompt.alert(win, "标签页指纹", "已保存。请手动刷新当前标签页，让全部设置在新页面生效。");
  } catch (error) {
    Services.prompt.alert(win, "设置未保存", error.message);
  }
}

export const TabFingerprint = {
  init(win) {
    if (win.__tabFingerprintInitialized) { return; }
    win.__tabFingerprintInitialized = true;
    const branch = Services.prefs.getDefaultBranch("");
    branch.setBoolPref("privacy.fingerprintingProtection", true);
    // Keep the efficient canvas path enabled, and include WebGL readback.
    const overrides = branch.getStringPref("privacy.fingerprintingProtection.overrides", "");
    branch.setStringPref("privacy.fingerprintingProtection.overrides",
      `${overrides},+CanvasRandomization,+EfficientCanvasRandomization,+WebGLRandomization`);
    const initTab = tab => { ensureUnique(tab); apply(tab); };
    const container = win.gBrowser.tabContainer;
    container.addEventListener("TabOpen", event => initTab(event.target));
    container.addEventListener("SSTabRestoring", event => {
      states.delete(event.target);
      initTab(event.target);
    });
    container.addEventListener("TabBrowserInserted", event => initTab(event.target));
    container.addEventListener("TabRemotenessChange", event => apply(event.target));
    for (const tab of win.gBrowser.tabs) { initTab(tab); }

    const menu = win.document.getElementById("tabContextMenu");
    if (!menu) { return; }
    const toggle = win.document.createXULElement("menuitem");
    toggle.id = "tab-fingerprint-rotate";
    toggle.setAttribute("type", "checkbox");
    toggle.setAttribute("label", "刷新时更换此标签页指纹");
    const target = () => win.TabContextMenu.contextTab || win.gBrowser.selectedTab;
    toggle.addEventListener("command", () => {
      const tab = target();
      const state = read(tab);
      save(tab, { ...state, rotateOnReload: !state.rotateOnReload });
    });
    menu.addEventListener("popupshowing", event => {
      if (event.target === menu) {
        toggle.setAttribute("checked", String(read(target()).rotateOnReload));
      }
    });
    const settings = win.document.createXULElement("menuitem");
    settings.id = "tab-fingerprint-settings";
    settings.setAttribute("label", "此标签页的指纹设置…");
    settings.addEventListener("command", () => configure(target()));
    menu.append(toggle, settings);
  },
};
