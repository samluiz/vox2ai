# AGENTS.md — vox2ai

Compact repo guide for OpenCode sessions.

## Project shape

- Python package lives in `src/vox2ai/`; CLI entry point is `vox2ai` → `vox2ai.cli:cli`.
- Requires **Python >= 3.11**.
- There are **two desktop frontends**:
  - **PySide6/Qt overlay** (`vox2ai` or `vox2ai overlay`) — default, push-to-talk floating window.
  - **Tauri/React desktop app** (`vox2ai desktop`) — launches the Python WebSocket backend **and** `npm run tauri dev` from `desktop/`.
- The Tauri frontend talks to the Python backend over WebSocket (default `ws://127.0.0.1:8765`). `vox2ai server` starts only the backend.
- One-shot CLI modes: `vox2ai ask` (transcribe + LLM), `vox2ai dict` (transcribe only), `vox2ai tui` (Textual TUI).

## Setup

```bash
pip install -e ".[dev]"
```

Optional global-hotkey support (Linux evdev): install with `pip install -e ".[dev,evdev]"`.

## Verification

```bash
ruff check .
ruff format --check .
mypy src
pytest
```

- `ruff` target is **py311**, line length **100**, double quotes.
- `mypy` runs in **strict** mode but explicitly excludes `tests/`.
- `pytest` uses `pythonpath = ["src"]` and `asyncio_mode = "auto"`.

## Running locally

```bash
vox2ai init                 # create ~/.config/vox2ai/config.toml
export OPENAI_API_KEY=...   # or whatever api_key_env points to
vox2ai doctor               # sanity-check dependencies
vox2ai                      # default Qt overlay
vox2ai tui                  # terminal fallback
```

Tauri/React dev loop:

```bash
cd desktop && npm install && npm run tauri dev   # launches Vite on port 1420
# in another terminal:
vox2ai server
```

## Config notes

- Config path: `~/.config/vox2ai/config.toml` (respects `XDG_CONFIG_HOME`).
- Default activation backend is `"window"`, **not** `"evdev"`. `evdev` gives global push-to-talk but requires the optional dependency and appropriate permissions.
- Tests isolate config via `monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))`.

## Architecture gotchas

- **Two overlay codebases**: `src/vox2ai/desktop_app.py` (Qt) and `desktop/src-tauri/` + `desktop/src/` (Tauri). They share the same pipeline code (`stt`, `llm`, `agent`, `commands`) but have separate UI state machines.
- `vox2ai desktop` spawns `npm run tauri dev` in a daemon thread and then runs `run_server()`; it does not build a release binary.
- Command execution uses `subprocess.run(..., shell=True)`. The permission model is in `src/vox2ai/commands.py`: blocked patterns always block, and `ask-before-run` requires approval for non-blocked commands.
- The LLM agent returns a small JSON decision object (`answer` | `clarification` | `command`); `src/vox2ai/agent.py` strips markdown fences and falls back to treating the response as a plain answer if parsing fails.

## What to avoid changing casually

- Do not rename `src/vox2ai/__main__.py` or move the CLI entry point without updating `[project.scripts]` in `pyproject.toml`.
- Do not widen mypy strictness or ruff line length without a dedicated PR — both are intentionally configured.
