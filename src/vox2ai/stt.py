from functools import lru_cache
from pathlib import Path

from faster_whisper import WhisperModel

from vox2ai.errors import TranscriptionError


# Cache loaded Whisper models so that repeated transcriptions
# reuse the in-memory model instead of reloading it from disk.
# WhisperModel is a CTranslate2 wrapper; caching avoids the
# ~1-2 GB reload cost across calls within the same session.
@lru_cache(maxsize=2)
def _load_model(model_name: str) -> WhisperModel:
    return WhisperModel(model_name, device="cpu", compute_type="int8")


def transcribe_audio(
    audio_path: Path,
    model_name: str,
    language: str,
) -> str:
    model = _load_model(model_name)
    lang = None if language == "auto" else language

    segments, _info = model.transcribe(
        str(audio_path),
        language=lang,
        vad_filter=True,
    )

    text = " ".join(segment.text.strip() for segment in segments).strip()

    if not text:
        raise TranscriptionError("Transcription returned empty text — no speech detected.")

    return text
