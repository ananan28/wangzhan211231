/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { SessionStore } from "resource:///modules/sessionstore/SessionStore.sys.mjs";
import { createProfile, validateProfile, onReload, cloneProfile } from
  "resource:///modules/TabFingerprintState.sys.mjs";

import { CustomizableUI } from "resource:///modules/CustomizableUI.sys.mjs";

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

function updateToolbar(win) {
  const button = win.document.getElementById("tab-fingerprint-button");
  const tab = win.gBrowser?.selectedTab;
  if (!button || !tab) { return; }
  const enabled = read(tab).rotateOnReload;
  button.setAttribute("label", enabled ? "刷新换指纹" : "固定指纹");
  button.setAttribute("aria-pressed", String(enabled));
  button.setAttribute("tooltiptext", enabled
    ? "当前标签页：刷新时更换指纹。点击关闭；Shift+点击设置地区。"
    : "当前标签页：保持固定指纹。点击开启；Shift+点击设置地区。");
}

function toggleRotation(tab) {
  const state = read(tab);
  save(tab, { ...state, rotateOnReload: !state.rotateOnReload });
  updateToolbar(tab.ownerGlobal);
}

let widgetCreated = false;

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
    const lastReload = new WeakMap();
    const reloadObserver = (_subject, _topic, identifier) => {
      const [contextId, loadId] = identifier.split(":");
      for (const tab of win.gBrowser.tabs) {
        if (String(tab.linkedBrowser.browsingContext?.id) !== contextId) {
          continue;
        }
        if (lastReload.get(tab) === loadId) { return; }
        lastReload.set(tab, loadId);
        save(tab, onReload(read(tab), uuid));
        apply(tab);
        return;
      }
    };
    Services.obs.addObserver(reloadObserver, "tab-fingerprint-before-reload");
    win.addEventListener("unload", () => {
      Services.obs.removeObserver(reloadObserver, "tab-fingerprint-before-reload");
    }, { once: true });

    if (!widgetCreated) {
      CustomizableUI.createWidget({
        id: "tab-fingerprint-button",
        defaultArea: CustomizableUI.AREA_NAVBAR,
        label: "固定指纹",
        tooltiptext: "切换当前标签页的刷新指纹轮换",
        onCommand(event) {
          const owner = event.target.ownerGlobal;
          if (event.shiftKey) {
            configure(owner.gBrowser.selectedTab);
          } else {
            toggleRotation(owner.gBrowser.selectedTab);
          }
        },
        onCreated(node) {
          const icon = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="context-fill"><path d="M8 1a4 4 0 0 0-4 4v3a4 4 0 0 1-1 2.65l1.1.95A5.5 5.5 0 0 0 5.5 8V5a2.5 2.5 0 0 1 5 0v3a9 9 0 0 1-1.7 5.25l1.2.85A10.5 10.5 0 0 0 12 8V5a4 4 0 0 0-4-4Zm0 3a1 1 0 0 0-1 1v3a7 7 0 0 1-1.5 4.35l1.2.9A8.5 8.5 0 0 0 8.5 8V5a.5.5 0 0 0-.5-1Z"/></svg>';
          node.style.listStyleImage = `url("data:image/svg+xml,${encodeURIComponent(icon)}")`;
          node.style.MozContextProperties = "fill";
          node.style.fill = "currentColor";
        },
      });
      widgetCreated = true;
    }
    container.addEventListener("TabSelect", () => updateToolbar(win));
    updateToolbar(win);


    const menu = win.document.getElementById("tabContextMenu");
    if (!menu) { return; }
    const toggle = win.document.createXULElement("menuitem");
    toggle.id = "tab-fingerprint-rotate";
    toggle.setAttribute("type", "checkbox");
    toggle.setAttribute("label", "刷新时更换此标签页指纹");
    const target = () => win.TabContextMenu.contextTab || win.gBrowser.selectedTab;
    toggle.addEventListener("command", () => {
      const tab = target();
      toggleRotation(tab);
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
