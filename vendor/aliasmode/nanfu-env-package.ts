/**
 * `.nanfu-env` — the configuration-only environment package.
 *
 * It moves one environment's fingerprint, proxy, tags and extension files to
 * another install. Login state is deliberately absent: no cookies, tokens,
 * localStorage, IndexedDB or 2FA seeds are read or written by this module.
 * Cookies stay in the encrypted `.nanfu` transfer package (`nanfu-transfer.ts`),
 * which is a different, credential-bearing format.
 *
 * The JSON header carries the format version and a SHA-256 signature over the
 * canonical body. Import verifies the signature before touching any file, so a
 * truncated download or an edited package is rejected instead of half-applied.
 * The signature proves integrity, not identity: treat a package from an
 * untrusted person like any other archive.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { NanfuEnvironmentConfig } from "./nanfu-sync.ts";

export const NANFU_ENV_FORMAT = "nanfu-env";
export const NANFU_ENV_VERSION = 1;
export const NANFU_ENV_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const NANFU_ENV_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
export const NANFU_ENV_MAX_FILES = 1_000;
export const NANFU_ENV_MAX_STREAM_BYTES = 48 * 1024 * 1024;

/** Configuration leaves that must never appear in a `.nanfu-env` package. */
const FORBIDDEN_KEYS = new Set([
  "cookie", "cookies", "localstorage", "sessionstorage", "indexeddb",
  "token", "tokens", "accesstoken", "refreshtoken", "session", "sessions",
  "password", "emailpassword", "twofa", "auth",
]);

export type NanfuEnvPackageErrorCode = "format" | "version" | "signature" | "invalid" | "login-state" | "limit";

export class NanfuEnvPackageError extends Error {
  constructor(message: string, readonly code: NanfuEnvPackageErrorCode) {
    super(message);
    this.name = "NanfuEnvPackageError";
  }
}

export interface NanfuEnvFile {
  /** POSIX-style path relative to the extension directory. */
  path: string;
  size: number;
  sha256: string;
  /** Base64 of the exact bytes; verified against `sha256` on import. */
  data: string;
}

export interface NanfuEnvExtensionArchive {
  name: string;
  files: NanfuEnvFile[];
}

export interface NanfuEnvPackageHeader {
  format: typeof NANFU_ENV_FORMAT;
  version: number;
  createdAt: string;
  environmentId: string;
  name: string;
  engine: string;
  signature: { alg: "sha256"; value: string };
}

export interface NanfuEnvPackage {
  header: NanfuEnvPackageHeader;
  environment: NanfuEnvironmentConfig;
  extensionArchives: NanfuEnvExtensionArchive[];
  /** Shown in the UI and kept in the file so the limitation travels with it. */
  excluded: string[];
}

export const NANFU_ENV_EXCLUDED = Object.freeze([
  "登录态（cookies、localStorage、IndexedDB、会话缓存）",
  "账号密码、邮箱密码与 2FA 种子",
  "访问令牌与刷新令牌",
]);

export interface NanfuEnvFileLimits {
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxFiles?: number;
}

function limitsOf(options: NanfuEnvFileLimits = {}) {
  return {
    maxFileBytes: options.maxFileBytes ?? NANFU_ENV_MAX_FILE_BYTES,
    maxTotalBytes: options.maxTotalBytes ?? NANFU_ENV_MAX_TOTAL_BYTES,
    maxFiles: options.maxFiles ?? NANFU_ENV_MAX_FILES,
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Stable key order so the same package always produces the same signature. */
function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function signedBody(pkg: Omit<NanfuEnvPackage, "header"> & { header: Omit<NanfuEnvPackageHeader, "signature"> }): string {
  return canonicalJson(pkg);
}

function assertNoLoginState(value: unknown, path = "package"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoLoginState(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      throw new NanfuEnvPackageError(`环境包包含不允许的登录态字段（${path}.${key}）`, "login-state");
    }
    assertNoLoginState(child, `${path}.${key}`);
  }
}

function safeRelativePath(value: unknown): string {
  if (typeof value !== "string" || !value) throw new NanfuEnvPackageError("扩展文件名无效", "invalid");
  if (value.includes("\\") || value.includes("\0") || value.startsWith("/") || /^[a-zA-Z]:/.test(value)) {
    throw new NanfuEnvPackageError(`扩展文件路径不允许（${value}）`, "invalid");
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new NanfuEnvPackageError(`扩展文件路径不允许（${value}）`, "invalid");
  }
  return parts.join("/");
}

function decodeFile(file: NanfuEnvFile): Buffer {
  if (!file || typeof file !== "object") throw new NanfuEnvPackageError("扩展文件记录无效", "invalid");
  const path = safeRelativePath(file.path);
  if (!Number.isSafeInteger(file.size) || file.size < 0) throw new NanfuEnvPackageError(`扩展文件大小无效（${path}）`, "invalid");
  if (typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(file.sha256)) {
    throw new NanfuEnvPackageError(`扩展文件缺少有效校验值（${path}）`, "invalid");
  }
  if (typeof file.data !== "string" || (file.data.length % 4) !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)) {
    throw new NanfuEnvPackageError(`扩展文件内容无效（${path}）`, "invalid");
  }
  const bytes = Buffer.from(file.data, "base64");
  if (bytes.length !== file.size) throw new NanfuEnvPackageError(`扩展文件大小与内容不一致（${path}）`, "invalid");
  if (sha256(bytes) !== file.sha256.toLowerCase()) {
    throw new NanfuEnvPackageError(`扩展文件校验失败（${path}）`, "signature");
  }
  return bytes;
}

