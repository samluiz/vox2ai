import os
from pathlib import Path

from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from vox2ai.config import AppConfig, config_path, load_config
from vox2ai.errors import ConfigError, Vox2AIError


def run_doctor() -> None:
    console = _get_console()

    console.print(Panel("[bold]vox2ai doctor[/bold]", title="Diagnostics"))

    # 1. Config path
    path = config_path()
    exists = path.exists()
    _check("Config path", True, str(path))

    # 2. Config parse
    config = None
    config_ok = True
    if not exists:
        _check("Config file", False, "Not found (run 'vox2ai init')")
        config_ok = False
    else:
        try:
            config = load_config()
            _check("Config file", True, "Valid TOML, parsed successfully")
        except ConfigError as e:
            _check("Config file", False, str(e))
            config_ok = False

    # 3. API key env var
    if config_ok and config is not None:
        key_env = config.assistant.api_key_env
        key_value = os.environ.get(key_env)
        if key_value:
            _check(f"API key ({key_env})", True, f"Set (${key_env})")
        else:
            _check(f"API key ({key_env})", False, f"Not set (${key_env} is empty or missing)")
    else:
        _check("API key", False, "Skipped (config not available)")

    # 4. Audio devices
    _check_audio_devices()

    # 5. LLM health check
    if config_ok and config is not None:
        key_env = config.assistant.api_key_env
        key_value = os.environ.get(key_env)
        if key_value:
            _check_llm(config)

    # 6. Whisper model and language settings
    if config_ok and config is not None:
        voice = config.voice
        _check("STT model", True, f"faster-whisper: {voice.whisper_model}")
        _check("Language mode", True, voice.language_mode)
        _check("Primary language", True, voice.primary_language)
        if voice.language_mode == "constrained-auto":
            if voice.allowed_languages:
                allowed_str = ", ".join(voice.allowed_languages)
            else:
                allowed_str = f"{voice.primary_language} (effective default from primary language)"
            _check("Allowed languages", True, allowed_str)
            _check("Min language probability", True, str(voice.min_language_probability))
        _check("Initial prompt", True, "enabled" if voice.initial_prompt_enabled else "disabled")

    # 7. Dynamic vocabulary
    if config_ok and config is not None:
        vocab_enabled = config.transcription.context.enabled
        _check(
            "Dynamic vocabulary", bool(vocab_enabled), "enabled" if vocab_enabled else "disabled"
        )

    # 8. Transcript refiner
    if config_ok and config is not None:
        refine = config.transcription.refine
        _check(
            "Transcript refiner",
            bool(refine),
            f"{'enabled' if refine else 'disabled'} (mode={config.transcription.refine_mode})",
        )

    # 9. Activation backend
    if config_ok and config is not None:
        act = config.activation
        _check("Activation backend", True, f"{act.backend} (key={act.key})")  # noqa: E501
        if act.backend == "evdev":
            _check_evdev()
        else:
            _check("Global key capture", True, "disabled by default (backend=window)")

    # 10. Performance
    if config_ok and config is not None:
        perf = config.performance
        _check(
            "Performance",
            True,
            f"preload_whisper={perf.preload_whisper}, max_workers={perf.max_workers}",
        )

    # 11. WebSocket port
    if config_ok and config is not None:
        _check("WebSocket server", True, f"{config.desktop.host}:{config.desktop.port}")

    # 12. Logging path
    _check("Log directory", True, str(_log_dir()))

    # 13. Sidecar binary (production build)
    _check_sidecar_binary()

    # 14. Desktop frontend (Tauri)
    _check_desktop_frontend()

    # Summary table
    table = Table.grid(padding=(0, 1))
    table.add_row("[bold]Config path[/bold]", str(path))
    if config:
        table.add_row("[bold]Provider[/bold]", config.assistant.provider)
        table.add_row("[bold]Model[/bold]", config.assistant.model)
        table.add_row("[bold]Whisper model[/bold]", config.voice.whisper_model)
        table.add_row("[bold]Language mode[/bold]", config.voice.language_mode)
        table.add_row("[bold]Primary language[/bold]", config.voice.primary_language)
        table.add_row(
            "[bold]Vocabulary[/bold]",
            "dynamic" if config.transcription.context.enabled else "disabled",
        )
        table.add_row(
            "[bold]Transcript refiner[/bold]",
            f"{'on' if config.transcription.refine else 'off'} ({config.transcription.refine_mode})",  # noqa: E501
        )
        table.add_row("[bold]Desktop UI[/bold]", "Tauri")
        table.add_row("[bold]Activation[/bold]", config.activation.backend)
        table.add_row("[bold]Command mode[/bold]", config.commands.mode)
        table.add_row("[bold]Preload Whisper[/bold]", str(config.performance.preload_whisper))
    console.print()
    console.print(Panel(table, title="Configuration Summary"))


