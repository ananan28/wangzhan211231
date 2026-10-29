/**
 * Local-only shortcut list for the environment roster. Entries never leave
 * this computer; they are kept in localStorage and only https URLs are allowed.
 */

export interface FavoriteSite {
  name: string;
  url: string;
}

export interface FavoriteStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export const FAVORITES_STORAGE_KEY = "nanfu.favoriteSites.v1";

export const DEFAULT_FAVORITE_SITES: readonly FavoriteSite[] = [
  { name: "Bluesky", url: "https://bsky.app/" },
  { name: "Truth Social", url: "https://truthsocial.com/@realDonaldTrump" },
  { name: "临时邮箱", url: "https://ananan28.github.io/temp-mail/?v=20261011-17" },
];

export function validateFavoriteUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: "请填写 https 地址" };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "地址格式不正确，请填写完整的 https 地址" };
  }
  if (parsed.protocol !== "https:") return { ok: false, error: "只支持 https 地址" };
  if (!parsed.hostname) return { ok: false, error: "地址缺少域名" };
  return { ok: true, url: parsed.toString() };
}

export function createFavoriteSite(name: string, rawUrl: string): { ok: true; site: FavoriteSite } | { ok: false; error: string } {
  const checked = validateFavoriteUrl(rawUrl);
  if (!checked.ok) return checked;
  const label = name.trim() || new URL(checked.url).hostname;
  return { ok: true, site: { name: label, url: checked.url } };
}

function resolveStorage(storage?: FavoriteStorage): FavoriteStorage | null {
  if (storage) return storage;
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function sanitizeSites(value: unknown): FavoriteSite[] {
  if (!Array.isArray(value)) return [];
  const sites: FavoriteSite[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const name = (item as { name?: unknown }).name;
    const url = (item as { url?: unknown }).url;
    if (typeof name !== "string" || typeof url !== "string") continue;
    const checked = validateFavoriteUrl(url);
    if (!checked.ok) continue;
    sites.push({ name: name.trim() || new URL(checked.url).hostname, url: checked.url });
  }
  return sites;
}

export function loadFavoriteSites(storage?: FavoriteStorage): FavoriteSite[] {
  const target = resolveStorage(storage);
  if (!target) return DEFAULT_FAVORITE_SITES.map((site) => ({ ...site }));
  let raw: string | null;
  try {
    raw = target.getItem(FAVORITES_STORAGE_KEY);
  } catch {
    return DEFAULT_FAVORITE_SITES.map((site) => ({ ...site }));
  }
  if (raw === null) return DEFAULT_FAVORITE_SITES.map((site) => ({ ...site }));
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_FAVORITE_SITES.map((site) => ({ ...site }));
    return sanitizeSites(parsed);
  } catch {
    return DEFAULT_FAVORITE_SITES.map((site) => ({ ...site }));
  }
}

export function saveFavoriteSites(sites: readonly FavoriteSite[], storage?: FavoriteStorage): void {
  const target = resolveStorage(storage);
  if (!target) return;
  try {
    target.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(sites));
  } catch {
    // Storage can be full or blocked; the in-memory list still works this session.
  }
}
