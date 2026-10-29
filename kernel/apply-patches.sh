#!/bin/sh
# Compatibility shim. The only implementation is kernel/verify-patches.sh.
#
# .github/workflows/kernel-patches.yml invokes this path by name, and that
# workflow cannot be edited from here, so the path has to keep working. It does
# nothing of its own: it runs the verifier in --in-tree mode, which applies the
# series in order and checks each patch's promise against the resulting file.
#
# Use kernel/verify-patches.sh directly; this file exists for the workflow only.
#
# Usage: kernel/apply-patches.sh <chromium-src-root>

set -eu

if [ $# -ne 1 ]; then
  echo "usage: $0 <chromium-src-root>" >&2
  exit 2
fi

exec sh "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/verify-patches.sh" \
  --in-tree --allow-dirty "$1"
