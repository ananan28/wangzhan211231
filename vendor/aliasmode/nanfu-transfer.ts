/**
 * Nanfu environment transfer: a passphrase-encrypted file that carries one
 * environment's full login state (cookies including HttpOnly, localStorage,
 * IndexedDB under the selected policy) plus its configuration, so the profile
 * keeps working after moving to another device.
 *
 * Two hard rules:
 *   - nothing is ever uploaded automatically; the caller writes the file only
 *     when the user exports, and this module never logs or writes plaintext;
 *   - the package is a credential. It is always encrypted, and the default
 *     storage policy keeps only Telegram's auth IndexedDB, not chat data.
 */

import type { BrowserContext, Cookie } from "playwright-core";
import type { NanfuCipher } from "./nanfu-crypto.ts";
import { normalizeBundle } from "./session.ts";
import type { NanfuEnvironmentConfig } from "./nanfu-sync.ts";
import type { CookieRecord } from "./types.ts";

export const NANFU_TRANSFER_FORMAT = "nanfu-transfer";
export const NANFU_TRANSFER_VERSION = 1;
/** Kernel pinned by this build; a package from another kernel is a compatibility risk. */
export const NANFU_KERNEL_VERSION = "155.0.8059.85-aliasmode.4";

export type NanfuIndexedDBPolicy = "auth-only" | "all";

export interface NanfuTransferStorageNameValue {
  name: string;
  value: string;
}

export interface NanfuTransferOrigin {
  origin: string;
  localStorage: NanfuTransferStorageNameValue[];
  indexedDB?: unknown[];
}

export interface NanfuTransferCacheManifest {
  name: string;
  entries: number;
}

/** Cache names and sizes only: cache bodies are rebuildable and never packaged. */
export interface NanfuTransferServiceWorkerManifest {
  origin: string;
  registrations?: number;
  caches: NanfuTransferCacheManifest[];
}

export interface NanfuTransferPackage {
  format: typeof NANFU_TRANSFER_FORMAT;
  version: typeof NANFU_TRANSFER_VERSION;
  createdAt: string;
  source: { kernel: string };
  environment: NanfuEnvironmentConfig;
  session: {
    cookies: CookieRecord[];
    origins: NanfuTransferOrigin[];
    tabs: string[];
    telegramClient?: "a" | "k";
  };
  serviceWorkers: NanfuTransferServiceWorkerManifest[];
  /** Names only; extension archives stay on the exporting device. */
  extensions: { names: string[]; archivesIncluded: false };
  storagePolicy: NanfuIndexedDBPolicy;
  warnings: string[];
}

export class NanfuTransferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NanfuTransferError";
  }
}

function rawOrigins(raw: unknown): NanfuTransferOrigin[] {
  if (!Array.isArray(raw)) return [];
  const out: NanfuTransferOrigin[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry.origin !== "string") continue;
    let origin: string;
    try {
      const url = new URL(entry.origin);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      origin = url.origin;
    } catch {
      continue;
    }
    const localStorage = Array.isArray(entry.localStorage)
      ? entry.localStorage
          .filter((item: any) => item && typeof item.name === "string" && typeof item.value === "string")
          .map((item: any) => ({ name: item.name, value: item.value }))
      : [];
    const indexedDB = Array.isArray(entry.indexedDB) ? entry.indexedDB : [];
    out.push({ origin, localStorage, ...(indexedDB.length ? { indexedDB } : {}) });
  }
  return out;
}

function sortOrigins(origins: NanfuTransferOrigin[]): NanfuTransferOrigin[] {
  return [...origins].sort((a, b) => (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0));
}

export interface NanfuTransferBuildOptions {
  environment: NanfuEnvironmentConfig;
  /** Raw capture; `auth-only` runs it through the shared session normalizer. */
  session: { cookies?: unknown; origins?: unknown; tabs?: unknown; telegramClient?: unknown };
  serviceWorkers?: NanfuTransferServiceWorkerManifest[];
  extensionNames?: readonly string[];
  /** Kernel that produced the capture. */
  kernel: string;
  createdAt?: string;
  indexedDB?: NanfuIndexedDBPolicy;
}

