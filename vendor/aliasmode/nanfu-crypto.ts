/**
 * Passphrase-derived encryption shared by cloud environment sync and the
 * environment transfer package. scrypt stretches the passphrase; AES-256-GCM
 * authenticates the ciphertext so a wrong passphrase or a tampered payload is
 * rejected instead of silently producing garbage.
 *
 * The salt travels inside each envelope so a second device can adopt it on the
 * first decrypt; derived keys are cached per salt.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

export interface NanfuKeyParams {
  kdf: "scrypt";
  salt: string;
  n: number;
  r: number;
  p: number;
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Cost high enough for a human passphrase, low enough for one unlock. */
export const NANFU_SCRYPT = { n: 1 << 15, r: 8, p: 1 } as const;

export function createNanfuKeyParams(workFactor: number = NANFU_SCRYPT.n): NanfuKeyParams {
  if (!Number.isInteger(workFactor) || workFactor < 1024 || (workFactor & (workFactor - 1)) !== 0) {
    throw new Error("scrypt work factor must be a power of two of at least 1024");
  }
  return { kdf: "scrypt", salt: randomBytes(16).toString("base64"), n: workFactor, r: 8, p: 1 };
}

export class NanfuDecryptError extends Error {
  constructor(message = "The passphrase does not match this data") {
    super(message);
    this.name = "NanfuDecryptError";
  }
}

export class NanfuCipher {
  private params: NanfuKeyParams | undefined;
  private readonly keys = new Map<string, Buffer>();

  constructor(
    private readonly passphrase: string,
    params?: NanfuKeyParams,
  ) {
    if (!passphrase) throw new Error("A passphrase is required");
    this.params = params;
  }

  keyParams(): NanfuKeyParams {
    if (!this.params) this.params = createNanfuKeyParams();
    return { ...this.params };
  }

  /** Adopt a remote salt only when this device has not written anything yet. */
  adoptParams(params: NanfuKeyParams): void {
    if (this.params) return;
    if (params.kdf !== "scrypt") throw new Error("Unsupported key derivation");
    this.params = { kdf: "scrypt", salt: params.salt, n: params.n, r: params.r, p: params.p };
  }

  encrypt(value: unknown): string {
    const params = this.keyParams();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(params), iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return JSON.stringify({
      v: 1,
      kdf: params.kdf,
      salt: params.salt,
      n: params.n,
      r: params.r,
      p: params.p,
      iv: iv.toString("base64"),
      ct: ciphertext.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    });
  }

  decrypt<T = unknown>(envelope: string): T {
    let raw: any;
    try {
      raw = JSON.parse(envelope);
    } catch {
      throw new NanfuDecryptError("The encrypted payload is not valid JSON");
    }
    if (raw?.v !== 1 || raw?.kdf !== "scrypt" || typeof raw.salt !== "string" || !BASE64_RE.test(raw.salt)) {
      throw new NanfuDecryptError("The encrypted payload uses an unsupported format");
    }
    if (!Number.isInteger(raw.n) || !Number.isInteger(raw.r) || !Number.isInteger(raw.p)) {
      throw new NanfuDecryptError("The encrypted payload has invalid key parameters");
    }
    for (const field of ["iv", "ct", "tag"] as const) {
      if (typeof raw[field] !== "string" || !BASE64_RE.test(raw[field])) {
        throw new NanfuDecryptError("The encrypted payload is truncated");
      }
    }
    const params: NanfuKeyParams = { kdf: "scrypt", salt: raw.salt, n: raw.n, r: raw.r, p: raw.p };
    let plaintext: Buffer;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key(params), Buffer.from(raw.iv, "base64"));
      decipher.setAuthTag(Buffer.from(raw.tag, "base64"));
      plaintext = Buffer.concat([decipher.update(Buffer.from(raw.ct, "base64")), decipher.final()]);
    } catch {
      throw new NanfuDecryptError();
    }
    this.adoptParams(params);
    try {
      return JSON.parse(plaintext.toString("utf8")) as T;
    } catch {
      throw new NanfuDecryptError("The decrypted payload is not valid JSON");
    }
  }

  private key(params: NanfuKeyParams): Buffer {
    const cached = this.keys.get(params.salt);
    if (cached) return cached;
    const key = scryptSync(this.passphrase.normalize("NFKC"), Buffer.from(params.salt, "base64"), 32, {
      N: params.n,
      r: params.r,
      p: params.p,
      maxmem: Math.max(64 * 1024 * 1024, 256 * params.n * params.r),
    });
    this.keys.set(params.salt, key);
    return key;
  }
}
