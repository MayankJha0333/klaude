#!/usr/bin/env bash
# Publish all pre-built platform VSIXs to the VS Code Marketplace.
#
# Auth: either run `npx vsce login <publisher>` once (stores a PAT in the OS
# keychain), or export VSCE_PAT=<token> before running this script.
#
# Usage:
#   bash scripts/publish-targets.sh            # publish every vsix in dist-vsix/
#   bash scripts/publish-targets.sh win32-x64  # publish a single target
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="dist-vsix"
ONLY="${1:-}"
PAT_ARG=()
[ -n "${VSCE_PAT:-}" ] && PAT_ARG=(-p "$VSCE_PAT")

shopt -s nullglob
for vsix in "$OUT"/*.vsix; do
  if [ -n "$ONLY" ] && [[ "$vsix" != *"$ONLY"* ]]; then continue; fi
  echo "▶ publishing $vsix"
  npx vsce publish --packagePath "$vsix" "${PAT_ARG[@]}"
  echo "  ✓ published $vsix"
done
