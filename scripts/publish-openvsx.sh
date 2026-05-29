#!/usr/bin/env bash
# Publish all pre-built platform VSIXs to the Open VSX Registry (open-vsx.org).
#
# Open VSX is the registry Cursor / VSCodium / Gitpod / Windsurf use — the
# Microsoft Marketplace is licensed for Microsoft products only, so this is a
# separate publish from scripts/publish-targets.sh.
#
# Auth: export OVSX_PAT=<token> (or pass it as the registry default). Tokens are
# created at https://open-vsx.org/user-settings/tokens
#
# Usage:
#   bash scripts/publish-openvsx.sh            # publish every vsix in dist-vsix/
#   bash scripts/publish-openvsx.sh alpine-x64 # publish a single target
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="dist-vsix"
ONLY="${1:-}"
PUBLISHER="$(node -e "console.log(require('./package.json').publisher)")"

if [ -z "${OVSX_PAT:-}" ]; then
  echo "✖ OVSX_PAT is not set — export your Open VSX token first." >&2
  exit 1
fi

# Namespace must exist and match the publisher. Idempotent: ignore "exists".
npx ovsx create-namespace "$PUBLISHER" -p "$OVSX_PAT" 2>/dev/null \
  && echo "created namespace $PUBLISHER" \
  || echo "namespace $PUBLISHER already exists (ok)"

shopt -s nullglob
for vsix in "$OUT"/*.vsix; do
  if [ -n "$ONLY" ] && [[ "$vsix" != *"$ONLY"* ]]; then continue; fi
  echo "▶ publishing $vsix to Open VSX"
  npx ovsx publish "$vsix" -p "$OVSX_PAT"
  echo "  ✓ $vsix"
done
