# vox2ai

**vox2ai** is a GNOME-native Linux voice/text AI assistant for Fedora/GNOME/Wayland.

Architecture:

- GNOME Shell extension UI
- local Python WebSocket backend (`ws://127.0.0.1:8765`)
- `systemd --user` backend lifecycle
- modular agent with tool execution, wake word detection, chat sessions

Tauri/React code has been removed. GNOME Shell extension is the only desktop frontend.

## What Works

- Type a prompt from the GNOME popup.
- Record a voice prompt with `Ctrl+Space` or tap the red dot.
- Auto-stop voice recording after speech ends.
- Show a real microphone level waveform while recording.
- Calibrate microphone sensitivity in Preferences.
- Keep optional current-session conversation context with chat message history.
- Ask about the current screen using a vision-capable model or OCR fallback.
- Approve shell commands before they run.
- Wake word ("hey jarvis") triggers recording hands-free.
- Goal mode: describe a multi-step objective, agent executes autonomously with tools.
- Chat sessions: multi-turn conversations with session management and scrollable history.

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
- Press `Ctrl+Space` or tap the red dot to start recording.
- Press `Ctrl+Space` again to stop manually, or stop speaking and let auto-stop send it.
- Use Preferences -> Voice -> Test microphone to calibrate sensitivity.
- Enable Conversation mode when you want follow-up questions to use recent context.
- Use the camera button to capture and ask about the visible screen.
- Switch between Ask, Goal, and Chat modes from the mode selector (top-left).
- Goal mode: type a task ("organize my downloads folder"), agent plans and runs tools.
- Chat sessions: multi-turn history with scrollback and session switching.

## Wake Word

Enable wake word detection in Preferences:

```toml
[wake_word]
enabled = true
model = "hey_jarvis"
threshold = 0.5
activation_sound = true
```

When the wake word is spoken, vox2ai opens the popup and starts recording. Wake listening pauses during recording and resumes afterward.

## Goal Mode

Goal mode lets you describe a multi-step objective. The agent:

1. Generates a plan using the LLM.
2. Executes tools (shell commands, file ops, git, clipboard, system info).
3. Reports progress and tool results.
4. Asks for confirmation before running potentially destructive commands.
5. Returns a final answer.

Tool safety rules still apply — blocked commands are always rejected, high-risk commands require approval.

## Ask About Screen

Ask about screen uses this order:

1. Capture a screenshot after explicit user action (camera button).
2. If the active model is marked vision-capable, send the screenshot to that model.
3. Otherwise, run OCR with `tesseract` and send the extracted text to the text model.

Install OCR support on Fedora:

```bash
sudo dnf install tesseract
```

Screenshots are temporary by default and are deleted after the request. Debug screenshot saving is available only under Preferences -> Advanced.

## Preferences

The GNOME preferences window:

- **General**: backend autostart, shortcut behavior, conversation mode, notifications.
- **Voice**: input device, live microphone test, auto-stop, silence duration, sensitivity, language, Whisper model.
- **Wake Word**: enable/disable, model selection, threshold, activation sound.
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
9. Wake word detection triggers recording.
10. Goal mode plans and executes a multi-step task.
11. Chat sessions scroll and switch correctly.

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

## Backend Architecture

```
src/vox2ai/
  agent/          Goal-oriented autonomous agent (loop, planner, executor, sanitizer, tool registry, working memory)
  commands.py     Shell command safety rules (blocked patterns, ask-before-run approval)
  config.py        Pydantic config model with WakeWordConfig, RecordingConfig, etc.
  context/        Context aggregation (screen, clipboard, files, vocabulary)
  desktop_protocol.py  WebSocket wire types (events, commands, parsing)
  desktop_server.py    Async WebSocket controller (recording, STT, LLM, wake, goal)
  llm.py          OpenAI-compatible LLM client
  prompts/        LLM prompt architecture (system, developer, planner, tool result)
  providers.py    LLM provider adapters (OpenAI, Groq, OpenRouter, etc.)
  recorder.py     Streaming microphone recorder with VAD
  stt/            Speech-to-text backends (Whisper, etc.)
  tools/          Agent tools (clipboard, filesystem, git, run_command, system)
  wake/           Wake word detection (porcupine listener, detector, manager)
```
