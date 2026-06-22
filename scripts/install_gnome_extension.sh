#!/usr/bin/env bash
set -euo pipefail

EXT_UUID="vox2ai@samluiz.com"
EXT_DIR="${HOME}/.local/share/gnome-shell/extensions/${EXT_UUID}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

echo "[vox2ai] Installing GNOME Shell extension..."

mkdir -p "${EXT_DIR}"

cp -r "${REPO_DIR}/gnome-extension/extension.js"   "${EXT_DIR}/"
cp -r "${REPO_DIR}/gnome-extension/prefs.js"       "${EXT_DIR}/"
cp -r "${REPO_DIR}/gnome-extension/metadata.json"  "${EXT_DIR}/"
cp -r "${REPO_DIR}/gnome-extension/stylesheet.css" "${EXT_DIR}/"
cp -r "${REPO_DIR}/gnome-extension/lib"            "${EXT_DIR}/lib"

if [ -d "${REPO_DIR}/gnome-extension/schemas" ]; then
  mkdir -p "${EXT_DIR}/schemas"
  cp -r "${REPO_DIR}/gnome-extension/schemas/"* "${EXT_DIR}/schemas/"
  glib-compile-schemas "${EXT_DIR}/schemas/"
fi

if [ -f "${EXT_DIR}/metadata.json" ]; then
  echo "[vox2ai] Extension installed to ${EXT_DIR}"
else
  echo "[vox2ai] ERROR: installation failed"
  exit 1
fi

# Try to enable the extension
if command -v gnome-extensions &>/dev/null; then
  gnome-extensions enable "${EXT_UUID}" 2>/dev/null || true
  echo "[vox2ai] Extension enabled."
fi

echo ""
echo "[vox2ai] Restart GNOME Shell (log out/in) or reboot to activate."
echo "[vox2ai] On Wayland: log out and back in, or reboot."
