import { join } from "node:path";

export const TRANSLATION_EXTENSION_REVISION = 2;
export const translationExtensionDir = (userDataDir: string) => join(userDataDir, "aliasmode-translation");

/**
 * A bundled MV3 helper loaded into every environment (the same --load-extension
 * channel as autofill). Its worker never sees cookies: it receives only the text
 * an operator asked to translate, and it fetches the configured engine through
 * the environment's own proxy. The engine key is handed over at request time
 * from the manager over loopback and is never written into the extension.
 */
export const TRANSLATION_MANIFEST = {
  manifest_version: 3,
  name: "Nanfu Page Translation",
  version: "1.0.0",
  description: "Translate this page or selected text with the engine configured in Nanfu.",
  permissions: ["contextMenus", "activeTab"],
  host_permissions: ["http://127.0.0.1/*", "https://*/*", "http://*/*"],
  background: { service_worker: "background.js" },
  content_scripts: [{ matches: ["http://*/*", "https://*/*"], js: ["content.js"], run_at: "document_idle" }],
  action: { default_title: "Nanfu translation", default_popup: "popup.html" },
};

export const TRANSLATION_POPUP_HTML = String.raw`<!doctype html>
<html><head><meta charset="utf-8"><style>
body{font:13px/1.45 system-ui,sans-serif;margin:0;padding:12px;width:240px;color:#1d2129}
h1{font-size:13px;margin:0 0 8px}
button{width:100%;margin-top:6px;padding:7px 9px;border:1px solid #c9cdd4;border-radius:6px;background:#fff;cursor:pointer}
button.primary{background:#1d5cff;border-color:#1d5cff;color:#fff}
p{margin:0;color:#4e5969}
</style></head><body>
<h1>Nanfu Translation</h1>
<p id="status">Ready.</p>
<button id="page" class="primary">Translate this page</button>
<button id="original">Show the original</button>
<p style="margin-top:8px;color:#86909c">Configure the engine in Nanfu → Settings → Translation. Requests follow this environment's proxy.</p>
<script src="popup.js"></script>
</body></html>`;

export const TRANSLATION_POPUP_JS = String.raw`
const status = document.getElementById("status");
async function tell(message) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id === undefined) { status.textContent = "No page to translate."; return; }
    await chrome.tabs.sendMessage(tab.id, message);
    status.textContent = "Started. The page shows progress.";
    window.close();
  } catch {
    status.textContent = "Reload the page, then try again.";
  }
}
document.getElementById("page").addEventListener("click", () => tell({ type: "aliasmode-translate-page" }));
document.getElementById("original").addEventListener("click", () => tell({ type: "aliasmode-show-original" }));
`;

