import contextlib
import sys
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import sounddevice as sd
import soundfile as sf

from vox2ai.audio_input import start_input_stream
from vox2ai.errors import AudioError


@dataclass(frozen=True)
class RecordedAudio:
    """Validated audio recording result.

    Saves the .wav only after passing the quality gate
    (minimum duration and RMS threshold) to avoid saving
    garbage audio from silence or noise-only captures.
    """

    path: Path
    duration_seconds: float
    rms: float


def _compute_rms(audio: np.ndarray) -> float:
    return float(np.sqrt(np.mean(audio**2)))


def _record_frames(
    sample_rate: int,
    stop_event: threading.Event | None = None,
    input_device: str = "",
) -> list[np.ndarray]:
    """Record mono float32 frames until stop condition.

    Frames are buffered and later concatenated because sounddevice
    delivers audio in chunks via its callback API.
    """
    frames: list[np.ndarray] = []

    def callback(
        indata: np.ndarray,
        _frames_count: int,
        _time_info: object,
        status: sd.CallbackFlags,
    ) -> None:
        if status:
            print(f"Audio warning: {status}", file=sys.stderr)
        frames.append(indata.copy())

    try:
        stream = start_input_stream(
            sample_rate=sample_rate,
            channels=1,
            dtype="float32",
            callback=callback,
            device=input_device,
        )
    except sd.PortAudioError as e:
        raise AudioError(f"Could not open audio input stream: {e}") from e

    try:
        if stop_event is not None:
            stop_event.wait()
        else:
            with contextlib.suppress(EOFError, KeyboardInterrupt):
                input()
    finally:
        with contextlib.suppress(Exception):
            stream.stop()
        with contextlib.suppress(Exception):
            stream.close()

    return frames


def _validate_and_save(
    frames: list[np.ndarray],
    sample_rate: int,
    min_duration_seconds: float,
    min_rms: float,
) -> RecordedAudio:
    if not frames:
        raise AudioError("No audio was captured during the recording.")

    audio = np.concatenate(frames, axis=0)
    duration = audio.shape[0] / sample_rate
    rms = _compute_rms(audio)

    if duration < min_duration_seconds:
        raise AudioError(
            f"Recording too short ({duration:.2f}s < {min_duration_seconds}s). "
            "Speak longer or adjust voice.min_duration_seconds."
        )
    if rms < min_rms:
        raise AudioError(
            f"Audio too quiet (RMS {rms:.5f} < {min_rms}). Speak louder or adjust voice.min_rms."
        )

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        tmp_path = Path(f.name)
    sf.write(str(tmp_path), audio, sample_rate)
    return RecordedAudio(path=tmp_path, duration_seconds=duration, rms=rms)


def record_until_enter(
    sample_rate: int,
    min_duration_seconds: float = 0.7,
    min_rms: float = 0.003,
    input_device: str = "",
) -> RecordedAudio:
    """Record from default mic until Enter is pressed, then validate."""
    frames = _record_frames(sample_rate, input_device=input_device)
    return _validate_and_save(frames, sample_rate, min_duration_seconds, min_rms)


def record_until_event(
    sample_rate: int,
    stop_event: threading.Event,
    min_duration_seconds: float = 0.7,
    min_rms: float = 0.003,
    input_device: str = "",
) -> RecordedAudio:
    """Record from default mic until *stop_event* is set, then validate."""
    frames = _record_frames(sample_rate, stop_event, input_device=input_device)
    return _validate_and_save(frames, sample_rate, min_duration_seconds, min_rms)
