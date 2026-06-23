from rich.console import Console

from vox2ai.audio import record_until_enter
from vox2ai.config import load_config
from vox2ai.errors import Vox2AIError
from vox2ai.llm import LLMClient
from vox2ai.prompts import ASSISTANT_SYSTEM_PROMPT
from vox2ai.stt import transcribe_audio


def _console() -> Console:
    return Console()


def run_one_shot_assistant() -> None:
    config = load_config()
    recorded = None
    try:
        _console().print("[yellow]Press Enter to record, press Enter again to stop.[/yellow]")
        recorded = record_until_enter(
            config.voice.sample_rate,
            min_duration_seconds=config.voice.min_duration_seconds,
            min_rms=config.voice.min_rms,
            input_device=config.voice.input_device,
        )

        _console().print("\n[bold]You said:[/bold]")
        result = transcribe_audio(
            recorded.path,
            config.voice.whisper_model,
            language=config.voice.language,
            language_mode=config.voice.language_mode,
            primary_language=config.voice.primary_language,
            allowed_languages=config.voice.allowed_languages,
            min_language_probability=config.voice.min_language_probability,
        )
        _console().print(f"[green]{result.raw_text}[/green]")

        _console().print("\n[bold]Answer:[/bold]")
        client = LLMClient(config.assistant)
        answer = client.complete(ASSISTANT_SYSTEM_PROMPT, result.raw_text)
        _console().print(answer)
    except Vox2AIError as e:
        _console().print(f"[red]Error:[/red] {e}")
        raise SystemExit(1) from e
    finally:
        if recorded is not None:
            recorded.path.unlink(missing_ok=True)


def run_one_shot_dictation() -> None:
    config = load_config()
    recorded = None
    try:
        _console().print("[yellow]Press Enter to record, press Enter again to stop.[/yellow]")
        recorded = record_until_enter(
            config.voice.sample_rate,
            min_duration_seconds=config.voice.min_duration_seconds,
            min_rms=config.voice.min_rms,
            input_device=config.voice.input_device,
        )

        _console().print("\n[bold]You said:[/bold]")
        result = transcribe_audio(
            recorded.path,
            config.voice.whisper_model,
            language=config.voice.language,
            language_mode=config.voice.language_mode,
            primary_language=config.voice.primary_language,
            allowed_languages=config.voice.allowed_languages,
            min_language_probability=config.voice.min_language_probability,
        )
        _console().print(f"[green]{result.raw_text}[/green]")
    except Vox2AIError as e:
        _console().print(f"[red]Error:[/red] {e}")
        raise SystemExit(1) from e
    finally:
        if recorded is not None:
            recorded.path.unlink(missing_ok=True)