const BACKGROUND = String.raw`
const bind = () => fetch(chrome.runtime.getURL("bind.json"), { cache: "no-store" }).then((r) => r.json());
let cached = null;
let cachedAt = 0;
async function config() {
  if (cached && Date.now() - cachedAt < 15000) return cached;
  const b = await bind();
  const response = await fetch("http://127.0.0.1:" + b.port + "/v1/translation/config", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + b.token },
    body: "{}",
    cache: "no-store",
  });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.error || "Open Nanfu to configure translation.");
  cached = body;
  cachedAt = Date.now();
  return body;
}

const GOOGLE_URL = "https://translate.googleapis.com/translate_a/single";
// One text per Google request keeps each answer unambiguous; the limit keeps the
// GET query inside what the endpoint accepts.
const GOOGLE_TEXT_LIMIT = 1500;
const GOOGLE_CONCURRENCY = 4;

function deepLTarget(tag) {
  let lang = String(tag || "en").split("-")[0].toUpperCase();
  if (lang === "EN") return String(tag).toUpperCase() === "EN-GB" ? "EN-GB" : "EN-US";
  if (lang === "PT") return "PT-BR";
  return lang;
}

function googleTarget(tag) {
  const parts = String(tag || "zh-CN").split("-");
  const base = parts[0].toLowerCase();
  const rest = parts.slice(1).join("-").toLowerCase();
  if (base === "zh") return rest === "tw" || rest === "hk" || rest === "mo" || rest === "hant" ? "zh-TW" : "zh-CN";
  if (base === "pt") return rest === "pt" ? "pt-PT" : "pt-BR";
  if (base === "nb" || base === "nn") return "no";
  return base;
}

function missingKey() {
  return "该引擎需要 API 密钥：请在南孚「设置 → 翻译」里填写密钥，或改用谷歌翻译（免密钥）。";
}
function badResponse() {
  return "翻译服务返回了无法识别的结果（响应格式异常）：请稍后重试，或切换引擎。";
}
function statusError(status) {
  if (status === 401 || status === 403) return "翻译引擎拒绝了密钥：请在南孚「设置 → 翻译」里更新密钥，或改用谷歌翻译（免密钥）。";
  if (status === 429) return "翻译服务被限流（HTTP 429）：请稍后再试，或切换引擎。";
  if (status >= 500) return "翻译服务暂时不可用（HTTP " + status + "）：请稍后重试，或切换引擎。";
  return "翻译请求失败（HTTP " + status + "）：请检查引擎地址，或切换引擎。";
}

function request(settings, key, texts) {
  if (settings.engine === "google") {
    const query = new URLSearchParams({
      client: "gtx", sl: "auto", tl: googleTarget(settings.targetLanguage), dt: "t", q: texts[0],
    });
    return { url: GOOGLE_URL + "?" + query.toString(), init: { method: "GET" } };
  }
  if (settings.engine === "openai") {
    const base = settings.baseUrl.replace(/\/+$/, "");
    return {
      url: base + "/chat/completions",
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(key ? { Authorization: "Bearer " + key } : {}) },
        body: JSON.stringify({
          model: settings.model || "gpt-4o-mini",
          temperature: 0,
          messages: [
            { role: "system", content: "You are a translation engine. Translate every string in the user's JSON array into " + settings.targetLanguage + ". Keep the same order and count. Preserve names, numbers and formatting. Return only a JSON array of strings, no commentary." },
            { role: "user", content: JSON.stringify(texts) },
          ],
        }),
      },
    };
  }
  if (settings.engine === "deepl") {
    const form = new URLSearchParams();
    for (const text of texts) form.append("text", text);
    form.set("target_lang", deepLTarget(settings.targetLanguage));
    return {
      url: settings.baseUrl || "https://api-free.deepl.com/v2/translate",
      init: {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", ...(key ? { Authorization: "DeepL-Auth-Key " + key } : {}) },
        body: form.toString(),
      },
    };
  }
  return {
    url: settings.baseUrl,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(key ? { Authorization: "Bearer " + key } : {}) },
      body: JSON.stringify({ texts, targetLanguage: settings.targetLanguage }),
    },
  };
}

function strings(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}
function parseJson(content) {
  const fence = String.fromCharCode(96, 96, 96);
  const trimmed = content.trim()
    .replace(new RegExp("^" + fence + "(?:json)?\\s*", "i"), "")
    .replace(new RegExp(fence + "$"), "")
    .trim();
  try { return strings(JSON.parse(trimmed)); } catch {}
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start >= 0 && end > start) { try { return strings(JSON.parse(trimmed.slice(start, end + 1))); } catch {} }
  return null;
}
function parse(engine, payload, expected) {
  let list = null;
  if (engine === "openai") {
    const content = payload && payload.choices && payload.choices[0] && payload.choices[0].message ? payload.choices[0].message.content : "";
    list = typeof content === "string" ? parseJson(content) : null;
  } else if (engine === "deepl") {
    const items = payload && payload.translations;
    list = Array.isArray(items) && items.every((item) => item && typeof item.text === "string") ? items.map((item) => item.text) : null;
  } else {
    list = strings(payload && payload.translations) || strings(payload && payload.texts) || strings(payload);
  }
  if (!list || list.length !== expected) throw new Error(badResponse());
  return list;
}

// Google answers with a list of segments; each starts with the translated text.
// Empty segments are layout artifacts. Nothing joined means no translation, which
// is a failure, not a reason to show the source text as if it were translated.
function googleTranslated(payload) {
  const segments = payload && payload[0];
  if (!Array.isArray(segments)) return "";
  let out = "";
  for (const segment of segments) {
    if (Array.isArray(segment) && typeof segment[0] === "string") out += segment[0];
  }
  return out.trim();
}

function googleTextParts(text) {
  const marks = ["。", "！", "？", ". ", "! ", "? ", "; ", "\n", " "];
  const parts = [];
  let rest = text;
  while (rest.length > GOOGLE_TEXT_LIMIT) {
    let cut = 0;
    for (const mark of marks) {
      const at = rest.lastIndexOf(mark, GOOGLE_TEXT_LIMIT - mark.length);
      if (at >= 0 && at + mark.length > cut) cut = at + mark.length;
    }
    if (cut < GOOGLE_TEXT_LIMIT * 0.4) cut = GOOGLE_TEXT_LIMIT;
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) parts.push(rest);
  return parts;
}

// Page text only: no cookies, no referrer, no page URL. The request leaves from
// this environment's browser, so it follows the environment's proxy.
async function send(url, init, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, Object.assign({}, init, {
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    }));
  } catch (error) {
    throw new Error(error && error.name === "AbortError"
      ? "翻译服务响应超时：请稍后重试，或在南孚「设置 → 翻译」里切换引擎。"
      : "无法连接翻译服务：请检查该环境的代理和网络，也可以在南孚「设置 → 翻译」里切换引擎。");
  } finally {
    clearTimeout(timer);
  }
}

async function googleOne(settings, text) {
  const built = request(settings, "", [text]);
  const response = await send(built.url, built.init, 20000);
  if (!response.ok) throw new Error(statusError(response.status));
  let payload;
  try { payload = await response.json(); } catch { throw new Error(badResponse()); }
  const translated = googleTranslated(payload);
  if (!translated) throw new Error(badResponse());
  return translated;
}

// Google takes one text per request, so a batch becomes one request per block
// (long blocks are split first) with a bounded number in flight.
async function googleBatch(settings, texts) {
  const units = [];
  texts.forEach((text, index) => {
    for (const part of googleTextParts(text)) units.push({ index, part });
  });
  const out = texts.map(() => "");
  let cursor = 0;
  let failure = null;
  const worker = async () => {
    while (!failure) {
      const position = cursor++;
      if (position >= units.length) return;
      const unit = units[position];
      try {
        out[unit.index] += await googleOne(settings, unit.part);
      } catch (error) {
        failure = failure || error;
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(GOOGLE_CONCURRENCY, units.length) }, worker));
  if (failure) throw failure;
  return out;
}

async function translate(texts) {
  const cfg = await config();
  const engine = cfg.settings.engine;
  if (engine === "google") return googleBatch(cfg.settings, texts);
  if (!String(cfg.key || "").trim()) throw new Error(missingKey());
  const built = request(cfg.settings, cfg.key, texts);
  const response = await send(built.url, built.init, 60000);
  if (!response.ok) throw new Error(statusError(response.status));
  let payload;
  try { payload = await response.json(); } catch { throw new Error(badResponse()); }
  return parse(engine, payload, texts.length);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return;
  if (message.type === "aliasmode-config") {
    config().then((cfg) => sendResponse({ ok: true, settings: cfg.settings })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "aliasmode-translate") {
    const texts = strings(message.texts);
    if (!texts || !texts.length) { sendResponse({ ok: false, error: "Nothing to translate." }); return; }
    translate(texts).then((translations) => sendResponse({ ok: true, translations }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
});

function menus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "nanfu-translate-page", title: "Translate this page", contexts: ["page"] });
    chrome.contextMenus.create({ id: "nanfu-translate-selection", title: "Translate selected text", contexts: ["selection"] });
  });
}
chrome.runtime.onInstalled.addListener(menus);
chrome.runtime.onStartup.addListener(menus);
menus();
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || tab.id === undefined) return;
  if (info.menuItemId === "nanfu-translate-page") chrome.tabs.sendMessage(tab.id, { type: "aliasmode-translate-page" }, () => void chrome.runtime.lastError);
  if (info.menuItemId === "nanfu-translate-selection") chrome.tabs.sendMessage(tab.id, { type: "aliasmode-translate-selection" }, () => void chrome.runtime.lastError);
});
`;

