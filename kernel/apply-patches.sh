#!/usr/bin/env bash
# Apply the Nanfu Chromium patch series to a Chromium source tree.
#
# Usage: kernel/apply-patches.sh /path/to/chromium/src
#
# Each patch is checked before it is applied; the first failure aborts with a
# non-zero exit status. The series is validated (apply + reverse) by
# .github/workflows/kernel-patches.yml.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <chromium-src-root>" >&2
  exit 2
fi

SRC_ROOT="$(cd "$1" && pwd)"
PATCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/patches"

shopt -s nullglob
patches=("$PATCH_DIR"/*.patch)
if [[ ${#patches[@]} -eq 0 ]]; then
  echo "no patches found in $PATCH_DIR" >&2
  exit 1
fi

for patch in "${patches[@]}"; do
  name="$(basename "$patch")"
  echo "==> ${name}: git apply --check"
  git -C "$SRC_ROOT" apply --check "$patch"
  echo "==> ${name}: git apply"
  git -C "$SRC_ROOT" apply "$patch"
done

echo "applied ${#patches[@]} patch(es) to $SRC_ROOT"
