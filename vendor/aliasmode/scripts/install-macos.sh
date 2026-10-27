#!/bin/bash
# Installs AliasMode for macOS (Apple Silicon or Intel) from a GitHub Release.
#   install-macos.sh [--version <version>] [--agent-setup]
# --agent-setup also connects installed AI agent clients and prints the helper's JSON result.
set -euo pipefail

repo="https://github.com/aliasmode/aliasmode"
# A local file:// base lets the build pipeline test an unpublished release.
base="${ALIASMODE_RELEASE_BASE:-$repo/releases/download}"
version=""
agent_setup=0

fail() {
  echo "AliasMode install failed: $1" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) [[ $# -ge 2 ]] || fail "--version needs a value"; version="$2"; shift 2 ;;
    --agent-setup) agent_setup=1; shift ;;
    *) fail "unknown option $1" ;;
  esac
done

[[ "$(uname -s)" == "Darwin" ]] || fail "this installer needs a Mac"
# A Terminal that runs under Rosetta reports x86_64 on Apple Silicon too.
if [[ "$(uname -m)" == "arm64" || "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" == 1 ]]; then
  build="aarch64"
else
  build="x64"
fi

if [[ -z "$version" ]]; then
  # The newest release that has a build for this Mac; the API lists releases newest first.
  version="$(curl -fsSL "https://api.github.com/repos/aliasmode/aliasmode/releases?per_page=20" \
    | grep -o "AliasMode_[^\"/]*_${build}\.app\.tar\.gz" | head -n 1 \
    | sed -e 's/^AliasMode_//' -e "s/_${build}\.app\.tar\.gz\$//")" || true
  [[ -n "$version" ]] || fail "no macOS release for this Mac was found"
fi
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || fail "the version is not valid"

applications="/Applications"
[[ -w "$applications" ]] || applications="$HOME/Applications"
app="$applications/AliasMode.app"
helper="$app/Contents/MacOS/aliasmode-mcp"

installed_version() {
  [[ -x "$helper" ]] && "$helper" version 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p'
}

if [[ "$(installed_version || true)" != "$version" ]]; then
  if pgrep -x aliasmode >/dev/null; then
    fail "AliasMode is open. Quit AliasMode, then run this command again"
  fi
  mkdir -p "$applications"
  work="$(mktemp -d "$applications/.aliasmode-install.XXXXXX")"
  trap 'rm -rf "$work"' EXIT
  archive="AliasMode_${version}_${build}.app.tar.gz"
  curl -fsSL -o "$work/SHA256SUMS-macos.txt" "$base/v$version/SHA256SUMS-macos.txt" \
    || fail "version $version has no macOS build"
  expected="$(awk -v name="$archive" '$2 == name { print $1 }' "$work/SHA256SUMS-macos.txt")"
  [[ -n "$expected" ]] || fail "version $version has no build for this Mac"
  curl -fL --progress-bar -o "$work/$archive" "$base/v$version/$archive" || fail "the download did not complete"
  actual="$(shasum -a 256 "$work/$archive" | awk '{ print $1 }')"
  [[ "$expected" =~ ^[0-9a-f]{64}$ && "$actual" == "$expected" ]] || fail "the download did not match its published SHA-256"
  tar -xzf "$work/$archive" -C "$work"
  codesign --verify --deep --strict "$work/AliasMode.app" || fail "the downloaded app is damaged"
  rm -rf "$app"
  mv "$work/AliasMode.app" "$app"
  rm -rf "$work"
  trap - EXIT
  [[ "$(installed_version || true)" == "$version" ]] || fail "the installed app did not report version $version"
fi

if [[ "$agent_setup" == 1 ]]; then
  exec "$helper" setup --client auto --yes --json
fi
echo "AliasMode $version is installed in $applications. Open it from there."
