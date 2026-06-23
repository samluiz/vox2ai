#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

# Resolve vox2ai command
VOX2AI=""
if [ -x "${REPO_DIR}/.venv/bin/vox2ai" ]; then
  VOX2AI="${REPO_DIR}/.venv/bin/vox2ai"
elif command -v vox2ai &>/dev/null; then
  VOX2AI=$(command -v vox2ai)
else
  echo "[vox2ai] ERROR: vox2ai command not found"
  echo "[vox2ai] Install with: pip install -e ."
  exit 1
fi

echo "[vox2ai] Installing systemd user service..."
echo "[vox2ai] Using vox2ai: ${VOX2AI}"

SERVICE_DIR="${HOME}/.config/systemd/user"
mkdir -p "${SERVICE_DIR}"

cat > "${SERVICE_DIR}/vox2ai.service" << SERVICEEOF
[Unit]
Description=vox2ai backend service
After=graphical-session.target

[Service]
Type=simple
WorkingDirectory=${REPO_DIR}
ExecStart=${VOX2AI} server
Restart=on-failure
RestartSec=2
Environment=PYTHONUNBUFFERED=1
Environment=VOX2AI_SERVICE=1

[Install]
WantedBy=default.target
SERVICEEOF

systemctl --user daemon-reload
systemctl --user enable vox2ai.service
systemctl --user start vox2ai.service

echo ""
echo "[vox2ai] Service installed and started."
echo "[vox2ai] Status: systemctl --user status vox2ai.service --no-pager"
echo "[vox2ai] Logs: journalctl --user -u vox2ai.service -f"
