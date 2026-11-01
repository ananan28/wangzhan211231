/**
 * Cloud-primary window sync for one signed-in Nanfu account.
 *
 * The account's cloud slot is the source of truth; this machine keeps an
 * encrypted recent cache in the local window store. Signing in pulls windows
 * this computer does not have yet, uploads windows the cloud has never seen,
 * and follows ownership changes so a window transferred to another account
 * leaves this one.
 *
 * Only environment *configuration* travels here (fingerprint, proxy, tags,
 * screen, timezone). Cookies and login state keep their existing sealed-package
 * path (`nanfu-transfer.ts`); this module never reads them.
 */

import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NanfuCipher, NANFU_SCRYPT } from "./nanfu-crypto.ts";
import {
  exportNanfuEnvironment,
  NANFU_SYNC_SCHEMA,
  type NanfuEnvironmentConfig,
  type NanfuSyncClient,
} from "./nanfu-sync.ts";
import type { ProfileStore } from "./store.ts";
import type { Profile, ProxyType } from "./types.ts";

/**
 * The cloud key is derived from the account password and the account id, with a
 * fixed per-account salt, so the same password on another machine derives the
 * same key and all of that account's windows decrypt there. Nothing extra to
 * remember and nothing stored on the server in plaintext.
 */
export function createNanfuAccountCipher(password: string, userId: string): NanfuCipher {
  const salt = createHash("sha256").update(`nanfu-sync-v1:${userId}`).digest().subarray(0, 16).toString("base64");
  return new NanfuCipher(password, {
    kdf: "scrypt",
    salt,
    n: NANFU_SCRYPT.n,
    r: NANFU_SCRYPT.r,
    p: NANFU_SCRYPT.p,
  });
}

/** Stable per-install id the cloud uses to attribute writes. Not a secret. */
export function nanfuDeviceId(root: string): string {
  const file = join(root, "nanfu-device-id");
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (existing) return existing.slice(0, 64);
  } catch {
    // First run on this machine.
  }
  const id = randomUUID();
  try {
    writeFileSync(file, id, { encoding: "utf8", mode: 0o600 });
  } catch {
    // A read-only state directory still yields a usable in-memory id.
  }
  return id;
}

function profileFromEnvironment(environment: NanfuEnvironmentConfig): Profile {
  return {
    id: environment.id,
    engine: "chromium",
    accId: "",
    name: environment.name,
    group: environment.group,
    platform: environment.platform,
    username: "",
    password: "",
    twofa: "",
    proxy: environment.proxy
      ? {
          type: environment.proxy.type as ProxyType,
          host: environment.proxy.host,
          port: environment.proxy.port,
          user: environment.proxy.user,
          pass: environment.proxy.pass,
        }
      : null,
    extensions: [],
    tags: [...environment.tags],
    ua: environment.ua,
    timezone: environment.timezone,
    locale: environment.locale,
    screenWidth: environment.screen.width,
    screenHeight: environment.screen.height,
    ...(environment.doNotTrack ? { doNotTrack: true } : {}),
    fingerprintSeed: environment.fingerprint.seed,
    ...(environment.fingerprint.platformOs ? { platformOs: environment.fingerprint.platformOs } : {}),
    ...(environment.fingerprint.hardwareCores ? { hardware: { cores: environment.fingerprint.hardwareCores } } : {}),
    ...(environment.memoryGb ? { memoryGb: environment.memoryGb } : {}),
    ...(environment.gpuVendor && environment.gpuRenderer
      ? { gpuVendor: environment.gpuVendor, gpuRenderer: environment.gpuRenderer }
      : {}),
    cookies: [],
    seeded: false,
  };
}

export interface NanfuSyncSummary {
  pulled: number;
  pushed: number;
  moved: number;
}

export interface NanfuSyncOptions {
  store: ProfileStore;
  client: NanfuSyncClient;
  cipher: NanfuCipher;
  userId: string;
  deviceId: string;
  /**
   * The organization's environment → owner map, when the caller may see the
   * whole organization. Used to follow transfers: a window whose cloud owner
   * changed moves to that account on this machine instead of lingering here.
   */
  remoteOwners?: ReadonlyMap<string, string>;
  /** The signed-in account's organization, so the cloud row is organization-visible. */
  orgId?: string;
}

/**
 * Reconcile the local cache with the account's cloud slot. Failures are
 * contained per window: a corrupt envelope or a rejected upload must not stop
 * the other windows from syncing, and the caller treats the whole run as
 * best effort.
 */
