# vox2ai

**vox2ai** is a Linux desktop/terminal voice assistant.

Speak, get a transcription, optionally get an AI answer or execute approved shell
commands — all from a floating desktop overlay or terminal.

## MVP scope

- Desktop overlay push-to-talk assistant (`vox2ai`)
- Terminal TUI fallback (`vox2ai tui`)
- CLI one-shot commands (`vox2ai ask`, `vox2ai dict`)
- Speech-to-text via [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (local, CPU)
- LLM query via any OpenAI-compatible API (OpenAI, OpenRouter, OpenCode Zen, LM Studio…)
- Optional command execution with permission control
- Diagnostics (`vox2ai doctor`)

## Download

Installable Linux builds are published on the
[GitHub Releases](https://github.com/samluiz/vox2ai/releases) page.

Download one of:

- `vox2ai-*.AppImage` for portable Linux use
- `vox2ai-*.deb` for Debian/Ubuntu
- `vox2ai-*.rpm` for Fedora/RHEL/openSUSE-style systems

The packaged desktop app includes the Tauri UI and the Python backend sidecar.
Users do not need Node, Rust, Python, or a terminal for normal use.

## Install on Linux

AppImage:

```bash
chmod +x vox2ai-*.AppImage
./vox2ai-*.AppImage
```

RPM:

```bash
sudo dnf install ./vox2ai-*.rpm
```

DEB:

```bash
sudo apt install ./vox2ai-*.deb
```

After launch, vox2ai runs as a tray/background utility. Open Settings from the
tray to configure provider, model, voice controls, startup behavior, and the
global activation shortcut.

## Run at startup

Open **Settings → Activation & Background** and enable:

- **Run in background**: closing the widget keeps vox2ai available in the tray.
- **Start hidden**: launches directly into tray/background after setup.
- **Start at login**: registers vox2ai with Linux/XDG autostart.

Start-at-login currently targets Linux/XDG desktop environments. Unsupported
platforms are shown as disabled in Settings rather than silently pretending to
work.

## Global shortcut

The default global activation shortcut is:

```text
Ctrl+Space
```

Configure it in **Settings → Activation & Background**. Supported behaviors:

| Behavior | Result |
|----------|--------|
| Show widget | Shows and focuses vox2ai |
| Show and focus input | Shows vox2ai and focuses the prompt field |
| Show and start recording | Shows vox2ai and starts recording |
| Toggle widget | Shows if hidden, hides if visible |

This is separate from the in-window recording shortcut and works while another
app is focused, subject to desktop-environment shortcut restrictions.

## Troubleshooting

Use **Open Diagnostics** from the tray or Settings to inspect backend, provider,
microphone, shortcut, and paths.

Common checks:

- **Backend failed to start**: open Diagnostics, then use **Restart backend**.
- **Global shortcut failed to register**: choose a different shortcut; desktop
  environments may reserve some combinations.
- **Tray icon missing**: check your desktop environment’s tray/appindicator
  support.
- **Microphone unavailable**: verify the input device in your OS sound settings.
- **Logs path**: Diagnostics shows the current logs folder. Sidecar logs are
  written under the platform app log directory.
- **Clean restart**: use tray **Quit vox2ai**, then launch the app again.

vox2ai never records silently: microphone capture starts only from an explicit
shortcut/action, recording state is visible, and Esc/Cancel stops active capture.

## Build from source

```bash
pip install -e ".[dev]"
```

Requires **Python >= 3.11**, a working audio input device, and a display server
(X11 or Wayland).

Linux desktop packaging also needs the Tauri/WebKit/AppIndicator development
libraries. On Fedora, install the equivalent of:

```bash
sudo dnf install webkit2gtk4.1-devel gtk3-devel libappindicator-gtk3-devel librsvg2-devel rpm-build
```

### Quick start

```bash
vox2ai init
export OPENAI_API_KEY="sk-..."
vox2ai doctor     # verify setup
vox2ai            # start desktop overlay
```

### Usage

| Command | Description |
|---------|-------------|
| `vox2ai` | Launch Tauri desktop app (default) |
| `vox2ai desktop` | Same as above |
| `vox2ai server` | Start WebSocket backend server only |
| `vox2ai tui` | Minimal terminal TUI |
| `vox2ai init` | Create default config |
| `vox2ai doctor` | Validate setup |
| `vox2ai ask` | Record → transcribe → LLM answer |
| `vox2ai dict` | Record → transcribe only |
| `vox2ai config-path` | Print config path |

### Typed input

Click the input box, type a prompt, press Enter. Typed prompts use the same
AI and command execution flow as voice prompts.

### Desktop app (Tauri)

1. Run `vox2ai` (or `vox2ai desktop`) — launches the Python WebSocket backend
   and the Tauri desktop frontend.
2. **Hold** the configured push-to-talk key (default: Right Ctrl) to speak,
   or type your prompt into the input box.
3. Release the key (or press Enter) to see the AI response.
4. If a command is requested, press Y to approve or N to deny.

The Tauri frontend connects to the Python backend at `ws://127.0.0.1:8765`.
Run `vox2ai server` to start only the backend without the frontend.

Configurable in `~/.config/vox2ai/config.toml`:

```toml
[activation]
mode = "push-to-talk"
backend = "window"
key = "KEY_RIGHTCTRL"
fallback_key = "KEY_RIGHTCTRL"
```

### Command execution

The assistant can propose shell commands. Permission model:

| Mode | Behaviour |
|------|-----------|
| `disabled` | Commands are never executed |
| `ask-before-run` (default) | User must approve each command |
| `allow-all` | Non-blocked commands run without approval |

Blocked patterns are never executed, even in `allow-all`.

```toml
[commands]
mode = "ask-before-run"
blocked_patterns = ["rm ", "sudo ", "shutdown", …]
```

### One-shot CLI

```bash
vox2ai ask
```

1. Press Enter to start recording.
2. Speak into your microphone.
3. Press Enter to stop.
4. Wait for transcription and LLM answer.

### OpenAI-compatible providers

**OpenCode Zen (free)**:
```toml
[assistant]
base_url = "https://opencode.ai/zen/v1"
api_key_env = "OPENCODE_ZEN_API_KEY"
model = "deepseek-v4-flash-free"
```

**OpenAI**:
```toml
[assistant]
base_url = "https://api.openai.com/v1"
api_key_env = "OPENAI_API_KEY"
model = "gpt-4.1-mini"
```

**OpenRouter**:
```toml
[assistant]
base_url = "https://openrouter.ai/api/v1"
api_key_env = "OPENROUTER_API_KEY"
model = "openai/gpt-4o-mini"
```

**LM Studio (local)**:
```toml
[assistant]
base_url = "http://localhost:1234/v1"
api_key_env = "OPENAI_API_KEY"
model = "local-model"
```

## Configuration

Config file: `~/.config/vox2ai/config.toml`

```bash
vox2ai init          # create default config
vox2ai config-path   # print path
vox2ai init --force  # overwrite
```

## Local partial transcription

`vox2ai` can show a best-effort partial transcript while you are still
speaking. This is local and does not use a paid realtime transcription
provider. The final prompt sent to the AI still comes from the final full
transcription after you release push-to-talk.

```toml
[transcription]
mode = "local-partial"
show_partial = true

[transcription.partial]
enabled = true
interval_ms = 1600
window_seconds = 6.0
```

Tradeoffs:

- More responsive UI.
- Higher CPU usage while recording.
- Partial transcript may change or be imperfect.
- Final transcript is still authoritative.

To disable partial transcription and keep only the final transcript:

```toml
[transcription]
mode = "final"
```

## Standalone desktop app

The Tauri desktop app bundles the Python backend as a sidecar binary.
When you open the app, Tauri starts the backend automatically — no
separate terminal or manual `vox2ai server` needed.

### Architecture

```text
Tauri app
  ├── frontend UI (React + Vite)
  ├── sidecar: vox2ai-server (Python, bundled via PyInstaller)
  └── local WebSocket connection to sidecar
```

The sidecar binds to `127.0.0.1` on a random free port and prints a
JSON `server_ready` event to stdout. Tauri reads this event and
passes the dynamic URL to the frontend.

### Development run

```bash
# Terminal 1: start the backend
vox2ai server --host 127.0.0.1 --port 8765

# Terminal 2: start the Tauri frontend in dev mode
cd desktop
npm run tauri dev
```

### Build the desktop app

```bash
python scripts/build_desktop_release.py
```

The bundled app is written to `desktop/src-tauri/target/release/bundle/`.

## Release process

Validate versions before tagging:

```bash
python scripts/check_versions.py
```

Create a release:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The GitHub Actions release workflow builds the Python sidecar, bundles the
Tauri app, creates a GitHub Release, and uploads AppImage, DEB, and RPM
artifacts. The workflow can also be run manually from GitHub Actions.

### Production behavior

- Opening the app starts the backend automatically.
- The backend binds to a random localhost port (no port conflicts).
- Closing the app terminates the backend.
- Logs are written to `~/.local/state/vox2ai/vox2ai.log` (Linux).

## Language control

Prevent Whisper from mis-detecting the language of short or noisy audio.

```toml
[voice]
language_mode = "auto"
primary_language = "en"
allowed_languages = []
min_language_probability = 0.55
```

### Modes

| Mode | Behavior |
|------|----------|
| `auto` | Free language detection (current default, flexible but may mis-detect). |
| `force` | Always transcribe using `primary_language`. Most stable for single-language users. |
| `constrained-auto` | Auto-detect language first, but only accept configured languages. Falls back to `primary_language` when detection is unreliable. |

### Recommended configs

**Single-language user** (e.g. Portuguese):

```toml
[voice]
language_mode = "force"
primary_language = "pt"
```

**Multilingual user** (e.g. Portuguese and English):

```toml
[voice]
language_mode = "constrained-auto"
primary_language = "pt"
allowed_languages = ["pt", "en"]
min_language_probability = 0.55
```

**Fully automatic** (default):

```toml
[voice]
language_mode = "auto"
```

Backward compatibility: old configs using `language = "pt"` are automatically
migrated to `language_mode = "force"` with the appropriate `primary_language`.
Config files are not rewritten automatically.

## Known limitations

- **Wayland** may restrict global always-on-top and global key capture. The
  widget falls back to window-focused push-to-talk.
- **Command execution** is a best-effort MVP feature. The shell runs approved
  commands as the current user. Review proposed commands before approving.
- **Whisper model download** (~1–2 GB for "base") happens on first transcription.
- **TTS** (spoken AI response) is not implemented in this phase.

## Legacy PySide6/Qt overlay removed

The legacy PySide6/Qt overlay has been removed. The only desktop UI is the
Tauri frontend. If you have PySide6 installed, you may remove it — it is
no longer required by vox2ai. The default `vox2ai` command now launches the
Tauri desktop app (Python WebSocket backend + Tauri frontend).

## Audio troubleshooting (Fedora / Linux)

```bash
sudo dnf install portaudio-devel pulseaudio-libs-devel
python3 -c "import sounddevice; print(sounddevice.default.device)"
python3 -c "import sounddevice; print(sounddevice.query_devices())"
```

## Development

```bash
pip install -e ".[dev]"
ruff check .
ruff format --check .
mypy src
pytest
cd desktop
npm install
npm run tauri dev
```
