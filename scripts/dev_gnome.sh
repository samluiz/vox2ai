#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

echo "[vox2ai] Dev setup: installing extension + starting backend..."

# Install extension
bash "${SCRIPT_DIR}/install_gnome_extension.sh"

# Install/restart backend service
bash "${SCRIPT_DIR}/install_backend_service.sh"

echo ""
echo "[vox2ai] Development environment ready."
echo ""
echo "Backend logs: journalctl --user -u vox2ai.service -f"
echo "Extension logs: journalctl /usr/bin/gnome-shell -f | grep vox2ai"
echo "Restart backend: systemctl --user restart vox2ai.service"
echo ""
echo "After restarting GNOME Shell (log out/in),"
echo "press Ctrl+Space to activate vox2ai."
