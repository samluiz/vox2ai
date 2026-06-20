# vox2ai

**vox2ai** is a terminal-first Linux voice assistant MVP.

Record your voice, get a transcription, and optionally ask an OpenAI-compatible LLM for an answer — all from the command line.

## MVP scope

- Voice recording via default microphone
- Speech-to-text via [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (local, runs on CPU)
- LLM query via any OpenAI-compatible API (OpenAI, OpenRouter, LM Studio, etc.)
- Diagnostics (`vox2ai doctor`)
- Minimal TUI (`vox2ai`)

## Installation

```bash
pip install -e ".[dev]"
```

Requires **Python >= 3.11** and a working audio input device.

## Configuration

Config file: `~/.config/vox2ai/config.toml`

```bash
vox2ai init          # create default config
vox2ai config-path   # print config path
vox2ai init --force  # overwrite existing config
```

### OpenAI-compatible providers

**OpenAI** (default):
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

## Usage

| Command | Description |
|---------|-------------|
| `vox2ai` | Open minimal TUI |
| `vox2ai init` | Create default config |
| `vox2ai doctor` | Validate setup |
| `vox2ai ask` | Record → transcribe → LLM answer |
| `vox2ai dict` | Record → transcribe only |
| `vox2ai config-path` | Print config path |

For `ask` and `dict`:

1. Press Enter to start recording.
2. Speak into your microphone.
3. Press Enter again to stop.
4. Wait for transcription (and optionally the LLM answer).

## Audio troubleshooting (Fedora / Linux)

Install PortAudio and related packages:

```bash
sudo dnf install portaudio-devel pulseaudio-libs-devel
```

Check your default input device:

```bash
python3 -c "import sounddevice; print(sounddevice.default.device)"
```

List available input devices:

```bash
python3 -c "import sounddevice; print(sounddevice.query_devices())"
```

## Limitations

- **Command execution is not implemented** in this MVP. The assistant only returns text.
- Microphone is required. There is no text-input fallback yet.
- Whisper model download (~1–2 GB for "base") happens on first transcription.

## Development

```bash
ruff check .
ruff format --check .
mypy src
pytest
```
