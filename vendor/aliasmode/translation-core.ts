/**
 * Translation engine protocol shared by the manager and the injected page translator.
 *
 * The page translator only ever sends the text of the page to the engine the
 * operator configured. It never sends the page URL, cookies, or browsing history.
 * Requests run inside the environment's browser, so they follow its proxy.
 */

export type TranslationEngine = "google" | "openai" | "deepl" | "custom";
export type TranslationMode = "replace" | "bilingual";

export interface TranslationSettings {
  version: 1;
  enabled: boolean;
  engine: TranslationEngine;
  /** OpenAI-compatible base (…/v1) or a custom endpoint. Empty uses the DeepL default; Google has a fixed endpoint. */
  baseUrl: string;
  model: string;
  targetLanguage: string;
  mode: TranslationMode;
  autoTranslate: boolean;
}

export const DEFAULT_TRANSLATION_SETTINGS: TranslationSettings = {
  version: 1,
  enabled: false,
  engine: "google",
  // Google ignores this field; it stays filled so switching to an engine that
  // needs an endpoint starts from a working default.
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  targetLanguage: "zh-CN",
  mode: "bilingual",
  autoTranslate: false,
};

export const TRANSLATION_ENGINES: readonly TranslationEngine[] = ["google", "openai", "deepl", "custom"];
export const TRANSLATION_MODES: readonly TranslationMode[] = ["replace", "bilingual"];
export const DEEPL_FREE_URL = "https://api-free.deepl.com/v2/translate";
/** Google's keyless public endpoint. Requests only ever carry page text. */
export const GOOGLE_TRANSLATE_URL = "https://translate.googleapis.com/translate_a/single";
/** One text per Google request, short enough for the endpoint to accept as a GET query. */
export const GOOGLE_TEXT_LIMIT = 1500;

function secureUrl(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  const raw = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} must be a full URL`);
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(loopback && parsed.protocol === "http:")) {
    throw new Error(`${label} must use HTTPS`);
  }
  return raw.replace(/\/+$/, "");
}

export function normalizeTargetLanguage(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Target language is required");
  try {
    return Intl.getCanonicalLocales(value.trim())[0]!;
  } catch {
    throw new Error("Target language must be a BCP-47 language tag");
  }
}

export function normalizeTranslationSettings(value: unknown): TranslationSettings {
  if (!value || typeof value !== "object") throw new Error("Translation settings must be an object");
  const raw = value as Record<string, unknown>;
  const engine = raw.engine;
  if (engine !== "google" && engine !== "openai" && engine !== "deepl" && engine !== "custom") {
    throw new Error("Unsupported translation engine");
  }
  const mode = raw.mode;
  if (mode !== "replace" && mode !== "bilingual") throw new Error("Unsupported translation mode");
  const enabled = raw.enabled === true;
  const endpointOptional = engine === "deepl" || engine === "google";
  const baseUrl = endpointOptional && (typeof raw.baseUrl !== "string" || !raw.baseUrl.trim())
    ? ""
    : secureUrl(raw.baseUrl, "Engine URL");
  const model = typeof raw.model === "string" ? raw.model.trim().slice(0, 120) : "";
  return {
    version: 1,
    enabled,
    engine,
    baseUrl,
    model,
    targetLanguage: normalizeTargetLanguage(raw.targetLanguage ?? DEFAULT_TRANSLATION_SETTINGS.targetLanguage),
    mode,
    autoTranslate: raw.autoTranslate === true,
  };
}

/** Split block texts into request-sized batches, keeping their order. */
export function translationChunks(texts: string[], maxChars = 2500, maxItems = 12): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let chars = 0;
  for (const text of texts) {
    const size = text.length;
    if (current.length && (current.length >= maxItems || chars + size > maxChars)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(text);
    chars += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/** Split one long text at sentence or space boundaries so each Google request stays short. */
export function googleTextParts(text: string, limit = GOOGLE_TEXT_LIMIT): string[] {
  const marks = ["。", "！", "？", ". ", "! ", "? ", "; ", "\n", " "];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = 0;
    for (const mark of marks) {
      const at = rest.lastIndexOf(mark, limit - mark.length);
      if (at >= 0 && at + mark.length > cut) cut = at + mark.length;
    }
    if (cut < limit * 0.4) cut = limit;
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) parts.push(rest);
  return parts;
}

/** DeepL uses its own language codes (ZH, EN-US, PT-BR) rather than full BCP-47. */
export function deepLTarget(language: string): string {
  const tag = new Intl.Locale(language);
  const base = tag.language.toUpperCase();
  if (base === "ZH") return "ZH";
  if (base === "EN") return tag.region ? `EN-${tag.region.toUpperCase()}` : "EN-US";
  if (base === "PT") return tag.region ? `PT-${tag.region.toUpperCase()}` : "PT-PT";
  return base;
}

/**
 * Google takes a bare language code and only splits Chinese by script and
 * Portuguese by region; "nb" is spelled "no" there.
 */
export function googleTarget(language: string): string {
  const tag = new Intl.Locale(language);
  const base = tag.language.toLowerCase();
  if (base === "zh") return /hant|tw|hk|mo/.test(`${tag.script ?? ""}-${tag.region ?? ""}`.toLowerCase()) ? "zh-TW" : "zh-CN";
  if (base === "pt") return tag.region?.toLowerCase() === "pt" ? "pt-PT" : "pt-BR";
  if (base === "nb" || base === "nn") return "no";
  return base;
}

/** Google's public endpoint accepts no key; every other engine needs one. */
export function engineRequiresKey(engine: TranslationEngine): boolean {
  return engine !== "google";
}

export const MISSING_KEY_ERROR =
  "该引擎需要 API 密钥：请在南孚「设置 → 翻译」里填写密钥，或改用谷歌翻译（免密钥）。";
export const BAD_RESPONSE_ERROR = "翻译服务返回了无法识别的结果（响应格式异常）：请稍后重试，或切换引擎。";

/** Refuse to build a request that can only fail, and say what to do about it. */
export function assertEngineKey(engine: TranslationEngine, key: string): void {
  if (engineRequiresKey(engine) && !String(key ?? "").trim()) throw new Error(MISSING_KEY_ERROR);
}

export interface EngineRequest {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body: string;
}

function openAiMessages(targetLanguage: string, texts: string[]) {
  return [
    {
      role: "system",
      content: `You are a translation engine. Translate every string in the user's JSON array into ${targetLanguage}. ` +
        "Keep the same order and count. Preserve names, numbers and formatting. Return only a JSON array of strings, no commentary.",
    },
    { role: "user", content: JSON.stringify(texts) },
  ];
}

