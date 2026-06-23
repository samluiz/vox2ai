# vox2ai

**vox2ai** is a GNOME-native Linux voice/text AI assistant for Fedora/GNOME/Wayland.

The active desktop architecture is:

- GNOME Shell extension UI
- local Python backend service
- `systemd --user` backend lifecycle
- local WebSocket connection at `127.0.0.1:8765`

Tauri/React code may still exist in the repository as legacy/experimental code, but it is not the active desktop product path.

## What Works

- Type a prompt from the GNOME popup.
- Record a voice prompt with `Ctrl+Space`.
- Auto-stop voice recording after speech ends.
- Show a real microphone level waveform while recording.
- Calibrate microphone sensitivity in Preferences.
- Keep optional current-session conversation context.
- Ask about the current screen using a vision-capable model or OCR fallback.
- Approve shell commands before they run.

vox2ai does not record continuously. Microphone and screen capture are only used after an explicit user action.

## Install From Source

```bash
pip install -e ".[dev]"
vox2ai init
```

Configure your provider in:

```text
~/.config/vox2ai/config.toml
```

For OpenAI-compatible providers, set either an environment variable or the config-file API key:

```toml
[assistant]
provider = "openai-compatible"
base_url = "https://api.openai.com/v1"
api_key_env = "OPENAI_API_KEY"
model = "gpt-4.1-mini"
```

Then install the backend service and GNOME extension:

```bash
scripts/install_backend_service.sh
scripts/install_gnome_extension.sh
systemctl --user restart vox2ai.service
```

On GNOME Wayland, log out and back in after installing or changing extension JavaScript.

## Daily Use

Open the GNOME panel indicator.

- Type a prompt and press Enter.
- Press `Ctrl+Space` to start recording.
- Press `Ctrl+Space` again to stop manually, or stop speaking and let auto-stop send it.
- Use Preferences -> Voice -> Test microphone to calibrate sensitivity.
- Enable Conversation mode when you want follow-up questions to use recent context.
- Use Ask about screen only when you explicitly want vox2ai to capture the visible screen.

## Ask About Screen

Ask about screen uses this order:

1. Capture a screenshot after explicit user action.
2. If the active model is marked vision-capable, send the screenshot to that model.
3. Otherwise, run OCR with `tesseract` and send the extracted text to the text model.

Install OCR support on Fedora:

```bash
sudo dnf install tesseract
```

Screenshots are temporary by default and are deleted after the request. Debug screenshot saving is available only under Preferences -> Advanced.

## Preferences

The GNOME preferences window is intentionally small:

- **General**: backend autostart, shortcut behavior, conversation mode, notifications.
- **Voice**: input device, live microphone test, auto-stop, silence duration, sensitivity, language, Whisper model.
- **Screen**: Ask about screen availability, OCR/vision status, test capture, optional screen shortcut.
- **AI**: provider, base URL, model, API key status, test connection, open config.
- **Diagnostics**: backend capabilities and last errors.
- **Advanced**: safe mode, endpoint, debug screenshot saving, logs/config shortcuts, reset settings.

Unavailable features are hidden from the popup and explained in Diagnostics.

## Commands

vox2ai can propose shell commands. Commands never run automatically.

The active GNOME UI supports:

- Copy command
- Explain command
- Run after approval

Blocked or high-risk commands still require explicit approval and remain subject to backend safety rules.

## Troubleshooting

Check service status:

```bash
systemctl --user status vox2ai.service --no-pager
```

Restart the backend:

```bash
systemctl --user restart vox2ai.service
```

Backend logs:

```bash
journalctl --user -u vox2ai.service -f
```

GNOME extension logs:

```bash
journalctl --user -b --since "10 minutes ago" -o cat \
  | grep -iE "vox2ai|gjs|extension|error|exception|typeerror|referenceerror|schema"
```

Common issues:

- **No microphone levels**: choose another input device in Preferences -> Voice and run Test microphone.
- **Audio too quiet**: lower Sensitivity threshold or choose the correct input device.
- **Ask about screen unavailable**: turn Safe mode off, then use a vision-capable model or install `tesseract` for OCR fallback. Backend-only fallback capture can also use `gnome-screenshot`.
- **Provider missing**: open config from Preferences -> AI and set provider/model/API key.

## Validation Checklist

```bash
ruff check .
ruff format --check .
mypy src
pytest
```

Manual GNOME validation:

```bash
scripts/install_backend_service.sh
scripts/install_gnome_extension.sh
systemctl --user restart vox2ai.service
gnome-extensions disable vox2ai@samluiz.com || true
gnome-extensions enable vox2ai@samluiz.com
gnome-extensions info vox2ai@samluiz.com
```

Expected:

```text
Enabled: Yes
State: ACTIVE
```

Then test:

1. Type prompt -> answer.
2. Voice prompt -> real waveform -> auto-stop -> answer.
3. Preferences -> Voice -> Test microphone.
4. Conversation mode memory test.
5. New Conversation clears memory.
6. Ask about screen through vision or OCR.
7. `Ctrl+Space` starts/stops recording.
8. Diagnostics accurately reports unavailable features.

## CLI

The Python CLI remains available:

| Command | Description |
|---------|-------------|
| `vox2ai server` | Start the local WebSocket backend |
| `vox2ai tui` | Terminal UI fallback |
| `vox2ai ask` | Record -> transcribe -> LLM answer |
| `vox2ai dict` | Record -> transcribe only |
| `vox2ai doctor` | Validate local setup |
| `vox2ai config-path` | Print config path |

## Configuration

Config path:

```text
~/.config/vox2ai/config.toml
```

A commented reference with every active key is available at:

```text
examples/config.example.yaml
```

It is YAML for readability; use it as a guide when editing the TOML config file.

Create or overwrite defaults:

```bash
vox2ai init
vox2ai init --force
```
