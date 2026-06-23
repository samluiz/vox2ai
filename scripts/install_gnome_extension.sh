#!/usr/bin/env bash
set -euo pipefail

UUID="vox2ai@samluiz.com"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/gnome-extension"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

echo "[vox2ai] Installing GNOME Shell extension..."
echo "  Source: $SRC"
echo "  Destination: $DEST"

rm -rf "$DEST"
mkdir -p "$DEST"
cp -a "$SRC"/. "$DEST"/

if [ -d "$DEST/schemas" ]; then
  glib-compile-schemas "$DEST/schemas"
  # Also install schema globally for gsettings CLI
  mkdir -p "$HOME/.local/share/glib-2.0/schemas"
  cp -f "$DEST/schemas/org.gnome.shell.extensions.vox2ai.gschema.xml" \
        "$HOME/.local/share/glib-2.0/schemas/"
  glib-compile-schemas "$HOME/.local/share/glib-2.0/schemas/" 2>/dev/null || true
fi

echo ""
echo "[vox2ai] Installed files:"
find "$DEST" -maxdepth 2 -type f -printf "%TY-%Tm-%Td %TH:%TM:%TS %p\n" | sort

echo ""
echo "[vox2ai] Checking for known problematic patterns..."
if grep -r "add_actor" "$DEST" 2>/dev/null; then
  echo "[vox2ai] WARNING: add_actor usage found in installed files!"
  exit 1
else
  echo "[vox2ai] OK: No add_actor usage found."
fi

echo ""
echo "[vox2ai] GNOME Wayland requires logout/login to clear cached extension modules."
echo "[vox2ai] Run after login: gnome-extensions info $UUID"
