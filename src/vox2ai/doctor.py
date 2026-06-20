import os

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
            _check(
                f"API key ({key_env})",
                False,
                f"Not set (${key_env} is empty or missing)",
            )
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

    table = Table.grid(padding=(0, 1))
    table.add_row("[bold]Config path[/bold]", str(path))
    table.add_row("[bold]Provider[/bold]", config.assistant.provider if config else "N/A")
    table.add_row("[bold]Base URL[/bold]", config.assistant.base_url if config else "N/A")
    table.add_row("[bold]Model[/bold]", config.assistant.model if config else "N/A")
    table.add_row("[bold]Whisper model[/bold]", config.voice.whisper_model if config else "N/A")
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
