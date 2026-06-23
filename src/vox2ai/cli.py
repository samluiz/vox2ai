import json

import click

from vox2ai.audio_input import list_input_devices, test_input_device
from vox2ai.config import config_path, ensure_config, load_config, save_config
from vox2ai.doctor import run_doctor
from vox2ai.errors import Vox2AIError
from vox2ai.runner import run_one_shot_assistant, run_one_shot_dictation
from vox2ai.tui import Vox2aiApp


@click.group(invoke_without_command=True)
@click.pass_context
def cli(ctx: click.Context) -> None:
    """vox2ai — voice and text AI assistant for GNOME/Linux.

    Default: launch the terminal TUI.
    Use 'vox2ai server' for the WebSocket backend (used by the GNOME extension).
    """
    if ctx.invoked_subcommand is None:
        _run_tui()


def _run_tui() -> None:
    """Launch the terminal TUI (zero-dependency default)."""
    app = Vox2aiApp()
    app.run()


@cli.command()
@click.option("--force", is_flag=True, help="Overwrite existing config.")
def init(force: bool) -> None:
    """Create default configuration file."""
    path = ensure_config(force=force)
    click.echo(f"Config created at {path}")


@cli.command()
def doctor() -> None:
    """Validate configuration and system dependencies."""
    run_doctor()


@cli.command()
def ask() -> None:
    """Record voice, transcribe, and get an LLM answer."""
    run_one_shot_assistant()


@cli.command()
def dict() -> None:
    """Record voice and print transcription only."""
    run_one_shot_dictation()


@cli.command()
def tui() -> None:
    """Open the minimal terminal TUI."""
    _run_tui()


@cli.command()
@click.option("--host", default=None, help="Bind address (default: 127.0.0.1)")
@click.option("--port", type=int, default=None, help="Port number (0 = random free port)")
def server(host: str | None, port: int | None) -> None:
    """Start the WebSocket backend server for the GNOME Shell extension."""
    import sys

    from vox2ai.config import config_path

    print(
        f"[vox2ai] version=dev executable={sys.argv[0]} config_path={config_path()}",
        flush=True,
    )
    from vox2ai.desktop_server import run_server

    run_server(host=host, port=port)


@cli.command(name="audio-devices")
@click.option("--json-output", "--json", "as_json", is_flag=True, help="Print JSON output.")
def audio_devices(as_json: bool) -> None:
    """List available microphone input devices."""
    config = load_config()
    devices = list_input_devices()
    payload = {
        "selected": config.voice.input_device,
        "sample_rate": config.voice.sample_rate,
        "devices": devices,
    }
    if as_json:
        click.echo(json.dumps(payload))
        return

    selected = config.voice.input_device or "auto"
    click.echo(f"Selected: {selected}")
    click.echo("auto\tAutomatic")
    for device in devices:
        marker = "*" if device["id"] == config.voice.input_device else " "
        click.echo(f"{marker} {device['id']}\t{device['label']}")


@cli.command(name="test-audio-input")
@click.option("--device", default=None, help="Device id/name to test. Empty means automatic.")
@click.option("--json-output", "--json", "as_json", is_flag=True, help="Print JSON output.")
def test_audio_input(device: str | None, as_json: bool) -> None:
    """Open the selected microphone briefly to verify it works."""
    config = load_config()
    selected = config.voice.input_device if device is None else device
    try:
        message = test_input_device(selected, config.voice.sample_rate, config.voice.min_rms)
        payload = {"ok": True, "message": message, "device": selected or ""}
    except Vox2AIError as exc:
        payload = {"ok": False, "message": str(exc), "device": selected or ""}

    if as_json:
        click.echo(json.dumps(payload))
    else:
        click.echo(payload["message"])
    if not payload["ok"]:
        raise SystemExit(1)


@cli.command(name="set-audio-input")
@click.option("--device", default="", help="Device id/name. Empty means automatic.")
def set_audio_input(device: str) -> None:
    """Persist the microphone input device in config.toml."""
    config = load_config()
    config.voice.input_device = device.strip()
    save_config(config)
    click.echo(config.voice.input_device or "auto")


@cli.command(name="config-path")
def config_path_cmd() -> None:
    """Print the resolved config file path."""
    click.echo(config_path())
