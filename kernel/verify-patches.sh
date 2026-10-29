#!/bin/sh
# verify-patches.sh - check the Nanfu kernel patch series against a local
# Chromium checkout at the pinned upstream tag. No network, no build, no writes
# to the checkout unless --in-tree is given.
#
#   ./kernel/verify-patches.sh --src /path/to/chromium/src
#
# For each entry of kernel/patches/series, in order, this script
#   1. checks the patch declares that it applies to the checkout's version,
#   2. runs `git apply --check` for it on top of the entries before it,
#   3. applies it to a throwaway index (never the checkout), and
#   4. greps the post-patch file for every string the patch promises.
# It stops at the first mismatch and exits 1.
#
# Usage: verify-patches.sh [options] [SRC]
#   --src DIR              Chromium checkout (default: .)
#   --series FILE          series file (default: patches/series beside this script)
#   --list                 print the series and its metadata, verify nothing
#   --in-tree              apply to the working tree instead of a temp index
#                          (leaves the checkout patched; refuses a dirty tree)
#   --allow-dirty          with --in-tree, proceed even if the tree is dirty
#   --require-version      fail when chrome/VERSION cannot be read
#   --self-test            verify the series against a throwaway fixture repo
#   --keep                 keep the temporary directory and print its path
#   -h, --help             this text
#
# Exit status: 0 every entry applied and every promise was found, 1 otherwise,
# 2 bad usage.

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

src="."
series="$script_dir/patches/series"
mode="index"
list_only=0
allow_dirty=0
require_version=0
self_test=0
keep=0

usage() {
  sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --src)          [ $# -ge 2 ] || { echo "verify: --src needs a directory" >&2; exit 2; }; src=$2; shift 2 ;;
    --series)       [ $# -ge 2 ] || { echo "verify: --series needs a file" >&2; exit 2; }; series=$2; shift 2 ;;
    --in-tree)      mode="tree"; shift ;;
    --list)         list_only=1; shift ;;
    --allow-dirty)  allow_dirty=1; shift ;;
    --require-version) require_version=1; shift ;;
    --self-test)    self_test=1; shift ;;
    --keep)         keep=1; shift ;;
    -h|--help)      usage; exit 0 ;;
    -*)             echo "verify: unknown option $1" >&2; exit 2 ;;
    *)              src=$1; shift ;;
  esac
done

die() { printf 'verify: FAIL: %s\n' "$*" >&2; exit 1; }
note() { printf 'verify: %s\n' "$*"; }

# An absolute path git.exe understands. Under Git Bash `pwd -W` gives a
# drive-letter path; elsewhere it fails and plain pwd is already absolute.
abspath() {
  d=$(dirname -- "$1")
  b=$(basename -- "$1")
  w=$(cd "$d" 2>/dev/null && { pwd -W 2>/dev/null || true; })
  [ -n "$w" ] || w=$(cd "$d" && pwd)
  printf '%s/%s\n' "$w" "$b"
}

tmpdir=$(mktemp -d 2>/dev/null || mktemp -d -t nanfu-verify)
tmpdir=$(abspath "$tmpdir/." | sed 's|/\.$||')
cleanup() {
  if [ "$keep" -eq 1 ]; then note "kept $tmpdir"; else rm -rf "$tmpdir"; fi
}
trap cleanup EXIT HUP INT TERM

[ -f "$series" ] || die "no series file at $series"

# One throwaway index per git repository, so a patch that edits a nested
# repository (v8, angle, dawn, ...) accumulates separately, as it must.
index_for() {
  key=$(printf '%s' "$1" | tr -c 'A-Za-z0-9\n' '_')
  printf '%s/index-%s\n' "$tmpdir" "$key"
}

ensure_index() {
  repo=$1
  idx=$(index_for "$repo")
  if [ ! -f "$idx" ]; then
    GIT_INDEX_FILE="$idx" git -C "$repo" read-tree HEAD 2>/dev/null \
      || die "$repo is not a git checkout with a resolvable HEAD"
  fi
}

read_version() {
  f="$1/chrome/VERSION"
  [ -f "$f" ] || return 1
  major=$(sed -n 's/^MAJOR=//p' "$f" | tr -d '\r')
  minor=$(sed -n 's/^MINOR=//p' "$f" | tr -d '\r')
  build=$(sed -n 's/^BUILD=//p' "$f" | tr -d '\r')
  patch=$(sed -n 's/^PATCH=//p' "$f" | tr -d '\r')
  [ -n "$major" ] && [ -n "$minor" ] && [ -n "$build" ] && [ -n "$patch" ] || return 1
  printf '%s.%s.%s.%s\n' "$major" "$minor" "$build" "$patch"
}

# version matches a comma-separated list of shell globs, e.g. 155.0.8059.85
version_matches() {
  _ver=$1
  _ifs=$IFS
  IFS=,
  set +e
  for _pat in $2; do
    IFS=$_ifs
    _pat=$(printf '%s' "$_pat" | tr -d ' ')
    # shellcheck disable=SC2254 # the pattern is the point
    case "$_ver" in $_pat) IFS=$_ifs; set -e; return 0 ;; esac
    IFS=,
  done
  IFS=$_ifs
  set -e
  return 1
}

# meta <patch> <field> -> every value of that header line, one per line
meta() {
  sed -n "s/^$2:[[:space:]]*//p" "$1" | tr -d '\r'
}

