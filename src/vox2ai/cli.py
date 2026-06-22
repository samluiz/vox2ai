import click

from vox2ai.config import config_path, ensure_config
from vox2ai.doctor import run_doctor
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
    from vox2ai.desktop_server import run_server

    run_server(host=host, port=port)


@cli.command(name="config-path")
def config_path_cmd() -> None:
    """Print the resolved config file path."""
    click.echo(config_path())
