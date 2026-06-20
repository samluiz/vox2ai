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
    audio_path = None
    try:
        _console().print("[yellow]Recording. Press Enter to stop.[/yellow]")
        audio_path = record_until_enter(config.voice.sample_rate)

        _console().print("\n[bold]You said:[/bold]")
        transcript = transcribe_audio(audio_path, config.voice.whisper_model, config.voice.language)
        _console().print(f"[green]{transcript}[/green]")

        _console().print("\n[bold]Answer:[/bold]")
        client = LLMClient(config.assistant)
        answer = client.complete(ASSISTANT_SYSTEM_PROMPT, transcript)
        _console().print(answer)
    except Vox2AIError as e:
        _console().print(f"[red]Error:[/red] {e}")
        raise SystemExit(1) from e
    finally:
        if audio_path is not None:
            audio_path.unlink(missing_ok=True)


def run_one_shot_dictation() -> None:
    config = load_config()
    audio_path = None
    try:
        _console().print("[yellow]Recording. Press Enter to stop.[/yellow]")
        audio_path = record_until_enter(config.voice.sample_rate)

        _console().print("\n[bold]You said:[/bold]")
        transcript = transcribe_audio(audio_path, config.voice.whisper_model, config.voice.language)
        _console().print(f"[green]{transcript}[/green]")
    except Vox2AIError as e:
        _console().print(f"[red]Error:[/red] {e}")
        raise SystemExit(1) from e
    finally:
        if audio_path is not None:
            audio_path.unlink(missing_ok=True)