export function buildNanfuTransfer(options: NanfuTransferBuildOptions): NanfuTransferPackage {
  const policy = options.indexedDB ?? "auth-only";
  const normalized = normalizeBundle(options.session);
  const origins = policy === "auth-only" ? sortOrigins(normalized.origins) : sortOrigins(rawOrigins(options.session.origins));
  const cookies = Array.isArray(options.session.cookies) ? (options.session.cookies as CookieRecord[]) : [];
  const warnings: string[] = [];
  if (cookies.length > 0) warnings.push("This file contains live login cookies for the exported environment.");
  if (policy === "all") {
    warnings.push("Full site storage is included and may contain chat history or large caches.");
  }
  const session = {
    cookies,
    origins,
    tabs: normalized.tabs,
    ...(normalized.telegramClient ? { telegramClient: normalized.telegramClient } : {}),
  };
  return {
    format: NANFU_TRANSFER_FORMAT,
    version: NANFU_TRANSFER_VERSION,
    createdAt: options.createdAt ?? new Date().toISOString(),
    source: { kernel: options.kernel },
    environment: options.environment,
    session,
    serviceWorkers: [...(options.serviceWorkers ?? [])].sort((a, b) => (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0)),
    extensions: { names: [...(options.extensionNames ?? [])].sort(), archivesIncluded: false },
    storagePolicy: policy,
    warnings,
  };
}

export function encryptNanfuTransfer(pkg: NanfuTransferPackage, cipher: NanfuCipher): string {
  return cipher.encrypt(pkg);
}

export interface NanfuTransferImportResult {
  package: NanfuTransferPackage;
  /** Present when the package came from a different kernel; never silent. */
  kernelMismatch?: { package: string; current: string };
  /** The UI must show the mismatch/warnings and ask before applying. */
  requiresAcknowledgement: boolean;
}

export function decryptNanfuTransfer(
  envelope: string,
  cipher: NanfuCipher,
  options: { kernel?: string } = {},
): NanfuTransferImportResult {
  const pkg = cipher.decrypt<NanfuTransferPackage>(envelope);
  if (!pkg || typeof pkg !== "object" || pkg.format !== NANFU_TRANSFER_FORMAT) {
    throw new NanfuTransferError("This file is not a Nanfu environment package");
  }
  if (pkg.version !== NANFU_TRANSFER_VERSION) {
    throw new NanfuTransferError(`This package uses an unsupported version (${String(pkg.version)})`);
  }
  if (!pkg.environment || typeof pkg.environment.id !== "string") {
    throw new NanfuTransferError("This package has no environment configuration");
  }
  if (!pkg.session || !Array.isArray(pkg.session.cookies) || !Array.isArray(pkg.session.origins)) {
    throw new NanfuTransferError("This package has no login state");
  }
  const current = options.kernel ?? NANFU_KERNEL_VERSION;
  const kernelMismatch = pkg.source?.kernel && pkg.source.kernel !== current
    ? { package: pkg.source.kernel, current }
    : undefined;
  return {
    package: pkg,
    ...(kernelMismatch ? { kernelMismatch } : {}),
    requiresAcknowledgement: !!kernelMismatch || (pkg.warnings?.length ?? 0) > 0,
  };
}

export interface NanfuTransferTarget {
  addCookies(cookies: CookieRecord[]): Promise<void>;
  setLocalStorage(origin: string, entries: NanfuTransferStorageNameValue[]): Promise<void>;
  writeIndexedDB(origin: string, databases: unknown[]): Promise<void>;
}

export interface NanfuTransferApplyResult {
  cookies: number;
  origins: number;
  databases: number;
}

/** Apply a decrypted package in place. Cookies go first so the first load is already signed in. */
export async function applyNanfuTransfer(
  pkg: NanfuTransferPackage,
  target: NanfuTransferTarget,
): Promise<NanfuTransferApplyResult> {
  let databases = 0;
  if (pkg.session.cookies.length > 0) await target.addCookies(pkg.session.cookies);
  for (const origin of pkg.session.origins) {
    if (origin.localStorage.length > 0) await target.setLocalStorage(origin.origin, origin.localStorage);
    if (origin.indexedDB?.length) {
      await target.writeIndexedDB(origin.origin, origin.indexedDB);
      databases += origin.indexedDB.length;
    }
  }
  return { cookies: pkg.session.cookies.length, origins: pkg.session.origins.length, databases };
}

