import click

from vox2ai.config import config_path, ensure_config
from vox2ai.doctor import run_doctor
from vox2ai.runner import run_one_shot_assistant, run_one_shot_dictation
from vox2ai.tui import Vox2aiApp


@click.group(invoke_without_command=True)
@click.pass_context
def cli(ctx: click.Context) -> None:
    """vox2ai — terminal voice assistant for Linux."""
    if ctx.invoked_subcommand is None:
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


@cli.command(name="config-path")
def config_path_cmd() -> None:
    """Print the resolved config file path."""
    click.echo(config_path())