function validateEnvironment(raw: unknown): NanfuEnvironmentConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new NanfuEnvPackageError("环境包缺少环境配置", "invalid");
  const env = raw as Record<string, any>;
  if (typeof env.id !== "string" || !env.id || env.id.length > 128) throw new NanfuEnvPackageError("环境编号无效", "invalid");
  if (typeof env.name !== "string" || !env.name.trim()) throw new NanfuEnvPackageError("环境名称无效", "invalid");
  if (env.engine !== "chromium" && env.engine !== "firefox") throw new NanfuEnvPackageError("环境引擎无效", "invalid");
  if (typeof env.ua !== "string" || typeof env.timezone !== "string") throw new NanfuEnvPackageError("环境指纹信息不完整", "invalid");
  if (!env.screen || !Number.isFinite(env.screen.width) || !Number.isFinite(env.screen.height) ||
      env.screen.width <= 0 || env.screen.height <= 0) {
    throw new NanfuEnvPackageError("环境分辨率无效", "invalid");
  }
  if (!env.fingerprint || !Number.isSafeInteger(env.fingerprint.seed)) {
    throw new NanfuEnvPackageError("环境指纹种子无效", "invalid");
  }
  if (!Array.isArray(env.tags) || env.tags.some((tag: unknown) => typeof tag !== "string")) {
    throw new NanfuEnvPackageError("环境标签无效", "invalid");
  }
  if (!Array.isArray(env.extensions) || env.extensions.some((name: unknown) => typeof name !== "string")) {
    throw new NanfuEnvPackageError("扩展清单无效", "invalid");
  }
  if (env.proxy !== null && (typeof env.proxy !== "object" || typeof env.proxy.host !== "string" ||
      typeof env.proxy.port !== "string" || typeof env.proxy.user !== "string" || typeof env.proxy.pass !== "string")) {
    throw new NanfuEnvPackageError("代理配置无效", "invalid");
  }
  if (env.proxy !== null && !["http", "https", "socks5"].includes(env.proxy.type)) {
    throw new NanfuEnvPackageError("代理协议无效", "invalid");
  }
  if (typeof env.group !== "string" || typeof env.platform !== "string" || typeof env.updatedAt !== "string") {
    throw new NanfuEnvPackageError("环境配置不完整", "invalid");
  }
  return env as NanfuEnvironmentConfig;
}

export interface NanfuEnvBuildOptions {
  environment: NanfuEnvironmentConfig;
  extensionArchives?: readonly NanfuEnvExtensionArchive[];
  createdAt?: string;
  /** Import-time compatibility check; exporters always write the current version. */
  version?: number;
}

export function createNanfuEnvPackage(options: NanfuEnvBuildOptions): NanfuEnvPackage {
  const environment = validateEnvironment(options.environment);
  assertNoLoginState(environment);
  const archives = (options.extensionArchives ?? []).map((archive) => {
    if (!archive || typeof archive.name !== "string" || !archive.name.trim()) {
      throw new NanfuEnvPackageError("扩展名称无效", "invalid");
    }
    if (!Array.isArray(archive.files)) throw new NanfuEnvPackageError("扩展目录无效", "invalid");
    let total = 0;
    const seen = new Set<string>();
    const files = archive.files.map((file) => {
      const path = safeRelativePath(file.path);
      if (seen.has(path)) throw new NanfuEnvPackageError(`扩展内文件重复（${path}）`, "invalid");
      seen.add(path);
      decodeFile(file);
      total += file.size;
      if (total > NANFU_ENV_MAX_TOTAL_BYTES) throw new NanfuEnvPackageError("扩展目录超过打包大小上限", "limit");
      return { path, size: file.size, sha256: file.sha256.toLowerCase(), data: file.data };
    });
    return { name: archive.name.trim(), files };
  });

  const baseHeader = {
    format: NANFU_ENV_FORMAT,
    version: options.version ?? NANFU_ENV_VERSION,
    createdAt: options.createdAt ?? new Date().toISOString(),
    environmentId: environment.id,
    name: environment.name,
    engine: environment.engine,
  } as const;
  const body = { header: baseHeader, environment, extensionArchives: archives, excluded: [...NANFU_ENV_EXCLUDED] };
  const signature = createHash("sha256").update(signedBody(body)).digest("hex");
  return { ...body, header: { ...baseHeader, signature: { alg: "sha256", value: signature } } };
}