def _get_console() -> Console:
    return Console()


def _check(label: str, ok: bool, detail: str = "") -> None:
    icon = "[green]✓[/green]" if ok else "[red]✗[/red]"
    if detail:
        _get_console().print(f"  {icon} {label}: {detail}")
    else:
        _get_console().print(f"  {icon} {label}")


def _log_dir() -> Path:
    from platformdirs import user_state_dir

    return Path(user_state_dir("vox2ai", ensure_exists=True))


def _check_sidecar_binary() -> None:
    sidecar_dir = (
        Path(__file__).resolve().parent.parent.parent / "desktop" / "src-tauri" / "binaries"
    )
    if sidecar_dir.is_dir():
        binaries = list(sidecar_dir.glob("vox2ai-server*"))
        if binaries:
            _check("Sidecar binary", True, binaries[0].name)
        else:
            _check("Sidecar binary", False, "Not found (run python scripts/build_sidecar.py)")
    else:
        _check("Sidecar binary", True, "N/A (source not available)")


def _check_audio_devices() -> None:
    import sounddevice as sd

    try:
        devices = sd.query_devices()
        inputs = [d for d in devices if d["max_input_channels"] > 0]
        if not inputs:
            _check("Audio input devices", False, "No input devices found")
            return
        default_input = sd.default.device[0]
        if default_input is None or default_input < 0:
            _check("Audio input devices", False, "No default input device")
            return
        device_info = sd.query_devices(default_input)
        _check(
            "Audio input devices",
            True,
            f"Default: '{device_info['name']}' "
            f"({device_info['max_input_channels']} ch, "
            f"{int(device_info['default_samplerate'])} Hz)",
        )
    except Exception as e:
        _check("Audio input devices", False, str(e))


def _check_llm(config: AppConfig) -> None:
    from vox2ai.llm import LLMClient

    try:
        client = LLMClient(config.assistant)
        client.complete("Reply with one word.", "Say ok")
        _check("LLM connectivity", True, "Responded to health check")
    except Vox2AIError as e:
        _check("LLM connectivity", False, str(e))
    except Exception as e:
        _check("LLM connectivity", False, f"Unexpected error: {e}")


def _check_evdev() -> None:
    try:
        import evdev  # noqa: F401

        devices = []
        for path in evdev.list_devices():
            try:
                dev = evdev.InputDevice(path)
                dev.close()
                devices.append(path)
            except (PermissionError, OSError):
                continue
        if devices:
            _check("Global key capture (evdev)", True, f"{len(devices)} input device(s) readable")
        else:
            _check(
                "Global key capture (evdev)",
                False,
                "No readable input devices. Try: sudo usermod -a -G input $USER",
            )
    except ImportError:
        _check("Global key capture (evdev)", True, "not configured (backend=window)")
    except Exception as e:
        _check("Global key capture (evdev)", True, str(e))


def _check_desktop_frontend() -> None:
    desktop_dir = Path(__file__).resolve().parent.parent.parent / "desktop"
    if desktop_dir.is_dir() and (desktop_dir / "package.json").is_file():
        _check("Desktop frontend (Tauri)", True, str(desktop_dir))
        try:
            import subprocess

            subprocess.run(["node", "--version"], capture_output=True, timeout=5)
            _check("Node.js", True, "available")
        except (FileNotFoundError, Exception):
            _check("Node.js", False, "not found (needed for Tauri frontend)")
        try:
            subprocess.run(["npm", "--version"], capture_output=True, timeout=5)
            _check("npm", True, "available")
        except (FileNotFoundError, Exception):
            _check("npm", False, "not found (needed for Tauri dev)")
        try:
            subprocess.run(["cargo", "--version"], capture_output=True, timeout=10)
            _check("Rust/Cargo", True, "available")
        except (FileNotFoundError, Exception):
            _check("Rust/Cargo", False, "not found (needed to build Tauri app)")
    else:
        _check("Desktop frontend (Tauri)", False, "Not found at desktop/")