/** Build the HTTP request for one batch. `key` is sent only to the configured engine. */
export function buildEngineRequest(settings: TranslationSettings, texts: string[], key: string): EngineRequest {
  if (settings.engine === "google") {
    if (texts.length !== 1) throw new Error("谷歌翻译每次请求只处理一段文本");
    const query = new URLSearchParams({
      client: "gtx",
      sl: "auto",
      tl: googleTarget(settings.targetLanguage),
      dt: "t",
      q: texts[0]!,
    });
    return { method: "GET", url: `${GOOGLE_TRANSLATE_URL}?${query.toString()}`, headers: {}, body: "" };
  }
  assertEngineKey(settings.engine, key);
  if (settings.engine === "openai") {
    return {
      method: "POST",
      url: `${settings.baseUrl.replace(/\/+$/, "")}/chat/completions`,
      headers: {
        "Content-Type": "application/json",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({
        model: settings.model || "gpt-4o-mini",
        temperature: 0,
        messages: openAiMessages(settings.targetLanguage, texts),
      }),
    };
  }
  if (settings.engine === "deepl") {
    const form = new URLSearchParams();
    for (const text of texts) form.append("text", text);
    form.set("target_lang", deepLTarget(settings.targetLanguage));
    return {
      method: "POST",
      url: settings.baseUrl || DEEPL_FREE_URL,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...(key ? { Authorization: `DeepL-Auth-Key ${key}` } : {}),
      },
      body: form.toString(),
    };
  }
  return {
    method: "POST",
    url: settings.baseUrl,
    headers: {
      "Content-Type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({ texts, targetLanguage: settings.targetLanguage }),
  };
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value as string[] : null;
}

function parseJsonArray(content: string): string[] | null {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  try {
    return stringArray(JSON.parse(trimmed));
  } catch {
    const start = trimmed.indexOf("[");
    const end = trimmed.lastIndexOf("]");
    if (start < 0 || end <= start) return null;
    try {
      return stringArray(JSON.parse(trimmed.slice(start, end + 1)));
    } catch {
      return null;
    }
  }
}

/**
 * Join Google's `translate_a/single` segments. Each segment starts with the
 * translated text; empty segments (layout artifacts) are skipped. An empty
 * result is a failure, never a silent fall back to the source text.
 */
export function parseGoogleResponse(payload: unknown): string {
  const segments = Array.isArray(payload) ? (payload as unknown[])[0] : null;
  if (!Array.isArray(segments)) throw new Error(BAD_RESPONSE_ERROR);
  let translated = "";
  for (const segment of segments) {
    if (Array.isArray(segment) && typeof segment[0] === "string") translated += segment[0];
  }
  const trimmed = translated.trim();
  if (!trimmed) throw new Error(BAD_RESPONSE_ERROR);
  return trimmed;
}

/** Extract one translated string per input text. Throws a readable error on any other shape. */
export function parseEngineResponse(engine: TranslationEngine, payload: unknown, expected: number): string[] {
  let translations: string[] | null = null;
  if (engine === "google") {
    // One Google request carries one text; its response holds a list of segments.
    if (expected !== 1) throw new Error("谷歌翻译每次请求只处理一段文本");
    translations = [parseGoogleResponse(payload)];
  } else if (engine === "openai") {
    const content = (payload as any)?.choices?.[0]?.message?.content;
    translations = typeof content === "string" ? parseJsonArray(content) : null;
  } else if (engine === "deepl") {
    const items = (payload as any)?.translations;
    translations = Array.isArray(items) && items.every((item) => typeof item?.text === "string")
      ? items.map((item) => item.text as string)
      : null;
  } else {
    translations = stringArray((payload as any)?.translations) ?? stringArray((payload as any)?.texts) ?? stringArray(payload);
  }
  if (!translations || translations.length !== expected) {
    throw new Error(BAD_RESPONSE_ERROR);
  }
  return translations;
}

/** Whether a block of page text is worth sending: real letters and not just punctuation or numbers. */
export function isTranslatableText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 2) return false;
  return /[\p{L}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(trimmed);
}