export function parseNanfuEnvPackage(text: string): NanfuEnvPackage {
  if (typeof text !== "string" || text.length === 0) throw new NanfuEnvPackageError("环境包为空", "invalid");
  if (text.length > NANFU_ENV_MAX_STREAM_BYTES) throw new NanfuEnvPackageError("环境包超过大小上限", "limit");
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new NanfuEnvPackageError("文件不是有效的 .nanfu-env 包（JSON 解析失败）", "format");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.header?.format !== NANFU_ENV_FORMAT) {
    throw new NanfuEnvPackageError("文件不是南孚环境包（.nanfu-env）", "format");
  }
  if (raw.header.version !== NANFU_ENV_VERSION) {
    throw new NanfuEnvPackageError(
      `环境包版本 ${String(raw.header.version)} 与当前版本 ${NANFU_ENV_VERSION} 不兼容，请使用同一版本导出与导入`,
      "version",
    );
  }
  const environment = validateEnvironment(raw.environment);
  assertNoLoginState(environment);
  if (!Array.isArray(raw.extensionArchives)) throw new NanfuEnvPackageError("环境包缺少扩展清单", "invalid");
  const archives = raw.extensionArchives.map((archive: unknown) => {
    if (!archive || typeof archive !== "object") throw new NanfuEnvPackageError("扩展目录无效", "invalid");
    const record = archive as Record<string, unknown>;
    if (typeof record.name !== "string" || !record.name.trim() || !Array.isArray(record.files)) {
      throw new NanfuEnvPackageError("扩展目录无效", "invalid");
    }
    let total = 0;
    const seen = new Set<string>();
    const files = record.files.map((file: unknown) => {
      if (!file || typeof file !== "object") throw new NanfuEnvPackageError("扩展文件记录无效", "invalid");
      const candidate = file as NanfuEnvFile;
      const path = safeRelativePath(candidate.path);
      if (seen.has(path)) throw new NanfuEnvPackageError(`扩展内文件重复（${path}）`, "invalid");
      seen.add(path);
      decodeFile(candidate);
      total += candidate.size;
      if (total > NANFU_ENV_MAX_TOTAL_BYTES) throw new NanfuEnvPackageError("扩展目录超过解包大小上限", "limit");
      return { path, size: candidate.size, sha256: candidate.sha256.toLowerCase(), data: candidate.data };
    });
    return { name: record.name.trim(), files };
  });
  const signature = raw.header.signature;
  if (!signature || signature.alg !== "sha256" || typeof signature.value !== "string" || !/^[0-9a-f]{64}$/i.test(signature.value)) {
    throw new NanfuEnvPackageError("环境包缺少有效签名", "signature");
  }
  const { format: _format, version: _version, createdAt: _createdAt, environmentId: _environmentId, name: _name, engine: _engine, signature: _signature, ...headerRest } = raw.header;
  void _format; void _version; void _createdAt; void _environmentId; void _name; void _engine; void _signature;
  if (Object.keys(headerRest).length > 0) throw new NanfuEnvPackageError("环境包头包含未知字段", "invalid");
  const body: Omit<NanfuEnvPackage, "header"> & { header: Omit<NanfuEnvPackageHeader, "signature"> } = {
    header: {
      format: NANFU_ENV_FORMAT,
      version: NANFU_ENV_VERSION,
      createdAt: String(raw.header.createdAt ?? ""),
      environmentId: String(raw.header.environmentId ?? ""),
      name: String(raw.header.name ?? ""),
      engine: String(raw.header.engine ?? ""),
    },
    environment,
    extensionArchives: archives,
    excluded: Array.isArray(raw.excluded) ? raw.excluded.filter((item: unknown): item is string => typeof item === "string") : [...NANFU_ENV_EXCLUDED],
  };
  const expected = createHash("sha256").update(signedBody(body)).digest();
  const actual = Buffer.from(signature.value, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new NanfuEnvPackageError("环境包内容与签名不一致，文件可能已损坏或被修改", "signature");
  }
  return { header: { ...body.header, signature: { alg: "sha256", value: signature.value.toLowerCase() } }, environment: body.environment, extensionArchives: body.extensionArchives, excluded: body.excluded };
}

