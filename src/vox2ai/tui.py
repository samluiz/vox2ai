import threading

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.widgets import Footer, Header, RichLog, Static

from vox2ai.audio import record_until_event
from vox2ai.config import AppConfig, load_config
from vox2ai.errors import Vox2AIError
from vox2ai.llm import LLMClient
from vox2ai.prompts import ASSISTANT_SYSTEM_PROMPT
from vox2ai.stt import transcribe_audio


def _format_config_summary(cfg: AppConfig) -> str:
    return (
        f"Provider: {cfg.assistant.provider}  |  "
        f"Model: {cfg.assistant.model}  |  "
        f"Language: {cfg.voice.language}  |  "
        f"Whisper: {cfg.voice.whisper_model}"
    )


# Helper methods used via call_from_thread so that widget access
# (query_one) always happens on the Textual app thread.
class Vox2aiApp(App[None]):
    """Minimal TUI for vox2ai."""

    TITLE = "vox2ai"

    BINDINGS = [
        Binding("r", "record_ask", "Record & Ask"),
        Binding("d", "record_dict", "Record Dictation"),
        Binding("s", "stop_recording", "Stop"),
        Binding("q", "quit", "Quit"),
    ]

    CSS = """
    Screen {
        layout: vertical;
    }
    #config-bar {
        height: auto;
        padding: 0 1;
        background: $surface;
        color: $text-muted;
    }
    #panels {
        height: 1fr;
    }
    #transcript-panel {
        width: 1fr;
        border: solid $primary;
    }
    #answer-panel {
        width: 1fr;
        border: solid $secondary;
    }
    #transcript-log {
        height: 1fr;
    }
    #answer-log {
        height: 1fr;
    }
    #status {
        height: 1;
        background: $boost;
        color: $text;
        padding: 0 1;
    }
    """

    def __init__(self) -> None:
        super().__init__()
        self._config = load_config()
        self._stop_recording: threading.Event = threading.Event()
        self._is_recording: bool = False
        self._mode: str = "ask"

    def compose(self) -> ComposeResult:
        yield Header()
        yield Static(_format_config_summary(self._config), id="config-bar")
        with Horizontal(id="panels"):
            with Vertical(id="transcript-panel"):
                yield Static("Transcript")
                yield RichLog(id="transcript-log", highlight=True, wrap=True)
            with Vertical(id="answer-panel"):
                yield Static("Answer")
                yield RichLog(id="answer-log", highlight=True, wrap=True)
        yield Static(id="status")
        yield Footer()

    def on_mount(self) -> None:
        self._update_status("Ready. Press r: ask | d: dict | q: quit")

    # -- UI helpers (called from the main thread via call_from_thread) --

    def _update_status(self, text: str) -> None:
        self.query_one("#status", Static).update(text)

    def _write_transcript(self, text: str) -> None:
        self.query_one("#transcript-log", RichLog).write(text)

    def _write_answer(self, text: str) -> None:
        self.query_one("#answer-log", RichLog).write(text)

    def _clear_panels(self) -> None:
        self.query_one("#transcript-log", RichLog).clear()
        self.query_one("#answer-log", RichLog).clear()

    # -- Actions --

    def action_record_ask(self) -> None:
        if self._is_recording:
            self._stop_recording.set()
            return
        self._start_recording("ask")

    def action_record_dict(self) -> None:
        if self._is_recording:
            self._stop_recording.set()
            return
        self._start_recording("dict")

    def action_stop_recording(self) -> None:
        if self._is_recording:
            self._stop_recording.set()

    def _start_recording(self, mode: str) -> None:
        self._mode = mode
        self._is_recording = True
        self._stop_recording.clear()
        self._update_status("Recording... press r, d, or s to stop")
        self._clear_panels()
        self.run_worker(self._recording_worker, thread=True)

    def _recording_worker(self) -> None:
        audio_path = None
        try:
            recorded = record_until_event(
                self._config.voice.sample_rate,
                self._stop_recording,
                min_duration_seconds=self._config.voice.min_duration_seconds,
                min_rms=self._config.voice.min_rms,
            )
            audio_path = recorded.path
            self._is_recording = False
            self.call_from_thread(self._update_status, "Transcribing...")

            transcript = transcribe_audio(
                recorded.path,
                self._config.voice.whisper_model,
                language=self._config.voice.language,
                language_mode=self._config.voice.language_mode,
                primary_language=self._config.voice.primary_language,
                allowed_languages=self._config.voice.allowed_languages,
                min_language_probability=self._config.voice.min_language_probability,
            )

            self.call_from_thread(self._write_transcript, transcript)

            if self._mode == "ask":
                self.call_from_thread(self._update_status, "Sending to LLM...")
                client = LLMClient(self._config.assistant)
                answer = client.complete(ASSISTANT_SYSTEM_PROMPT, transcript.raw_text)
                self.call_from_thread(self._write_answer, answer)

            self.call_from_thread(
                self._update_status,
                "Ready. Press r: ask | d: dict | q: quit",
            )
        except Vox2AIError as e:
            self.call_from_thread(self._update_status, f"Error: {e}")
            self._is_recording = False
        finally:
            if audio_path is not None:
                audio_path.unlink(missing_ok=True)
