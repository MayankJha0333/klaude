#!/usr/bin/env bash
# Build platform-specific Klaude VSIXs.
#
# For each VS Code target we fetch the matching @anthropic-ai/claude-code-<plat>
# native binary, swap it into the bundled CLI's bin/claude.exe, and run
# `vsce package --target <vsceTarget>`. Output lands in dist-vsix/.
#
# The optional-dep folders (node_modules/@anthropic-ai/claude-code-*) are
# excluded from the package via .vscodeignore, so each VSIX ships exactly one
# native binary.
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="$(node -e "console.log(require('./package.json').version)")"
CC_VERSION="$(node -e "console.log(require('./node_modules/@anthropic-ai/claude-code/package.json').version)")"
BIN_DEST="node_modules/@anthropic-ai/claude-code/bin/claude.exe"
CACHE="${CLAUDE_BIN_CACHE:-/tmp/claude-bins-$CC_VERSION}"
OUT="dist-vsix"

mkdir -p "$CACHE" "$OUT"

# vsceTarget : claude-code platform package suffix
TARGETS=(
  "darwin-arm64:darwin-arm64"
  "darwin-x64:darwin-x64"
  "linux-x64:linux-x64"
  "linux-arm64:linux-arm64"
  "alpine-x64:linux-x64-musl"
  "alpine-arm64:linux-arm64-musl"
  "win32-x64:win32-x64"
  "win32-arm64:win32-arm64"
)

# Optional first arg: only build matching vsce targets (comma-separated).
ONLY="${1:-}"

for entry in "${TARGETS[@]}"; do
  vsceTarget="${entry%%:*}"
  plat="${entry##*:}"

  if [ -n "$ONLY" ] && [[ ",$ONLY," != *",$vsceTarget,"* ]]; then
    continue
  fi

  pkg="@anthropic-ai/claude-code-${plat}@${CC_VERSION}"
  tgz="$CACHE/${plat}.tgz"

  echo "──────────────────────────────────────────────"
  echo "▶ $vsceTarget  ($pkg)"

  if [ ! -f "$tgz" ]; then
    echo "  fetching $pkg ..."
    ( cd "$CACHE" && npm pack "$pkg" >/dev/null 2>&1 )
    mv "$CACHE/anthropic-ai-claude-code-${plat}-${CC_VERSION}.tgz" "$tgz"
  else
    echo "  using cached $tgz"
  fi

  # Source binary is `claude` on unix targets, `claude.exe` on win32.
  if [[ "$plat" == win32-* ]]; then srcbin="claude.exe"; else srcbin="claude"; fi

  # Extract the native binary → bin/claude.exe (the launcher placeholder name
  # the extension resolves on every OS).
  rm -f "$CACHE/claude" "$CACHE/claude.exe"
  tar -xzf "$tgz" -C "$CACHE" --strip-components=1 "package/$srcbin"
  cp "$CACHE/$srcbin" "$BIN_DEST"
  chmod +x "$BIN_DEST"

  npx vsce package --target "$vsceTarget" \
    -o "$OUT/klaude-${vsceTarget}-${VERSION}.vsix" >/dev/null
  echo "  ✓ $OUT/klaude-${vsceTarget}-${VERSION}.vsix"
done

echo "──────────────────────────────────────────────"
ls -lah "$OUT"/*.vsix | awk '{print $5, $NF}'