export interface NanfuEnvImportPlan {
  id: string;
  name: string;
  renamed: boolean;
  originalId: string;
  originalName: string;
}

/**
 * Never overwrite an existing environment: a clashing id gets a numeric suffix
 * and a clashing name gets "(导入)" plus a counter.
 */
export function planNanfuEnvImport(
  pkg: NanfuEnvPackage,
  options: { takenIds: Iterable<string>; takenNames: Iterable<string> },
): NanfuEnvImportPlan {
  const takenIds = new Set([...options.takenIds].map((id) => id.toLowerCase()));
  const takenNames = new Set([...options.takenNames].map((name) => name.trim().toLowerCase()));
  const originalId = pkg.environment.id;
  const originalName = pkg.environment.name.trim() || "未命名环境";
  let id = originalId;
  for (let n = 2; takenIds.has(id.toLowerCase()); n++) {
    const suffix = `-${n}`;
    id = `${originalId.slice(0, Math.max(1, 128 - suffix.length))}${suffix}`;
  }
  let name = originalName;
  if (takenNames.has(name.toLowerCase())) {
    name = `${originalName} (导入)`;
    for (let n = 2; takenNames.has(name.toLowerCase()); n++) name = `${originalName} (导入 ${n})`;
  }
  return { id, name, renamed: name !== pkg.environment.name, originalId, originalName };
}

export function nanfuEnvPackageFileName(name: string, createdAt = new Date().toISOString()): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "environment";
  return `nanfu-${slug}-${createdAt.slice(0, 10)}.nanfu-env`;
}

/** Read one extension directory into a package archive, refusing symlinks. */
export async function collectNanfuEnvFiles(root: string, options: NanfuEnvFileLimits = {}): Promise<NanfuEnvFile[]> {
  const limits = limitsOf(options);
  const realRoot = await realpath(root);
  const files: NanfuEnvFile[] = [];
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const info = await lstat(full).catch(() => null);
      if (!info || info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!info.isFile()) continue;
      if (info.size > limits.maxFileBytes) throw new NanfuEnvPackageError(`扩展文件过大（${entry.name}）`, "limit");
      total += info.size;
      if (total > limits.maxTotalBytes) throw new NanfuEnvPackageError("扩展目录超过打包大小上限", "limit");
      if (files.length >= limits.maxFiles) throw new NanfuEnvPackageError("扩展文件数量超过上限", "limit");
      const bytes = await readFile(full);
      const path = relative(realRoot, full).split(sep).join("/");
      files.push({ path: safeRelativePath(path), size: bytes.length, sha256: sha256(bytes), data: bytes.toString("base64") });
    }
  };
  await walk(realRoot);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

/** Write an extension archive into a brand-new directory; never merges or overwrites. */
export async function writeNanfuEnvFiles(root: string, files: readonly NanfuEnvFile[], options: NanfuEnvFileLimits = {}): Promise<string> {
  const limits = limitsOf(options);
  const destination = resolve(root);
  const seen = new Set<string>();
  let total = 0;
  const decoded: Array<{ path: string; bytes: Buffer }> = [];
  for (const file of files) {
    const path = safeRelativePath(file.path);
    if (seen.has(path)) throw new NanfuEnvPackageError(`扩展内文件重复（${path}）`, "invalid");
    seen.add(path);
    const bytes = decodeFile(file);
    total += bytes.length;
    if (bytes.length > limits.maxFileBytes || total > limits.maxTotalBytes) {
      throw new NanfuEnvPackageError("扩展目录超过解包大小上限", "limit");
    }
    decoded.push({ path, bytes });
  }
  if (decoded.length > limits.maxFiles) throw new NanfuEnvPackageError("扩展文件数量超过上限", "limit");
  await mkdir(destination, { recursive: false });
  try {
    for (const file of decoded) {
      const target = resolve(destination, ...file.path.split("/"));
      if (target !== destination && !target.startsWith(`${destination}${sep}`)) {
        throw new NanfuEnvPackageError(`扩展文件路径越界（${file.path}）`, "invalid");
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.bytes, { flag: "wx", mode: 0o644 });
    }
  } catch (error) {
    await rm(destination, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return destination;
}
