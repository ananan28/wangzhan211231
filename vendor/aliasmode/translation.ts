/**
 * Page-translation settings and the loopback handoff to the injected helper.
 *
 * The engine API key lives in the OS credential store (written by the desktop UI)
 * and is handed to the manager over loopback on start. The manager keeps it in
 * memory only and gives it to the extension per request; it is never written to
 * translation.json, logs, exports or the repository.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LaunchInfo } from "./types.ts";
import {
  DEFAULT_TRANSLATION_SETTINGS,
  normalizeTranslationSettings,
  type TranslationSettings,
} from "./translation-core.ts";
import {
  TRANSLATION_BACKGROUND,
  TRANSLATION_CONTENT,
  TRANSLATION_EXTENSION_REVISION,
  TRANSLATION_MANIFEST,
  TRANSLATION_POPUP_HTML,
  TRANSLATION_POPUP_JS,
  translationExtensionDir,
} from "./translation-extension.ts";

type Generation = Pick<LaunchInfo, "debugPort" | "startedAt">;
type Binding = Generation & { token: string; directory: string };

function json(body: object, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export class TranslationService {
  private settings: TranslationSettings;
  private key = "";

  constructor(readonly path: string) {
    this.settings = this.read();
  }

  private read(): TranslationSettings {
    if (!existsSync(this.path)) return { ...DEFAULT_TRANSLATION_SETTINGS };
    try {
      return normalizeTranslationSettings(JSON.parse(readFileSync(this.path, "utf8")));
    } catch {
      return { ...DEFAULT_TRANSLATION_SETTINGS };
    }
  }

  current(): TranslationSettings {
    return { ...this.settings };
  }

  keyPresent(): boolean {
    return this.key.length > 0;
  }

  save(value: unknown): TranslationSettings {
    const next = normalizeTranslationSettings(value);
    mkdirSync(join(this.path, ".."), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.path);
    this.settings = next;
    return this.current();
  }

  /** The key stays in memory for this manager run. An empty value clears it. */
  setKey(value: unknown): void {
    if (typeof value !== "string") throw new Error("translation key must be a string");
    if (value.length > 2048) throw new Error("translation key is too long");
    this.key = value.trim();
  }

  extensionConfig(): { settings: TranslationSettings; key: string } {
    return { settings: this.current(), key: this.key };
  }
}

/**
 * One loopback endpoint per manager run, bound to the helper written into each
 * launched environment. The bearer token is per profile launch and lives only in
 * that environment's user-data directory (0600).
 */
export class TranslationBridge {
  private server?: ReturnType<typeof Bun.serve>;
  private proxies = new Map<string, Binding>();

  constructor(private service: TranslationService) {}

  get port(): number {
    return this.server?.port ?? 0;
  }

  get revision(): number {
    return TRANSLATION_EXTENSION_REVISION;
  }

  enabled(): boolean {
    return this.service.current().enabled;
  }

  listen(): void {
    if (this.server) return;
    this.server = Bun.serve({
      hostname: "127.0.0.1", port: 0, idleTimeout: 30,
      fetch: (request) => this.handle(request),
      error: () => json({ ok: false, error: "Translation is unavailable." }, 500),
    });
    this.server.unref();
  }

  install(launch: LaunchInfo): void {
    if (!launch.userDataDir) return;
    const directory = translationExtensionDir(launch.userDataDir);
    // Turning translation off removes the helper from the next launch instead of
    // leaving a stale copy that still holds a valid token.
    if (!this.enabled() || !this.port) {
      try { rmSync(join(directory, "bind.json"), { force: true }); } catch {}
      return;
    }
    const binding: Binding = {
      debugPort: launch.debugPort, startedAt: launch.startedAt, directory,
      token: randomBytes(32).toString("base64url"),
    };
    this.proxies.set(launch.profileId, binding);
    const temporary = join(directory, "bind.json.tmp");
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(join(directory, "manifest.json"), JSON.stringify(TRANSLATION_MANIFEST));
      writeFileSync(join(directory, "background.js"), TRANSLATION_BACKGROUND);
      writeFileSync(join(directory, "content.js"), TRANSLATION_CONTENT);
      writeFileSync(join(directory, "popup.html"), TRANSLATION_POPUP_HTML);
      writeFileSync(join(directory, "popup.js"), TRANSLATION_POPUP_JS);
      writeFileSync(temporary, JSON.stringify({ port: this.port, token: binding.token }), { mode: 0o600 });
      renameSync(temporary, join(directory, "bind.json"));
    } catch {
      this.retire(launch.profileId, launch);
      try { rmSync(temporary, { force: true }); } catch {}
      throw new Error("could not prepare the profile translation helper");
    }
  }

  retire(profileId: string, generation: Generation): void {
    const binding = this.proxies.get(profileId);
    if (!binding || binding.debugPort !== generation.debugPort || binding.startedAt !== generation.startedAt) return;
    this.proxies.delete(profileId);
    try { rmSync(join(binding.directory, "bind.json"), { force: true }); } catch {}
  }

  close(): void {
    this.proxies.clear();
    this.server?.stop(true);
    this.server = undefined;
  }

  async handle(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/v1/translation/config") return json({ ok: false }, 404);
    if (request.method !== "POST") return json({ ok: false }, 405);
    const authorization = request.headers.get("authorization") ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!token || ![...this.proxies.values()].some((binding) => binding.token === token)) {
      return json({ ok: false, error: "Open Nanfu to use translation." }, 401);
    }
    const config = this.service.extensionConfig();
    if (!config.settings.enabled) return json({ ok: false, error: "Translation is turned off in Nanfu." }, 409);
    return json({ ok: true, ...config });
  }
}
