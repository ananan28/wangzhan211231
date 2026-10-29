/**
 * Cloud environment transfer — the sealed `.nanfu-env` + login-state payload
 * that travels through Nanfu's own service.
 *
 * The payload is sealed to the recipient's device key (X25519 → HKDF-SHA256 →
 * AES-256-GCM), so the service stores ciphertext it cannot open. The recipient's
 * keypair is generated locally on first use; only the public half is uploaded.
 * A transfer id is bound as AAD, so a sealed payload cannot be replayed onto a
 * different transfer.
 *
 * The payload reuses two existing formats rather than inventing a third:
 * `NanfuEnvPackage` carries the configuration, extension archives and a SHA-256
 * signature; `NanfuTransferPackage` carries cookies, localStorage, the auth
 * IndexedDB and the tab list.
 */

import {
  createCipheriv, createDecipheriv, createPrivateKey, createPublicKey,
  diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject,
} from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  NanfuEnvPackageError,
  createNanfuEnvPackage,
  parseNanfuEnvPackage,
  type NanfuEnvExtensionArchive,
  type NanfuEnvPackage,
} from "./nanfu-env-package.ts";
import {
  NANFU_KERNEL_VERSION,
  NANFU_TRANSFER_FORMAT,
  NANFU_TRANSFER_VERSION,
  buildNanfuTransfer,
  type NanfuTransferPackage,
} from "./nanfu-transfer.ts";
import type { NanfuEnvironmentConfig } from "./nanfu-sync.ts";

export const NANFU_CLOUD_TRANSFER_FORMAT = "nanfu-cloud-transfer";
export const NANFU_CLOUD_TRANSFER_VERSION = 1;
/** Plaintext cap; the sealed envelope is ~1.34x this and the column allows 28M. */
export const NANFU_CLOUD_MAX_PLAINTEXT = 20_000_000;
const SEAL_ALG = "x25519-hkdf-sha256-aes-256-gcm";
const SEAL_INFO = "nanfu-cloud-transfer-v1";
const KEY_FILE = "nanfu-transfer-key.json";

export class NanfuCloudTransferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NanfuCloudTransferError";
  }
}

export interface NanfuTransferIdentity {
  /** Base64 SPKI DER — safe to publish. */
  publicKey: string;
  /** Base64 PKCS8 DER — stays on this device. */
  privateKey: string;
}

function derBase64(key: KeyObject, type: "spki" | "pkcs8"): string {
  const der = type === "spki"
    ? key.export({ type: "spki", format: "der" })
    : key.export({ type: "pkcs8", format: "der" });
  return Buffer.from(der).toString("base64");
}

export function createTransferIdentity(): NanfuTransferIdentity {
  const pair = generateKeyPairSync("x25519");
  return {
    publicKey: derBase64(pair.publicKey, "spki"),
    privateKey: derBase64(pair.privateKey, "pkcs8"),
  };
}

function isIdentity(value: unknown): value is NanfuTransferIdentity {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.publicKey === "string" && record.publicKey.length > 40
    && typeof record.privateKey === "string" && record.privateKey.length > 40;
}

/** Load this device's transfer keypair, creating it on first use. */
export function loadOrCreateTransferIdentity(root: string): NanfuTransferIdentity {
  const file = join(root, KEY_FILE);
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (isIdentity(parsed)) return parsed;
  } catch {
    // Missing or unreadable: a fresh keypair is the only useful answer.
  }
  const identity = createTransferIdentity();
  mkdirSync(root, { recursive: true });
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, JSON.stringify(identity), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, file);
  return identity;
}

function publicKeyOf(encoded: string) {
  const key = createPublicKey({ key: Buffer.from(encoded, "base64"), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "x25519") throw new NanfuCloudTransferError("接收人的转移公钥类型不正确");
  return key;
}

function sharedKey(secret: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, salt, SEAL_INFO, 32));
}