/** The file name carries no secret; the extension marks an encrypted Nanfu package. */
export function nanfuTransferFileName(name: string, createdAt = new Date().toISOString()): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "environment";
  const date = createdAt.slice(0, 10);
  return `nanfu-${slug}-${date}.nanfu`;
}

export interface NanfuCdp {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
}

export interface NanfuCdpCaptureOptions {
  origins: readonly string[];
  indexedDB?: NanfuIndexedDBPolicy;
  /** Browser-target session: `Storage.getCookies` includes HttpOnly cookies only there. */
  cookieClient?: NanfuCdp;
}

export interface NanfuCdpCapture {
  cookies: CookieRecord[];
  origins: NanfuTransferOrigin[];
  serviceWorkers: NanfuTransferServiceWorkerManifest[];
  /** Origins whose storage could not be read; they are reported, never silently dropped. */
  unreadableOrigins: string[];
}

function cookieRecord(raw: any): CookieRecord {
  const record: CookieRecord = {
    name: String(raw.name),
    value: String(raw.value ?? ""),
    domain: String(raw.domain ?? ""),
    path: String(raw.path ?? "/"),
  };
  if (Number.isFinite(raw.expires) && raw.expires > 0) record.expires = Math.floor(raw.expires);
  if (raw.httpOnly === true) record.httpOnly = true;
  if (raw.secure === true) record.secure = true;
  if (raw.sameSite === "Strict" || raw.sameSite === "Lax" || raw.sameSite === "None") record.sameSite = raw.sameSite;
  return record;
}

/**
 * Read cookies, per-origin localStorage, optional IndexedDB and the Cache
 * Storage manifest straight from the DevTools protocol. `Storage.getCookies`
 * runs on the browser target so HttpOnly cookies are included.
 */
export async function captureNanfuFromCdp(
  cdp: NanfuCdp,
  options: NanfuCdpCaptureOptions,
): Promise<NanfuCdpCapture> {
  const cookieReply = await (options.cookieClient ?? cdp).send("Storage.getCookies");
  const cookies = (Array.isArray(cookieReply?.cookies) ? cookieReply.cookies : []).map(cookieRecord);
  const origins: NanfuTransferOrigin[] = [];
  const serviceWorkers: NanfuTransferServiceWorkerManifest[] = [];
  const unreadableOrigins: string[] = [];
  for (const origin of [...new Set(options.origins)]) {
    const entry: NanfuTransferOrigin = { origin, localStorage: [] };
    try {
      const storage = await cdp.send("DOMStorage.getDOMStorageItems", {
        storageId: { securityOrigin: origin, isLocalStorage: true },
      });
      entry.localStorage = (Array.isArray(storage?.entries) ? storage.entries : [])
        .filter((pair: any) => Array.isArray(pair) && typeof pair[0] === "string")
        .map((pair: any) => ({ name: pair[0], value: String(pair[1] ?? "") }));
    } catch {
      unreadableOrigins.push(origin);
    }
    if (options.indexedDB === "all") {
      const databases = await captureIndexedDB(cdp, origin).catch(() => []);
      if (databases.length) entry.indexedDB = databases;
    }
    origins.push(entry);
    serviceWorkers.push({
      origin,
      caches: await captureCacheManifest(cdp, origin).catch(() => []),
    });
  }
  return { cookies, origins, serviceWorkers, unreadableOrigins };
}

/** CDP wraps stored values and keys in RemoteObjects; unpack the JSON-safe part. */
function indexedDbValue(raw: any): unknown {
  if (raw && typeof raw === "object" && typeof raw.type === "string" && "value" in raw) {
    return raw.value ?? null;
  }
  return raw;
}