entry_count=0
verify_one() {
  patch=$1
  patch_abs=$2
  entry_count=$((entry_count + 1))
  name=$(basename "$patch")

  repo_rel=$(meta "$patch_abs" "Nanfu-Patch-Repo")
  [ -n "$repo_rel" ] || repo_rel="."
  repo="$verify_root/$repo_rel"
  [ -d "$repo" ] || die "$name: Nanfu-Patch-Repo '$repo_rel' is not in $verify_root"

  applies=$(meta "$patch_abs" "Nanfu-Patch-Applies-To" | head -n 1)
  [ -n "$applies" ] || die "$name: no Nanfu-Patch-Applies-To header"
  if [ -n "$version" ]; then
    version_matches "$version" "$applies" \
      || die "$name declares it applies to '$applies' but the checkout is $version"
  fi

  if [ "$mode" = "tree" ]; then
    git -C "$repo" apply --check --whitespace=nowarn "$patch_abs" 2>"$tmpdir/err" \
      || die "$name does not apply (git apply --check): $(cat "$tmpdir/err")"
    git -C "$repo" apply --whitespace=nowarn "$patch_abs" \
      || die "$name failed to apply after passing --check"
  else
    ensure_index "$repo"
    idx=$(index_for "$repo")
    GIT_INDEX_FILE="$idx" git -C "$repo" apply --cached --check --whitespace=nowarn "$patch_abs" 2>"$tmpdir/err" \
      || die "$name does not apply on top of the entries before it: $(cat "$tmpdir/err")"
    GIT_INDEX_FILE="$idx" git -C "$repo" apply --cached --whitespace=nowarn "$patch_abs" \
      || die "$name failed to apply to the index after passing --check"
  fi

  meta "$patch_abs" "Nanfu-Patch-Promise" > "$tmpdir/promises"
  if [ ! -s "$tmpdir/promises" ]; then
    die "$name declares no Nanfu-Patch-Promise, so nothing proves it took effect"
  fi
  while IFS= read -r promise; do
    path=${promise%%::*}
    needle=${promise#*::}
    [ "$path" != "$needle" ] || die "$name: promise '$promise' is not path::text"
    if [ "$mode" = "tree" ]; then
      [ -f "$repo/$path" ] || die "$name: promised file $path does not exist after applying"
      grep -F -q -- "$needle" "$repo/$path" \
        || die "$name: promise missing: $path does not contain '$needle'"
    else
      GIT_INDEX_FILE="$idx" git -C "$repo" cat-file blob ":$path" > "$tmpdir/blob" 2>/dev/null \
        || die "$name: promised file $path is not in the tree after applying"
      grep -F -q -- "$needle" "$tmpdir/blob" \
        || die "$name: promise missing: $path does not contain '$needle'"
    fi
  done < "$tmpdir/promises"
  note "ok  $name  ($(wc -l < "$tmpdir/promises" | tr -d ' ') promise(s), applies to $applies)"
}

list_series() {
  n=0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*) continue ;;
    esac
    n=$((n + 1))
    p="$script_dir/patches/$line"
    [ -f "$p" ] || { note "MISSING $line"; continue; }
    printf '%s\n  applies-to: %s\n' "$line" "$(meta "$p" Nanfu-Patch-Applies-To | head -n 1)"
    meta "$p" "Nanfu-Patch-Promise" | sed 's/^/  promise:  /'
  done < "$series"
  note "$n entr(ies)"
}

verify() {
  root=$1
  verify_root=$root
  version=""
  if v=$(read_version "$root"); then
    version=$v
  elif [ "$require_version" -eq 1 ]; then
    die "$root/chrome/VERSION is missing or unreadable"
  else
    note "warning: no chrome/VERSION in $root, version gates are not checked"
  fi
  if [ "$mode" = "tree" ] && [ "$allow_dirty" -eq 0 ]; then
    if [ -n "$(git -C "$root" status --porcelain 2>/dev/null | head -n 1)" ]; then
      die "$root has uncommitted changes; --in-tree would mix them into the result (use --allow-dirty)"
    fi
  fi
  note "series $series"
  note "tree   $root${version:+ (Chromium $version)}"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*) continue ;;
    esac
    line=$(printf '%s' "$line" | tr -d '\r')
    patch="$script_dir/patches/$line"
    [ -f "$patch" ] || die "series lists $line but $patch does not exist"
    verify_one "$line" "$(abspath "$patch")"
  done < "$series"
  note "PASS: $entry_count entr(ies) applied in order, every promise found"
}

self_test() {
  fixture="$tmpdir/fixture"
  mkdir -p "$fixture/chrome"
  git init -q "$fixture"
  git -C "$fixture" config core.autocrlf false
  printf 'MAJOR=155\nMINOR=0\nBUILD=8059\nPATCH=85\n' > "$fixture/chrome/VERSION"
  git -C "$fixture" add chrome/VERSION
  git -C "$fixture" -c user.email=kernel@nanfu.local -c user.name=fixture \
    commit -q -m "fixture: chrome/VERSION at the pinned tag"
  note "self-test: fixture checkout at $(read_version "$fixture")"
  verify "$fixture"
}

[ "$list_only" -eq 1 ] && { list_series; exit 0; }

[ -d "$src" ] || die "$src is not a directory"
src=$(abspath "$src/." | sed 's|/\.$||')

if [ "$self_test" -eq 1 ]; then
  self_test
  exit 0
fi

verify "$src"
