import { test, expect } from "bun:test";
import {
  DEFAULT_FAVORITE_SITES,
  FAVORITES_STORAGE_KEY,
  createFavoriteSite,
  loadFavoriteSites,
  saveFavoriteSites,
  validateFavoriteUrl,
  type FavoriteStorage,
} from "./favorites";

function memoryStorage(initial?: string): FavoriteStorage {
  let value = initial ?? null;
  return {
    getItem: (key) => (key === FAVORITES_STORAGE_KEY ? value : null),
    setItem: (key, next) => {
      if (key === FAVORITES_STORAGE_KEY) value = next;
    },
  };
}

test("ships the three built-in shortcuts", () => {
  expect(DEFAULT_FAVORITE_SITES).toEqual([
    { name: "Bluesky", url: "https://bsky.app/" },
    { name: "Truth Social", url: "https://truthsocial.com/@realDonaldTrump" },
    { name: "临时邮箱", url: "https://ananan28.github.io/temp-mail/?v=20261011-17" },
  ]);
  for (const site of DEFAULT_FAVORITE_SITES) {
    expect(validateFavoriteUrl(site.url).ok).toBe(true);
  }
});

test("accepts only https addresses", () => {
  expect(validateFavoriteUrl("https://bsky.app/")).toEqual({ ok: true, url: "https://bsky.app/" });
  expect(validateFavoriteUrl("  https://example.com/path?q=1  ")).toEqual({
    ok: true,
    url: "https://example.com/path?q=1",
  });

  for (const rejected of [
    "http://example.com",
    "ftp://example.com",
    "javascript:alert(1)",
    "file:///C:/secret.txt",
    "example.com",
    "",
    "   ",
  ]) {
    const result = validateFavoriteUrl(rejected);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("https");
  }
});

test("a blank name falls back to the hostname", () => {
  expect(createFavoriteSite("", "https://example.com")).toEqual({
    ok: true,
    site: { name: "example.com", url: "https://example.com/" },
  });
  expect(createFavoriteSite("  我的邮箱 ", "https://mail.example.com/inbox")).toEqual({
    ok: true,
    site: { name: "我的邮箱", url: "https://mail.example.com/inbox" },
  });
});

test("invalid addresses are rejected before they reach the list", () => {
  const result = createFavoriteSite("bad", "http://example.com");
  expect(result.ok).toBe(false);
});

test("loads defaults when nothing is stored and returns an empty list after deleting everything", () => {
  const storage = memoryStorage();
  expect(loadFavoriteSites(storage)).toEqual([...DEFAULT_FAVORITE_SITES]);
  saveFavoriteSites([], storage);
  expect(loadFavoriteSites(storage)).toEqual([]);
});

test("round-trips user sites and drops corrupted entries", () => {
  const storage = memoryStorage();
  const sites = [{ name: "Docs", url: "https://example.com/docs" }];
  saveFavoriteSites(sites, storage);
  expect(loadFavoriteSites(storage)).toEqual(sites);

  const corrupt = memoryStorage(JSON.stringify([
    { name: "ok", url: "https://example.com/" },
    { name: "bad", url: "http://example.com/" },
    { name: 42, url: "https://example.com/" },
  ]));
  expect(loadFavoriteSites(corrupt)).toEqual([{ name: "ok", url: "https://example.com/" }]);

  expect(loadFavoriteSites(memoryStorage("not json"))).toEqual([...DEFAULT_FAVORITE_SITES]);
  expect(loadFavoriteSites(memoryStorage(JSON.stringify({})))).toEqual([...DEFAULT_FAVORITE_SITES]);
});
