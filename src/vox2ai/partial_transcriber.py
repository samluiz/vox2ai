"""Local, best-effort partial transcription while push-to-talk is held.

The partial transcript is UI feedback only. The final authoritative prompt
still comes from the full-utterance transcription after release.
"""

from __future__ import annotations

import tempfile
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf

from vox2ai.stt import _load_model
from vox2ai.transcript import normalize_transcript


@dataclass(frozen=True)
class PartialTranscript:
    text: str
    stable: bool = False


TranscribeFn = Callable[..., str]


def _resolve_partial_language(
    language_mode: str,
    primary_language: str,
    language: str,
) -> str | None:
    """Resolve the language parameter to pass to Whisper for partial STT.

    For speed and stability, constrained-auto always uses the primary language
    for partials (no retry logic).
    """
    if language_mode == "force":
        return primary_language
    if language_mode == "constrained-auto":
        return primary_language
    # auto: same as passing None to Whisper
    return None if language == "auto" else language


def _default_transcribe(
    audio: np.ndarray,
    sample_rate: int,
    model_name: str,
    language: str,
    initial_prompt: str | None,
    language_mode: str = "auto",
    primary_language: str = "en",
) -> str:
    """Transcribe a numpy audio window using the cached faster-whisper model.

    faster-whisper expects a file path, so this writes a temporary WAV in the
    worker and deletes it immediately after transcription.
    """
    model = _load_model(model_name)
    resolved = _resolve_partial_language(
        language_mode or "auto",
        primary_language,
        language,
    )

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        tmp_path = Path(f.name)
    try:
        sf.write(str(tmp_path), audio, sample_rate)
        segments, _info = model.transcribe(
            str(tmp_path),
            language=resolved,
            initial_prompt=initial_prompt,
            vad_filter=True,
            condition_on_previous_text=False,
            no_speech_threshold=0.65,
            log_prob_threshold=-1.0,
            compression_ratio_threshold=2.4,
        )
        text = " ".join(segment.text.strip() for segment in segments).strip()
    finally:
        tmp_path.unlink(missing_ok=True)

    return text


class LocalPartialTranscriber:
    """Emits rolling-window partial transcripts while recording is active.

    * One partial STT job runs at a time; ticks are skipped while busy.
    * Transcription runs in a worker thread so audio/WebSocket are not blocked.
    * The caller receives results through the *on_partial* callback, which is
      invoked from the worker thread.
    """

    def __init__(
        self,
        *,
        model_name: str,
        language: str,
        initial_prompt: str | None,
        interval_ms: int,
        min_audio_seconds: float,
        window_seconds: float,
        max_partial_chars: int,
        emit_only_on_change: bool,
        on_partial: Callable[[PartialTranscript], None],
        transcribe_fn: TranscribeFn | None = None,
        replacements: dict[str, str] | None = None,
        language_mode: str = "auto",
        primary_language: str = "en",
    ) -> None:
        self._model_name = model_name
        self._language = language
        self._language_mode = language_mode
        self._primary_language = primary_language
        self._initial_prompt = initial_prompt
        self._interval_ms = interval_ms
        self._min_audio_seconds = min_audio_seconds
        self._window_seconds = window_seconds
        self._max_partial_chars = max_partial_chars
        self._emit_only_on_change = emit_only_on_change
        self._on_partial = on_partial
        self._transcribe = transcribe_fn or _default_transcribe
        self._replacements = replacements or {}

        self._lock = threading.Lock()
        self._running = False
        self._last_run_at = 0.0
        self._last_text: str | None = None
        self._closed = False

    def maybe_transcribe(self, audio: np.ndarray, sample_rate: int) -> bool:
        """Start a partial transcription job if conditions are met.

        This method is non-blocking. If a job is already running, not enough
        audio has been captured, or the interval has not elapsed, it returns
        ``False`` immediately. Otherwise it schedules a worker and returns
        ``True``.
        """
        now = time.monotonic()

        with self._lock:
            if self._closed or self._running:
                return False
            if now - self._last_run_at < self._interval_ms / 1000.0:
                return False
            if audio.shape[0] / sample_rate < self._min_audio_seconds:
                return False
            self._running = True
            self._last_run_at = now

        # Snapshot the rolling window and start worker outside the lock so
        # audio capture is not blocked.
        window_samples = int(self._window_seconds * sample_rate)
        window = audio[-window_samples:].copy() if audio.shape[0] > window_samples else audio.copy()

        thread = threading.Thread(
            target=self._run_transcription,
            args=(window, sample_rate),
            daemon=True,
        )
        thread.start()
        return True

    def _run_transcription(self, audio: np.ndarray, sample_rate: int) -> None:
        try:
            raw = self._transcribe(
                audio,
                sample_rate,
                self._model_name,
                self._language,
                self._initial_prompt,
                self._language_mode,
                self._primary_language,
            )
            text = normalize_transcript(raw, self._replacements)
            if self._max_partial_chars and len(text) > self._max_partial_chars:
                text = text[: self._max_partial_chars] + "…"

            with self._lock:
                if self._closed:
                    return
                if self._emit_only_on_change and text == self._last_text:
                    return
                self._last_text = text

            self._on_partial(PartialTranscript(text=text, stable=False))
        except Exception:
            # Partial transcription is best-effort; failures are swallowed so
            # the recording session and final STT remain unaffected.
            pass
        finally:
            with self._lock:
                self._running = False

    def close(self) -> None:
        """Stop accepting new partial jobs and ignore in-flight results."""
        with self._lock:
            self._closed = True
