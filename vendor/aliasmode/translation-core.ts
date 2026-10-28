/**
 * Translation engine protocol shared by the manager and the injected page translator.
 *
 * The page translator only ever sends the text of the page to the engine the
 * operator configured. It never sends the page URL, cookies, or browsing history.
 * Requests run inside the environment's browser, so they follow its proxy.
 */

export type TranslationEngine = "openai" | "deepl" | "custom";
export type TranslationMode = "replace" | "bilingual";

export interface TranslationSettings {
  version: 1;
  enabled: boolean;
  engine: TranslationEngine;
  /** OpenAI-compatible base (…/v1) or a custom endpoint. Empty uses the DeepL default. */
  baseUrl: string;
  model: string;
  targetLanguage: string;
  mode: TranslationMode;
  autoTranslate: boolean;
}

export const DEFAULT_TRANSLATION_SETTINGS: TranslationSettings = {
  version: 1,
  enabled: false,
  engine: "openai",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  targetLanguage: "zh-CN",
  mode: "bilingual",
  autoTranslate: false,
};

export const TRANSLATION_ENGINES: readonly TranslationEngine[] = ["openai", "deepl", "custom"];
export const TRANSLATION_MODES: readonly TranslationMode[] = ["replace", "bilingual"];
export const DEEPL_FREE_URL = "https://api-free.deepl.com/v2/translate";

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
  if (engine !== "openai" && engine !== "deepl" && engine !== "custom") throw new Error("Unsupported translation engine");
  const mode = raw.mode;
  if (mode !== "replace" && mode !== "bilingual") throw new Error("Unsupported translation mode");
  const enabled = raw.enabled === true;
  const baseUrl = engine === "deepl" && (typeof raw.baseUrl !== "string" || !raw.baseUrl.trim())
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

/** DeepL uses its own language codes (ZH, EN-US, PT-BR) rather than full BCP-47. */
export function deepLTarget(language: string): string {
  const tag = new Intl.Locale(language);
  const base = tag.language.toUpperCase();
  if (base === "ZH") return "ZH";
  if (base === "EN") return tag.region ? `EN-${tag.region.toUpperCase()}` : "EN-US";
  if (base === "PT") return tag.region ? `PT-${tag.region.toUpperCase()}` : "PT-PT";
  return base;
}

export interface EngineRequest {
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
  if (settings.engine === "openai") {
    return {
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
      url: settings.baseUrl || DEEPL_FREE_URL,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...(key ? { Authorization: `DeepL-Auth-Key ${key}` } : {}),
      },
      body: form.toString(),
    };
  }
  return {
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

/** Extract one translated string per input text. Throws a readable error on any other shape. */
export function parseEngineResponse(engine: TranslationEngine, payload: unknown, expected: number): string[] {
  let translations: string[] | null = null;
  if (engine === "openai") {
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
    throw new Error("The translation engine returned an unexpected response");
  }
  return translations;
}

/** Whether a block of page text is worth sending: real letters and not just punctuation or numbers. */
export function isTranslatableText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 2) return false;
  return /[\p{L}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(trimmed);
}