function indexedDbKey(raw: any): unknown {
  if (!raw || typeof raw !== "object" || typeof raw.type !== "string") return raw;
  switch (raw.type) {
    case "number":
    case "string":
      return indexedDbValue(raw);
    case "date":
      return new Date(Number(raw.date)).toISOString();
    case "array":
      return (Array.isArray(raw.array) ? raw.array : []).map(indexedDbKey);
    default:
      return indexedDbValue(raw);
  }
}

async function captureIndexedDB(cdp: NanfuCdp, origin: string): Promise<unknown[]> {
  const names = await cdp.send("IndexedDB.requestDatabaseNames", { securityOrigin: origin });
  const databases: unknown[] = [];
  for (const name of Array.isArray(names?.databaseNames) ? names.databaseNames : []) {
    const meta = await cdp.send("IndexedDB.requestDatabase", { securityOrigin: origin, databaseName: name });
    const database = meta?.database ?? (Array.isArray(meta?.objectStores) ? meta : {});
    const stores: unknown[] = [];
    for (const store of Array.isArray(database.objectStores) ? database.objectStores : []) {
      const records: unknown[] = [];
      let skipCount = 0;
      for (;;) {
        const page = await cdp.send("IndexedDB.requestData", {
          securityOrigin: origin,
          databaseName: name,
          objectStoreName: store.name,
          indexName: "",
          skipCount,
          pageSize: 1000,
          keyRange: {},
        });
        const batch = Array.isArray(page?.objectStoreDataEntries) ? page.objectStoreDataEntries : [];
        for (const record of batch) {
          records.push({ key: indexedDbKey(record.key), value: indexedDbValue(record.value) });
        }
        skipCount += batch.length;
        if (!page?.hasMore || batch.length === 0) break;
      }
      stores.push({
        name: store.name,
        keyPath: store.keyPath,
        autoIncrement: store.autoIncrement,
        indexes: store.indexes ?? [],
        records,
      });
    }
    databases.push({ name, version: Number(database.version ?? 0), stores });
  }
  return databases;
}

async function captureCacheManifest(cdp: NanfuCdp, origin: string): Promise<NanfuTransferCacheManifest[]> {
  const names = await cdp.send("CacheStorage.requestCacheNames", { securityOrigin: origin });
  const caches: NanfuTransferCacheManifest[] = [];
  for (const cache of Array.isArray(names?.caches) ? names.caches : []) {
    const page = await cdp.send("CacheStorage.requestEntries", {
      cacheId: cache.cacheId,
      skipCount: 0,
      pageSize: 1,
    });
    caches.push({ name: String(cache.cacheName ?? ""), entries: Number(page?.returnCount ?? 0) });
  }
  return caches;
}

function cdpClient(session: { send: (method: any, params?: any) => Promise<any> }): NanfuCdp {
  return { send: (method, params) => session.send(method, params) };
}

/**
 * Capture from a live Playwright context. Each origin is opened first so its
 * storage is materialised, then cookies come from the browser target (HttpOnly
 * included) and the rest from the page target.
 */
export async function captureNanfuFromBrowser(
  context: BrowserContext,
  options: NanfuCdpCaptureOptions,
): Promise<NanfuCdpCapture> {
  const page = await context.newPage();
  const pageSession = await context.newCDPSession(page);
  const browserSession = await context.browser()?.newBrowserCDPSession();
  await pageSession.send("DOMStorage.enable").catch(() => {});
  await pageSession.send("IndexedDB.enable").catch(() => {});
  const cookieClient = browserSession ? cdpClient(browserSession) : undefined;
  try {
    let capture: NanfuCdpCapture | undefined;
    for (const origin of [...new Set(options.origins)]) {
      // DOMStorage only answers for the document the target currently shows.
      await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
      // Chrome's IndexedDB agent reports version 0 and no stores until the
      // origin's metadata has been materialised in this renderer.
      await page.evaluate(async () => {
        for (const info of await indexedDB.databases()) {
          if (!info.name) continue;
          await new Promise<void>((resolve) => {
            const request = indexedDB.open(info.name!);
            request.onsuccess = () => { request.result.close(); resolve(); };
            request.onerror = () => resolve();
            request.onblocked = () => resolve();
          });
        }
      }).catch(() => {});
      const part = await captureNanfuFromCdp(cdpClient(pageSession), {
        origins: [origin],
        ...(options.indexedDB ? { indexedDB: options.indexedDB } : {}),
        ...(cookieClient ? { cookieClient } : {}),
      });
      if (!capture) {
        capture = part;
      } else {
        capture.origins.push(...part.origins);
        capture.serviceWorkers.push(...part.serviceWorkers);
        capture.unreadableOrigins.push(...part.unreadableOrigins);
      }
    }
    if (!capture) {
      capture = await captureNanfuFromCdp(cdpClient(pageSession), {
        origins: [],
        ...(cookieClient ? { cookieClient } : {}),
      });
    }
    if (!browserSession) capture.cookies = (await context.cookies()).map(playwrightCookieRecord);
    return capture;
  } finally {
    await pageSession.detach().catch(() => {});
    await browserSession?.detach().catch(() => {});
    await page.close().catch(() => {});
  }
}

