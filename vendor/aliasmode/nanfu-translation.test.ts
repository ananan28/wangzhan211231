import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEngineRequest,
  deepLTarget,
  normalizeTranslationSettings,
  parseEngineResponse,
  translationChunks,
  DEFAULT_TRANSLATION_SETTINGS,
  type TranslationSettings,
} from "./translation-core.ts";
import { TranslationBridge, TranslationService } from "./translation.ts";
import { TRANSLATION_BACKGROUND, TRANSLATION_CONTENT, TRANSLATION_MANIFEST, translationExtensionDir } from "./translation-extension.ts";

const settings = (overrides: Partial<TranslationSettings> = {}): TranslationSettings =>
  normalizeTranslationSettings({ ...DEFAULT_TRANSLATION_SETTINGS, enabled: true, ...overrides });

test("settings require HTTPS except for a loopback engine", () => {
  expect(settings({ baseUrl: "https://api.example.com/v1" }).baseUrl).toBe("https://api.example.com/v1");
  expect(settings({ baseUrl: "http://127.0.0.1:8080/v1" }).baseUrl).toBe("http://127.0.0.1:8080/v1");
  expect(() => settings({ baseUrl: "http://api.example.com/v1" })).toThrow(/HTTPS/);
  expect(() => settings({ baseUrl: "api.example.com" })).toThrow(/full URL/);
  expect(() => settings({ targetLanguage: "not a tag" })).toThrow(/BCP-47/);
  expect(settings({ targetLanguage: "zh-cn" }).targetLanguage).toBe("zh-CN");
  expect(() => normalizeTranslationSettings({ ...DEFAULT_TRANSLATION_SETTINGS, engine: "google" })).toThrow(/engine/i);
  expect(() => normalizeTranslationSettings({ ...DEFAULT_TRANSLATION_SETTINGS, mode: "side-by-side" })).toThrow(/mode/i);
});

test("texts are batched in order with bounded size and count", () => {
  expect(translationChunks(["a", "b", "c"], 2, 2)).toEqual([["a", "b"], ["c"]]);
  expect(translationChunks(["aaa", "bbb", "ccc"], 5, 10)).toEqual([["aaa"], ["bbb"], ["ccc"]]);
  expect(translationChunks([])).toEqual([]);
});

test("DeepL receives its own language codes", () => {
  expect(deepLTarget("zh-CN")).toBe("ZH");
  expect(deepLTarget("en-GB")).toBe("EN-GB");
  expect(deepLTarget("en")).toBe("EN-US");
  expect(deepLTarget("pt-BR")).toBe("PT-BR");
  expect(deepLTarget("fr-FR")).toBe("FR");
});

test("each engine request carries only the configured endpoint, texts and key", () => {
  const openai = buildEngineRequest(settings({ baseUrl: "https://api.example.com/v1", model: "m1" }), ["hello"], "sk-test");
  expect(openai.url).toBe("https://api.example.com/v1/chat/completions");
  expect(openai.headers.Authorization).toBe("Bearer sk-test");
  expect(JSON.parse(openai.body)).toMatchObject({ model: "m1", temperature: 0 });
  expect(JSON.parse(openai.body).messages.at(-1).content).toBe(JSON.stringify(["hello"]));
  expect(openai.body).not.toContain("http");

  const deepl = buildEngineRequest(settings({ engine: "deepl", baseUrl: "" }), ["bonjour"], "dk");
  expect(deepl.url).toBe("https://api-free.deepl.com/v2/translate");
  expect(deepl.headers.Authorization).toBe("DeepL-Auth-Key dk");
  expect(deepl.body).toBe("text=bonjour&target_lang=ZH");

  const custom = buildEngineRequest(settings({ engine: "custom", baseUrl: "https://tr.example.com/api" }), ["a", "b"], "");
  expect(custom.url).toBe("https://tr.example.com/api");
  expect(custom.headers.Authorization).toBeUndefined();
  expect(JSON.parse(custom.body)).toEqual({ texts: ["a", "b"], targetLanguage: "zh-CN" });
});