export async function syncNanfuAccountWindows(options: NanfuSyncOptions): Promise<NanfuSyncSummary> {
  const { store, client, cipher, userId, deviceId } = options;
  const summary: NanfuSyncSummary = { pulled: 0, pushed: 0, moved: 0 };

  // 1) Follow ownership changes first, so a window transferred away is not
  //    pulled back as if this account still owned it.
  if (options.remoteOwners) {
    for (const local of store.listProfileOwners()) {
      const remoteOwner = options.remoteOwners.get(local.id);
      if (remoteOwner && remoteOwner !== local.owner) {
        if (store.reassignOwner(local.id, remoteOwner)) summary.moved += 1;
      }
    }
  }

  const remote = await client.list(userId);
  const remoteById = new Map(remote.filter((row) => !row.deleted).map((row) => [row.id, row]));

  // 2) Pull: materialize remote windows this machine does not have yet.
  for (const row of remoteById.values()) {
    if (!row.envelope || store.getProfile(row.id)) continue;
    let config: NanfuEnvironmentConfig;
    try {
      config = cipher.decrypt<NanfuEnvironmentConfig>(row.envelope);
    } catch {
      continue;
    }
    if (config?.schema !== NANFU_SYNC_SCHEMA) continue;
    try {
      store.upsertProfile(profileFromEnvironment(config));
      summary.pulled += 1;
    } catch {
      // A name/id collision with another account's window must not abort the run.
    }
  }

  // 3) Push only the windows the cloud has never seen. Windows it already has
  //    are updated by the save hook, so signing in stays fast with a large
  //    roster.
  const extensionNames = new Map(store.listExtensions().map((item) => [item.id, item.name]));
  for (const profile of store.listProfiles()) {
    if (remoteById.has(profile.id)) continue;
    try {
      const config = exportNanfuEnvironment(profile, extensionNames, new Date().toISOString());
      await client.upsert(userId, deviceId, {
        id: profile.id,
        version: 0,
        envelope: cipher.encrypt(config),
        dirty: true,
      }, options.orgId);
      summary.pushed += 1;
    } catch {
      // Keep going: the next sign-in retries the windows that failed.
    }
  }

  return summary;
}

/**
 * Login-state (cookies, localStorage, IndexedDB) auto-sync.
 *
 * The bundle captured on window close is encrypted with the same
 * password-derived key as the configuration, so signing in with the same
 * account password on another machine restores the logins. It lives in the
 * account's personal cloud slot and is tagged with a reserved device id, which
 * keeps it out of the explicit transfer package list.
 */
export const NANFU_SESSION_SYNC_DEVICE = "auto-sync";
export const NANFU_SESSION_FORMAT = "nanfu-session-sync";

/** One window always maps to the same slot, so re-uploads replace it. */
function sessionPackageId(environmentId: string): string {
  const bytes = createHash("sha256").update(`nanfu-session:${environmentId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export async function pushNanfuSession(options: {
  client: NanfuSyncClient;
  cipher: NanfuCipher;
  userId: string;
  profileId: string;
  profileName?: string;
  bundle: string;
}): Promise<void> {
  await options.client.upsertCloudPackage({
    id: sessionPackageId(options.profileId),
    userId: options.userId,
    environmentId: options.profileId,
    environmentName: options.profileName ?? options.profileId,
    deviceId: NANFU_SESSION_SYNC_DEVICE,
    payload: options.cipher.encrypt({ format: NANFU_SESSION_FORMAT, bundle: options.bundle }),
    sizeBytes: options.bundle.length,
  });
}

export async function pullNanfuSessions(options: {
  store: ProfileStore;
  client: NanfuSyncClient;
  cipher: NanfuCipher;
  userId: string;
}): Promise<number> {
  const { store, client, cipher, userId } = options;
  let restored = 0;
  const rows = await client.cloudPackages(userId);
  for (const row of rows) {
    if (row.deviceId !== NANFU_SESSION_SYNC_DEVICE) continue;
    if (!store.getProfile(row.environmentId)) continue;
    // A local capture is newer than whatever the cloud holds for this machine.
    if (store.getSessionBundle(row.environmentId)) continue;
    try {
      const { payload } = await client.cloudPackage(row.id, userId);
      const value = cipher.decrypt<{ format?: string; bundle?: string }>(payload);
      if (value?.format !== NANFU_SESSION_FORMAT || typeof value.bundle !== "string" || !value.bundle) continue;
      store.armSessionRestore(row.environmentId, value.bundle);
      restored += 1;
    } catch {
      // Skip a slot this key cannot open; the other windows still restore.
    }
  }
  return restored;
}

/**
 * Transfers are moves: once a package is accepted, the sender no longer owns
 * that window. Retire the sender's local copy (to Trash, where it stays
 * recoverable) and drop the sender's cloud record, so only the recipient has it.
 */
export async function retireAcceptedTransfers(options: {
  store: ProfileStore;
  client: NanfuSyncClient;
  userId: string;
}): Promise<number> {
  const { store, client, userId } = options;
  let retired = 0;
  const sent = await client.sentCloudTransfers(userId);
  for (const row of sent) {
    if (row.status !== "accepted") continue;
    if (!store.getProfile(row.environmentId)) continue;
    if (store.trashProfile(row.environmentId)) retired += 1;
    await client.remove(userId, row.environmentId).catch(() => undefined);
  }
  return retired;
}

/** Push one window after an edit, so the cloud copy follows local changes. */
export async function pushNanfuWindow(options: {
  store: ProfileStore;
  client: NanfuSyncClient;
  cipher: NanfuCipher;
  userId: string;
  deviceId: string;
  orgId?: string;
  profile: Profile;
}): Promise<void> {
  const extensionNames = new Map(options.store.listExtensions().map((item) => [item.id, item.name]));
  const config = exportNanfuEnvironment(options.profile, extensionNames, new Date().toISOString());
  await options.client.upsert(options.userId, options.deviceId, {
    id: options.profile.id,
    version: 0,
    envelope: options.cipher.encrypt(config),
    dirty: true,
  }, options.orgId);
}