function playwrightCookieRecord(cookie: Cookie): CookieRecord {
  const record: CookieRecord = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || "/",
  };
  if (cookie.expires > 0) record.expires = Math.floor(cookie.expires);
  if (cookie.httpOnly) record.httpOnly = true;
  if (cookie.secure) record.secure = true;
  record.sameSite = cookie.sameSite;
  return record;
}

function playwrightCookie(record: CookieRecord): Cookie {
  const cookie: any = {
    name: record.name,
    value: record.value,
    path: record.path || "/",
  };
  if (record.domain) cookie.domain = record.domain;
  if (record.expires !== undefined) cookie.expires = record.expires;
  if (record.httpOnly) cookie.httpOnly = true;
  if (record.secure) cookie.secure = true;
  if (record.sameSite) cookie.sameSite = record.sameSite;
  return cookie as Cookie;
}

/** Import into a live context, cookies first, then each origin's storage. */
export async function applyNanfuTransferToContext(
  context: BrowserContext,
  pkg: NanfuTransferPackage,
): Promise<NanfuTransferApplyResult> {
  const page = await context.newPage();
  const at = async (origin: string) => {
    const current = page.url();
    if (!current.startsWith(origin)) {
      await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 15_000 });
    }
  };
  try {
    return await applyNanfuTransfer(pkg, {
      addCookies: async (cookies) => {
        if (cookies.length > 0) await context.addCookies(cookies.map(playwrightCookie));
      },
      setLocalStorage: async (origin, entries) => {
        await at(origin);
        await page.evaluate((items) => {
          for (const item of items) localStorage.setItem(item.name, item.value);
        }, entries);
      },
      writeIndexedDB: async (origin, databases) => {
        await at(origin);
        await page.evaluate(async (list) => {
          for (const info of list) {
            await new Promise<void>((resolve) => {
              const request = indexedDB.deleteDatabase(info.name);
              request.onsuccess = request.onerror = request.onblocked = () => resolve();
            });
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
              const request = indexedDB.open(info.name, info.version || 1);
              request.onupgradeneeded = () => {
                for (const store of info.stores) {
                  if (request.result.objectStoreNames.contains(store.name)) continue;
                  const created = request.result.createObjectStore(store.name, {
                    keyPath: store.keyPath ?? undefined,
                    autoIncrement: !!store.autoIncrement,
                  });
                  for (const index of store.indexes ?? []) {
                    created.createIndex(index.name, index.keyPath, {
                      unique: !!index.unique,
                      multiEntry: !!index.multiEntry,
                    });
                  }
                }
              };
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => reject(request.error);
            });
            if (db.objectStoreNames.length > 0) {
              const transaction = db.transaction(Array.from(db.objectStoreNames), "readwrite");
              for (const store of info.stores) {
                const target = transaction.objectStore(store.name);
                for (const record of store.records) {
                  if (store.keyPath) target.put(record.value);
                  else target.put(record.value, record.key);
                }
              }
              await new Promise<void>((resolve, reject) => {
                transaction.oncomplete = () => resolve();
                transaction.onerror = () => reject(transaction.error);
                transaction.onabort = () => reject(transaction.error);
              });
            }
            db.close();
          }
        }, databases as any);
      },
    });
  } finally {
    await page.close().catch(() => {});
  }
}