const CONTENT = String.raw`
(() => {
  if (window.top !== window) return;
  const ZH = (navigator.language || "").toLowerCase().startsWith("zh");
  const T = (zh, en) => (ZH ? zh : en);
  const BLOCK = /^(P|LI|H1|H2|H3|H4|H5|H6|TD|TH|BLOCKQUOTE|FIGCAPTION|DD|DT|DIV|ARTICLE|SECTION|ASIDE|SUMMARY|CAPTION)$/;
  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|CODE|PRE|TEXTAREA|INPUT|SELECT|OPTION|SVG|CANVAS|IFRAME|TEMPLATE)$/;
  const state = { records: [], translated: false, running: false, generation: 0, total: 0, done: 0, failed: 0, panel: null, settings: null, selectionBox: null };

  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) resolve(null); else resolve(response);
        });
      } catch { resolve(null); }
    });
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function hidden(el) {
    if (!el || !el.tagName) return true;
    if (SKIP.test(el.tagName)) return true;
    if (el.isContentEditable) return true;
    if (el.closest("#nanfu-translation-panel")) return true;
    if (el.closest("[data-nanfu-translation]")) return true;
    const style = getComputedStyle(el);
    return style.display === "none" || style.visibility === "hidden";
  }

  function collect() {
    const seen = new Set();
    const blocks = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = (node.nodeValue || "").replace(/\s+/g, " ").trim();
      if (text.length < 2) continue;
      const host = node.parentElement && node.parentElement.closest("p,li,h1,h2,h3,h4,h5,h6,td,th,blockquote,figcaption,dd,dt,div,article,section,aside,summary,caption");
      if (!host || seen.has(host) || hidden(host)) continue;
      if (["SCRIPT", "STYLE", "NOSCRIPT"].includes(host.tagName)) continue;
      // A container that holds blocks is translated through those blocks, so text is not duplicated.
      if (Array.from(host.children).some((child) => BLOCK.test(child.tagName))) continue;
      seen.add(host);
      const value = (host.textContent || "").replace(/\s+/g, " ").trim();
      if (value.length < 2 || !/[\p{L}]/u.test(value)) continue;
      blocks.push({ el: host, text: value });
      if (blocks.length >= 600) break;
    }
    return blocks;
  }

  function chunks(blocks, maxChars, maxItems) {
    const out = [];
    let current = [];
    let chars = 0;
    for (const block of blocks) {
      if (current.length && (current.length >= maxItems || chars + block.text.length > maxChars)) {
        out.push(current); current = []; chars = 0;
      }
      current.push(block); chars += block.text.length;
    }
    if (current.length) out.push(current);
    return out;
  }

  function panel() {
    if (state.panel && document.documentElement.contains(state.panel)) return state.panel;
    const box = document.createElement("div");
    box.id = "nanfu-translation-panel";
    box.style.cssText = "position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:360px;background:#111827;color:#f9fafb;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.35);font:13px/1.5 system-ui,sans-serif;padding:10px 12px;display:flex;gap:8px;align-items:center";
    const status = document.createElement("span");
    status.dataset.role = "status";
    status.style.cssText = "flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
    const toggle = document.createElement("button");
    toggle.dataset.role = "toggle";
    toggle.style.cssText = "all:unset;cursor:pointer;padding:2px 8px;border:1px solid #6b7280;border-radius:6px";
    toggle.textContent = T("原文", "Original");
    toggle.onclick = () => (state.translated ? restore() : reapply());
    const cancel = document.createElement("button");
    cancel.dataset.role = "cancel";
    cancel.style.cssText = "all:unset;cursor:pointer;padding:2px 8px;border:1px solid #6b7280;border-radius:6px";
    cancel.textContent = T("取消", "Cancel");
    cancel.onclick = () => { state.generation++; state.running = false; setStatus(T("已取消", "Cancelled")); };
    box.append(status, toggle, cancel);
    document.documentElement.appendChild(box);
    state.panel = box;
    return box;
  }
  function setStatus(text) {
    const box = panel();
    const target = box.querySelector('[data-role="status"]');
    if (target) target.textContent = text;
    const toggle = box.querySelector('[data-role="toggle"]');
    if (toggle) toggle.textContent = state.translated ? T("原文", "Original") : T("译文", "Translation");
    const cancel = box.querySelector('[data-role="cancel"]');
    if (cancel) cancel.style.display = state.running ? "" : "none";
  }
  function closePanel() {
    if (state.panel) state.panel.remove();
    state.panel = null;
  }

  function apply(record, translated, mode) {
    record.translated = translated;
    if (mode === "replace") {
      if (record.originalHtml === undefined) record.originalHtml = record.el.innerHTML;
      record.el.textContent = translated;
      record.el.setAttribute("lang", state.settings ? state.settings.targetLanguage : "");
      record.el.dataset.nanfuTranslated = "1";
    } else {
      if (!record.node) {
        const div = document.createElement("div");
        div.dataset.nanfuTranslation = "1";
        div.style.cssText = "margin:2px 0 6px;opacity:.9;border-left:3px solid #1d5cff;padding-left:8px";
        div.lang = state.settings ? state.settings.targetLanguage : "";
        record.el.insertAdjacentElement("afterend", div);
        record.node = div;
      }
      record.node.textContent = translated;
    }
  }
  function restore() {
    state.translated = false;
    for (const record of state.records) {
      if (record.node) { record.node.remove(); record.node = null; }
      else if (record.originalHtml !== undefined) {
        record.el.innerHTML = record.originalHtml;
        delete record.originalHtml;
        delete record.el.dataset.nanfuTranslated;
        record.el.removeAttribute("lang");
      }
    }
    setStatus(T("已显示原文", "Showing the original"));
  }
  function reapply() {
    if (!state.records.length) return;
    state.translated = true;
    for (const record of state.records) {
      if (record.translated) apply(record, record.translated, state.settings.mode);
    }
    setStatus(T("已显示译文", "Showing the translation"));
  }

  async function ensureSettings() {
    if (state.settings) return state.settings;
    const response = await send({ type: "aliasmode-config" });
    if (!response || !response.ok) { setStatus((response && response.error) || T("请先在南孚设置中配置翻译引擎", "Configure a translation engine in Nanfu first")); return null; }
    state.settings = response.settings;
    return state.settings;
  }

  function showSelection(text) {
    const box = document.createElement("div");
    box.id = "nanfu-translation-selection";
    box.style.cssText = "position:fixed;z-index:2147483647;left:50%;bottom:24px;transform:translateX(-50%);max-width:560px;background:#111827;color:#f9fafb;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.35);font:14px/1.6 system-ui,sans-serif;padding:12px 42px 12px 14px";
    box.textContent = text;
    const close = document.createElement("button");
    close.style.cssText = "all:unset;cursor:pointer;position:absolute;top:8px;right:10px;font-size:18px";
    close.textContent = "×";
    close.onclick = () => box.remove();
    box.appendChild(close);
    document.documentElement.appendChild(box);
    return box;
  }

  async function translateSelection() {
    const selection = window.getSelection();
    const text = selection ? selection.toString().replace(/\s+/g, " ").trim() : "";
    if (text.length < 1) { panel(); setStatus(T("请先选中要翻译的文字", "Select text to translate first")); return; }
    const settings = await ensureSettings();
    if (!settings) return;
    panel();
    setStatus(T("正在翻译选中文字…", "Translating the selection…"));
    const response = await send({ type: "aliasmode-translate", texts: [text] });
    if (!response || !response.ok) { setStatus((response && response.error) || T("翻译失败", "Translation failed")); return; }
    const box = showSelection(response.translations[0]);
    state.selectionBox = box;
    const panelStatus = state.panel && state.panel.querySelector('[data-role="status"]');
    if (panelStatus) panelStatus.textContent = T("选中文字已翻译", "Selection translated");
    const cancel = state.panel && state.panel.querySelector('[data-role="cancel"]');
    if (cancel) cancel.style.display = "none";
    box.scrollIntoView({ block: "nearest" });
  }

  async function translatePage() {
    if (state.running) return;
    const settings = await ensureSettings();
    if (!settings) return;
    if (!settings.enabled) { panel(); setStatus(T("翻译引擎未启用", "Translation is turned off")); return; }
    // Re-collecting a translated page would capture the translation as the original.
    if (state.translated) restore();
    const blocks = collect();
    if (!blocks.length) { panel(); setStatus(T("本页没有找到可翻译的文字", "No translatable text found on this page")); return; }
    const generation = ++state.generation;
    state.running = true;
    state.translated = false;
    state.records = [];
    state.total = blocks.length;
    state.done = 0;
    state.failed = 0;
    setStatus(T("正在翻译 0/" + state.total, "Translating 0/" + state.total));
    for (const batch of chunks(blocks, 2400, 12)) {
      if (generation !== state.generation) return;
      const response = await send({ type: "aliasmode-translate", texts: batch.map((block) => block.text) });
      if (generation !== state.generation) return;
      if (response && response.ok) {
        batch.forEach((block, index) => {
          const record = { el: block.el, translated: null, node: null };
          state.records.push(record);
          apply(record, response.translations[index], settings.mode);
        });
        state.done += batch.length;
      } else {
        state.failed += batch.length;
        // Nothing has been replaced yet: report and leave the page untouched.
        if (!state.done) {
          setStatus((response && response.error) || T("翻译失败，已保留原文", "Translation failed; the original stays"));
          state.running = false;
          return;
        }
      }
      setStatus((state.done + state.failed) < state.total
        ? T("正在翻译 " + (state.done + state.failed) + "/" + state.total, "Translating " + (state.done + state.failed) + "/" + state.total)
        : state.failed
          ? T(state.done + " 段已翻译，" + state.failed + " 段失败", state.done + " translated, " + state.failed + " failed")
          : T("翻译完成", "Translation complete"));
      await sleep(120);
    }
    if (generation !== state.generation) return;
    state.running = false;
    state.translated = state.records.length > 0;
    setStatus(state.failed
      ? T(state.done + " 段已翻译，" + state.failed + " 段失败", state.done + " translated, " + state.failed + " failed")
      : T("翻译完成", "Translation complete"));
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return;
    if (message.type === "aliasmode-translate-page") { void translatePage(); sendResponse({ ok: true }); }
    if (message.type === "aliasmode-translate-selection") { void translateSelection(); sendResponse({ ok: true }); }
    if (message.type === "aliasmode-show-original") {
      if (state.translated) restore(); else if (state.selectionBox) { state.selectionBox.remove(); state.selectionBox = null; }
      sendResponse({ ok: true });
    }
  });

  // Auto-translate is opt-in and off by default. It never runs on a page with almost no text.
  send({ type: "aliasmode-config" }).then((response) => {
    if (!response || !response.ok || !response.settings || !response.settings.enabled || !response.settings.autoTranslate) return;
    const target = String(response.settings.targetLanguage || "").toLowerCase().split("-")[0];
    const pageLang = String(document.documentElement.lang || navigator.language || "").toLowerCase().split("-")[0];
    if (target && pageLang && target === pageLang) return;
    if ((document.body && (document.body.innerText || "").trim().length < 40)) return;
    setTimeout(() => { if (!state.translated && !state.running) void translatePage(); }, 900);
  });
})();
`;

export const TRANSLATION_BACKGROUND = BACKGROUND;
export const TRANSLATION_CONTENT = CONTENT;