/** Seal plaintext to a recipient public key. `aad` binds the ciphertext to one transfer. */
export function sealTransferPayload(recipientPublicKey: string, plaintext: string, aad: string): string {
  if (typeof recipientPublicKey !== "string" || !recipientPublicKey) {
    throw new NanfuCloudTransferError("接收人还没有启用云端转移");
  }
  if (typeof aad !== "string" || !aad) throw new NanfuCloudTransferError("转移编号无效");
  const recipient = publicKeyOf(recipientPublicKey);
  const ephemeral = generateKeyPairSync("x25519");
  let secret: Buffer;
  try {
    secret = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
  } catch {
    throw new NanfuCloudTransferError("无法为接收人生成加密密钥");
  }
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = sharedKey(secret, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return JSON.stringify({
    v: 1,
    alg: SEAL_ALG,
    epk: derBase64(ephemeral.publicKey, "spki"),
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    ct: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  });
}

function base64Field(value: unknown, name: string): Buffer {
  if (typeof value !== "string" || (value.length % 4) !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new NanfuCloudTransferError(`转移包缺少有效的${name}`);
  }
  return Buffer.from(value, "base64");
}

/** Open a sealed payload with this device's private key. */
export function openTransferPayload(identity: NanfuTransferIdentity, envelope: string, aad: string): string {
  let raw: any;
  try {
    raw = JSON.parse(envelope);
  } catch {
    throw new NanfuCloudTransferError("转移数据已损坏，无法读取");
  }
  if (!raw || raw.v !== 1 || raw.alg !== SEAL_ALG) {
    throw new NanfuCloudTransferError("转移数据使用了不支持的加密格式");
  }
  const epk = base64Field(raw.epk, "临时公钥");
  const salt = base64Field(raw.salt, "盐值");
  const iv = base64Field(raw.iv, "向量");
  const tag = base64Field(raw.tag, "校验值");
  const ciphertext = base64Field(raw.ct, "密文");
  let plaintext: Buffer;
  try {
    const privateKey = createPrivateKey({ key: Buffer.from(identity.privateKey, "base64"), format: "der", type: "pkcs8" });
    const ephemeral = createPublicKey({ key: epk, format: "der", type: "spki" });
    const secret = diffieHellman({ privateKey, publicKey: ephemeral });
    const decipher = createDecipheriv("aes-256-gcm", sharedKey(secret, salt), iv);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new NanfuCloudTransferError("无法解密这次转移：密钥不匹配或数据被修改，请让发送人重新发送");
  }
  return plaintext.toString("utf8");
}

export interface NanfuCloudTransferPayload {
  format: typeof NANFU_CLOUD_TRANSFER_FORMAT;
  version: typeof NANFU_CLOUD_TRANSFER_VERSION;
  /** Configuration, extension files and the package signature. */
  package: NanfuEnvPackage;
  /** Login state: cookies, localStorage, Telegram auth IndexedDB, tabs. */
  transfer: NanfuTransferPackage;
}

export interface NanfuCloudBuildOptions {
  environment: NanfuEnvironmentConfig;
  /** Raw `session_json` from the local profile; an empty object is allowed. */
  session: unknown;
  extensionNames?: readonly string[];
  extensionArchives?: readonly NanfuEnvExtensionArchive[];
  kernel?: string;
  createdAt?: string;
}

export function buildCloudTransferPayload(options: NanfuCloudBuildOptions): NanfuCloudTransferPayload {
  const createdAt = options.createdAt ?? new Date().toISOString();
  const pkg = createNanfuEnvPackage({
    environment: options.environment,
    extensionArchives: options.extensionArchives ?? [],
    createdAt,
  });
  const transfer = buildNanfuTransfer({
    environment: options.environment,
    session: options.session && typeof options.session === "object" ? options.session as any : {},
    extensionNames: options.extensionNames ?? [],
    kernel: options.kernel ?? NANFU_KERNEL_VERSION,
    createdAt,
    indexedDB: "auth-only",
  });
  return {
    format: NANFU_CLOUD_TRANSFER_FORMAT,
    version: NANFU_CLOUD_TRANSFER_VERSION,
    package: pkg,
    transfer,
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Parse and verify a decrypted payload before anything touches the local store. */
export function parseCloudTransferPayload(text: string): NanfuCloudTransferPayload {
  if (typeof text !== "string" || !text) throw new NanfuEnvPackageError("转移内容为空", "invalid");
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new NanfuEnvPackageError("转移内容不是有效 JSON", "format");
  }
  if (!raw || raw.format !== NANFU_CLOUD_TRANSFER_FORMAT) {
    throw new NanfuEnvPackageError("这不是南孚云端转移数据", "format");
  }
  if (raw.version !== NANFU_CLOUD_TRANSFER_VERSION) {
    throw new NanfuEnvPackageError("转移数据的版本与当前版本不兼容，请把两台设备都升级到最新版", "version");
  }
  const pkg = parseNanfuEnvPackage(JSON.stringify(raw.package ?? null));
  const transfer = raw.transfer;
  if (!transfer || transfer.format !== NANFU_TRANSFER_FORMAT) {
    throw new NanfuEnvPackageError("转移数据缺少登录态", "invalid");
  }
  if (transfer.version !== NANFU_TRANSFER_VERSION) {
    throw new NanfuEnvPackageError("登录态数据的版本与当前版本不兼容", "version");
  }
  if (!transfer.session || !Array.isArray(transfer.session.cookies) || !Array.isArray(transfer.session.origins) || !isStringArray(transfer.session.tabs)) {
    throw new NanfuEnvPackageError("转移数据中的登录态不完整", "invalid");
  }
  if (!transfer.environment || transfer.environment.id !== pkg.environment.id) {
    throw new NanfuEnvPackageError("转移数据中的环境编号不一致", "invalid");
  }
  return { format: NANFU_CLOUD_TRANSFER_FORMAT, version: NANFU_CLOUD_TRANSFER_VERSION, package: pkg, transfer };
}

/** True when the capture actually carries something to log in with. */
export function hasLoginState(payload: NanfuCloudTransferPayload): boolean {
  return payload.transfer.session.cookies.length > 0
    || payload.transfer.session.origins.some((origin) => origin.localStorage.length > 0 || (origin.indexedDB?.length ?? 0) > 0);
}
