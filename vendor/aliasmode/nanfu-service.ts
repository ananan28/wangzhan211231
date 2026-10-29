/**
 * Where the Nanfu account and transfer client points.
 *
 * The URL and publishable ("anon") key are public identifiers, so shipping the
 * defaults is safe. They stay configurable because an operator can run their own
 * project: edit `nanfu-service.json` in the Nanfu state directory or set
 * NANFU_SUPABASE_URL / NANFU_SUPABASE_KEY. The service-role/secret key is a
 * different credential and must never be configured here — this module refuses
 * anything that looks like one.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { normalizeSecureServiceUrl } from "./app-config.ts";
import { NanfuAccountRuntime, NanfuAuthClient, type NanfuCredentialStore, type NanfuFetch } from "./nanfu-account.ts";
import { NanfuSyncClient } from "./nanfu-sync.ts";

export interface NanfuRuntime {
  account: NanfuAccountRuntime;
  client: NanfuSyncClient;
  persistent: boolean;
}

export function createNanfuRuntime(options: NanfuServiceLoadOptions & {
  file: string;
  credentials?: NanfuCredentialStore;
  fetchFn?: NanfuFetch;
}): NanfuRuntime {
  const config = loadNanfuService(options);
  const auth = new NanfuAuthClient({ baseUrl: config.url, anonKey: config.publishableKey, fetchFn: options.fetchFn });
  const account = new NanfuAccountRuntime(auth, { credentials: options.credentials });
  const client = new NanfuSyncClient({
    baseUrl: config.url, anonKey: config.publishableKey, fetchFn: options.fetchFn,
    accessToken: () => account.accessTokenOrRefresh(),
  });
  return { account, client, persistent: !!options.credentials };
}

export const NANFU_DEFAULT_SERVICE = Object.freeze({
  url: "https://zojqxzaqumrtykcufqzg.supabase.co",
  publishableKey: "sb_publishable_9bVOHZCXVLnorWiIoXz61Q_S36u_wHR",
});

export interface NanfuServiceConfig {
  url: string;
  publishableKey: string;
}

export class NanfuServiceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NanfuServiceConfigError";
  }
}

/** A JWT's payload names its role; the desktop must never hold the service role. */
function jwtRole(key: string): string | undefined {
  if (!key.startsWith("eyJ")) return undefined;
  const payload = key.split(".")[1];
  if (!payload) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return typeof parsed?.role === "string" ? parsed.role : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeNanfuPublishableKey(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new NanfuServiceConfigError("A Nanfu service key is required");
  const key = value.trim();
  if (/service_role|sb_secret/i.test(key) || jwtRole(key) === "service_role") {
    throw new NanfuServiceConfigError("The service-role key must never be configured in the app");
  }
  if (!/^sb_publishable_[\w-]{20,}$/.test(key) && jwtRole(key) !== "anon") {
    throw new NanfuServiceConfigError("This is not a publishable or anon key");
  }
  return key;
}

export function normalizeNanfuService(value: unknown): NanfuServiceConfig {
  if (!value || typeof value !== "object") throw new NanfuServiceConfigError("Nanfu service settings must be an object");
  const raw = value as Record<string, unknown>;
  let url: string;
  try {
    url = normalizeSecureServiceUrl(String(raw.url ?? ""), "Nanfu service");
  } catch (error) {
    throw new NanfuServiceConfigError((error as Error).message);
  }
  return { url, publishableKey: normalizeNanfuPublishableKey(raw.publishableKey) };
}

export interface NanfuServiceLoadOptions {
  /** State-directory copy written by `saveNanfuService`. */
  file?: string;
  env?: Record<string, string | undefined>;
}

/** Defaults, then the file, then the environment: later sources win. */
export function loadNanfuService(options: NanfuServiceLoadOptions = {}): NanfuServiceConfig {
  let value: unknown = { ...NANFU_DEFAULT_SERVICE };
  if (options.file && existsSync(options.file)) {
    try {
      value = { ...(value as object), ...(JSON.parse(readFileSync(options.file, "utf8")) as object) };
    } catch {
      // A malformed file must not silently change where credentials go.
      throw new NanfuServiceConfigError("nanfu-service.json is not valid JSON");
    }
  }
  const env = options.env ?? (typeof process === "undefined" ? {} : process.env);
  const merged = { ...(value as Record<string, unknown>) };
  if (env.NANFU_SUPABASE_URL) merged.url = env.NANFU_SUPABASE_URL;
  if (env.NANFU_SUPABASE_KEY) merged.publishableKey = env.NANFU_SUPABASE_KEY;
  return normalizeNanfuService(merged);
}

export function saveNanfuService(file: string, value: unknown): NanfuServiceConfig {
  const config = normalizeNanfuService(value);
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, file);
  return config;
}
