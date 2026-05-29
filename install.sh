#!/bin/sh
# kage installer — installs the `kage` CLI (a single, zero-dependency Node script).
#
#   curl -fsSL https://raw.githubusercontent.com/kid7st/kage/main/install.sh | sh
#
# Env:
#   KAGE_VERSION   version to install (default: latest)
#   KAGE_BIN_DIR   install location (default: ~/.local/bin)
set -e

VERSION="${KAGE_VERSION:-latest}"
BIN_DIR="${KAGE_BIN_DIR:-$HOME/.local/bin}"
SRC="https://cdn.jsdelivr.net/npm/pi-kage@${VERSION}/bin/kage.mjs"
TARGET="$BIN_DIR/kage"

if ! command -v node >/dev/null 2>&1; then
	echo "✗ kage needs Node.js (>= 18). Install it first: https://nodejs.org" >&2
	exit 1
fi

if command -v curl >/dev/null 2>&1; then
	DL="curl -fsSL"
elif command -v wget >/dev/null 2>&1; then
	DL="wget -qO-"
else
	echo "✗ need curl or wget to download" >&2
	exit 1
fi

echo "Downloading kage ($VERSION)…"
TMP="$(mktemp)"
$DL "$SRC" >"$TMP"
if ! head -1 "$TMP" | grep -q "env node"; then
	echo "✗ download failed or looks wrong (got non-script content)" >&2
	rm -f "$TMP"
	exit 1
fi

mkdir -p "$BIN_DIR"
mv "$TMP" "$TARGET"
chmod +x "$TARGET"

echo "✓ installed kage $("$TARGET" --version 2>&1) → $TARGET"

case ":$PATH:" in
*":$BIN_DIR:"*) ;;
*)
	echo ""
	echo "⚠  $BIN_DIR is not on your PATH. Add it, then restart your shell:"
	echo "     echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.zshrc   # or ~/.bashrc"
	;;
esac

echo ""
echo "Run 'kage --help' to start. Requires git + pi on your PATH."
echo "Optional shell integration:  eval \"\$(kage shell-init)\""