test("engine responses are checked against the number of inputs", () => {
  expect(parseEngineResponse("openai", { choices: [{ message: { content: '["你好"]' } }] }, 1)).toEqual(["你好"]);
  expect(parseEngineResponse("openai", { choices: [{ message: { content: "```json\n[\"a\",\"b\"]\n```" } }] }, 2)).toEqual(["a", "b"]);
  expect(parseEngineResponse("deepl", { translations: [{ text: "你好" }] }, 1)).toEqual(["你好"]);
  expect(parseEngineResponse("custom", { translations: ["a"] }, 1)).toEqual(["a"]);
  expect(() => parseEngineResponse("deepl", { translations: [{ text: "one" }] }, 2)).toThrow(/unexpected response/);
  expect(() => parseEngineResponse("openai", { choices: [{ message: { content: "not json" } }] }, 1)).toThrow();
});

test("settings persist without the key, which stays in memory", () => {
  const root = mkdtempSync(join(tmpdir(), "nanfu-translation-"));
  try {
    const path = join(root, "translation.json");
    const service = new TranslationService(path);
    expect(service.keyPresent()).toBe(false);
    service.save({ ...DEFAULT_TRANSLATION_SETTINGS, enabled: true, targetLanguage: "ja-JP" });
    const stored = readFileSync(path, "utf8");
    expect(JSON.parse(stored)).toMatchObject({ enabled: true, targetLanguage: "ja-JP" });
    expect(stored).not.toContain("key");
    service.setKey("sk-secret");
    expect(service.keyPresent()).toBe(true);
    expect(readFileSync(path, "utf8")).not.toContain("sk-secret");
    expect(service.extensionConfig().key).toBe("sk-secret");
    service.setKey("");
    expect(service.extensionConfig().key).toBe("");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the helper is installed per launch and only answers with its own token", async () => {
  const root = mkdtempSync(join(tmpdir(), "nanfu-translation-"));
  const service = new TranslationService(join(root, "translation.json"));
  const bridge = new TranslationBridge(service);
  try {
    bridge.listen();
    expect(bridge.port).toBeGreaterThan(0);
    const userDataDir = join(root, "profile");
    const launch = { profileId: "p1", debugPort: 9222, startedAt: new Date(0).toISOString(), userDataDir } as never;

    // Disabled: no helper token is left behind.
    bridge.install(launch);
    expect(existsSync(join(translationExtensionDir(userDataDir), "bind.json"))).toBe(false);

    service.save({ ...DEFAULT_TRANSLATION_SETTINGS, enabled: true });
    bridge.install(launch);
    const directory = translationExtensionDir(userDataDir);
    expect(JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"))).toEqual(TRANSLATION_MANIFEST);
    for (const asset of ["background.js", "content.js", "popup.html", "popup.js", "bind.json"]) {
      expect(existsSync(join(directory, asset))).toBe(true);
    }
    const bind = JSON.parse(readFileSync(join(directory, "bind.json"), "utf8"));
    expect(bind.port).toBe(bridge.port);

    const call = (token: string) => bridge.handle(new Request(`http://127.0.0.1:${bind.port}/v1/translation/config`, {
      method: "POST", headers: { authorization: `Bearer ${token}` },
    }));
    expect((await call("wrong")).status).toBe(401);
    const ok = await call(bind.token);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, key: "", settings: { enabled: true } });

    service.save({ ...DEFAULT_TRANSLATION_SETTINGS, enabled: false });
    expect((await call(bind.token)).status).toBe(409);

    bridge.retire("p1", { debugPort: 9222, startedAt: launch.startedAt });
    expect(existsSync(join(directory, "bind.json"))).toBe(false);
  } finally {
    bridge.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the page helper never calls a fixed third-party translator", () => {
  const source = `${TRANSLATION_BACKGROUND}\n${TRANSLATION_CONTENT}`;
  expect(source).toContain("chrome.contextMenus");
  expect(source).not.toMatch(/translate\.googleapis|translate\.google\.com|translator\.google/);
  expect(source).toContain("/v1/translation/config");
});
