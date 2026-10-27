import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");

test("the macOS installer, build and release workflows agree on the release file names", () => {
  const installer = read("scripts/install-macos.sh");
  const build = read(".github/workflows/macos-desktop.yml");
  const release = read(".github/workflows/macos-release.yml");

  // Apple Silicon files end in _aarch64 and Intel files in _x64, as Tauri names the .dmg.
  expect(installer).toContain('build="aarch64"');
  expect(installer).toContain('build="x64"');
  expect(installer).toContain('archive="AliasMode_${version}_${build}.app.tar.gz"');
  expect(installer).toContain('"$base/v$version/SHA256SUMS-macos.txt"');
  expect(build).toContain("arch: aarch64,");
  expect(build).toContain("arch: x64,");
  expect(build).toContain("AliasMode_${version}_${ARCH}.app.tar.gz");
  expect(build).toContain("SHA256SUMS-macos.txt");
  expect(release).toContain("SHA256SUMS-macos.txt");
  // The app reads these feeds and archive names (src-tauri/src/releases.rs).
  const updater = read("src-tauri/src/releases.rs");
  for (const [arch, feed, target] of [["aarch64", "latest-macos.json", "darwin-aarch64"], ["x64", "latest-macos-x64.json", "darwin-x86_64"]]) {
    expect(updater).toContain(`const UPDATE_MANIFEST: &str = "${feed}";`);
    expect(updater).toContain(`const UPDATE_TARGET: &str = "${target}";`);
    expect(updater).toContain(`format!("AliasMode_{version}_${arch}.app.tar.gz")`);
    expect(release).toContain(`AliasMode_\${VERSION}_${arch}.app.tar.gz`);
    expect(release).toContain(`assets/${feed}`);
    expect(release).toContain(`{version: $version, platforms: {"${target}": {url: $url, signature: $signature}}}`);
  }
  // The Windows update feed accepts exactly one platform, so macOS files must never enter it.
  expect(release).not.toContain("latest-v2.json");
  expect(release).not.toContain("--clobber");
});
