import os
from collections.abc import Sequence
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from faster_whisper import WhisperModel

from vox2ai.errors import TranscriptionError

os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")


@dataclass(frozen=True)
class TranscriptionResult:
    raw_text: str
    language: str | None = None
    duration_seconds: float | None = None
    avg_log_prob: float | None = None
    no_speech_prob: float | None = None
    used_language: str | None = None
    retried_with_primary_language: bool = False


# Cache loaded Whisper models so that repeated transcriptions
# reuse the in-memory model instead of reloading it from disk.
@lru_cache(maxsize=2)
def _load_model(model_name: str) -> WhisperModel:
    return WhisperModel(model_name, device="cpu", compute_type="int8")


_VAD_PARAMS = {"min_silence_duration_ms": 500}


def _transcribe_raw(
    model: WhisperModel,
    audio_path: Path,
    language: str | None,
    initial_prompt: str | None,
) -> tuple[str, str | None, float | None]:
    """Run a single faster-whisper transcription pass.

    Returns (text, detected_language, language_probability).
    """
    segments, info = model.transcribe(
        str(audio_path),
        language=language,
        initial_prompt=initial_prompt,
        vad_filter=True,
        vad_parameters=_VAD_PARAMS,
        condition_on_previous_text=False,
        no_speech_threshold=0.65,
        log_prob_threshold=-1.0,
        compression_ratio_threshold=2.4,
    )
    text = " ".join(segment.text.strip() for segment in segments).strip()
    detected_lang = info.language if info else None
    lang_prob = info.language_probability if info else None
    return text, detected_lang, lang_prob


def transcribe_audio(
    audio_path: Path,
    model_name: str,
    language: str = "auto",
    *,
    language_mode: str | None = None,
    primary_language: str = "en",
    allowed_languages: Sequence[str] = (),
    min_language_probability: float = 0.55,
    initial_prompt: str | None = None,
) -> TranscriptionResult:
    """Transcribe audio with configurable language detection.

    Parameters
    ----------
    audio_path : Path
        Path to the audio file.
    model_name : str
        Whisper model name.
    language : str
        Legacy parameter (``"auto"`` or a language code). Ignored when
        ``language_mode`` is provided.
    language_mode : str | None
        ``"auto"``, ``"force"``, or ``"constrained-auto"``.
    primary_language : str
        Language code for forced or fallback transcription.
    allowed_languages : Sequence[str]
        Accepted languages in constrained-auto mode.
    min_language_probability : float
        Minimum detection probability for constrained-auto acceptance.
    initial_prompt : str | None
        Optional Whisper initial prompt.
    """
    model = _load_model(model_name)

    # Resolve effective language mode from legacy parameter if needed.
    mode = language_mode
    if mode is None:
        mode = "auto" if language == "auto" else "force"

    # Resolve primary / fallback language.
    effective_primary = language if mode == "force" and language_mode is None else primary_language

    effective_allowed: list[str]
    if allowed_languages:
        effective_allowed = list(allowed_languages)
    elif mode == "constrained-auto":
        effective_allowed = [effective_primary]
    else:
        effective_allowed = []

    if mode == "force":
        used_lang = effective_primary
        text, detected_lang, lang_prob = _transcribe_raw(
            model, audio_path, used_lang, initial_prompt
        )
        if not text:
            raise TranscriptionError("Transcription returned empty text — no speech detected.")
        return TranscriptionResult(
            raw_text=text,
            language=detected_lang,
            used_language=used_lang,
            retried_with_primary_language=False,
        )

    # auto or constrained-auto: first pass with auto-detect.
    text, detected_lang, lang_prob = _transcribe_raw(model, audio_path, None, initial_prompt)

    if mode == "constrained-auto" and text:
        accept = (
            detected_lang is not None
            and lang_prob is not None
            and lang_prob >= min_language_probability
            and detected_lang in effective_allowed
        )
        if not accept:
            text, detected_lang, lang_prob = _transcribe_raw(
                model, audio_path, effective_primary, initial_prompt
            )
            if not text:
                raise TranscriptionError("Transcription returned empty text — no speech detected.")
            return TranscriptionResult(
                raw_text=text,
                language=detected_lang,
                used_language=effective_primary,
                retried_with_primary_language=True,
            )

    if not text:
        raise TranscriptionError("Transcription returned empty text — no speech detected.")

    return TranscriptionResult(
        raw_text=text,
        language=detected_lang,
        used_language=detected_lang,
        retried_with_primary_language=False,
    )
