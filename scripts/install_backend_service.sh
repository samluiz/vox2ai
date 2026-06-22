#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

SERVICE_SRC="${REPO_DIR}/packaging/systemd-user/vox2ai.service"
SERVICE_DST="${HOME}/.config/systemd/user/vox2ai.service"

echo "[vox2ai] Installing systemd user service..."

mkdir -p "$(dirname "${SERVICE_DST}")"
cp "${SERVICE_SRC}" "${SERVICE_DST}"

# Update ExecStart to use the repo's vox2ai binary
PYTHON=$(command -v python3)
SERVICE_BIN="${SCRIPT_DIR}/../bin/vox2ai-server"

# Try to find the right path
if [ -x "${REPO_DIR}/.venv/bin/vox2ai" ]; then
  VOX2AI="${REPO_DIR}/.venv/bin/vox2ai"
elif command -v vox2ai &>/dev/null; then
  VOX2AI=$(command -v vox2ai)
else
  VOX2AI="${PYTHON} -m vox2ai"
fi

# Write updated service file
cat > "${SERVICE_DST}" << EOF
[Unit]
Description=vox2ai backend service
After=graphical-session.target
PartOf=graphical-session.target

[Service]
Type=simple
ExecStart=${VOX2AI} server --host 127.0.0.1 --port 8765
Restart=on-failure
RestartSec=2
Environment=VOX2AI_SERVICE=1

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable vox2ai.service
systemctl --user start vox2ai.service

echo "[vox2ai] Service installed and started."
echo "[vox2ai] Status: systemctl --user status vox2ai.service"
echo "[vox2ai] Logs: journalctl --user -u vox2ai.service -f"
