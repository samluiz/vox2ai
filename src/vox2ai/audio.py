import contextlib
import sys
import tempfile
import threading
from pathlib import Path

import numpy as np
import sounddevice as sd
import soundfile as sf

from vox2ai.errors import AudioError


def record_until_enter(sample_rate: int) -> Path:
    """Record mono audio from the default input device until the user presses Enter.

    Frames are buffered in a list and concatenated once recording stops,
    because sounddevice delivers audio in chunks via its callback API.
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
        stream = sd.InputStream(
            samplerate=sample_rate,
            channels=1,
            dtype="float32",
            callback=callback,
        )
    except sd.PortAudioError as e:
        raise AudioError(f"Could not open audio input stream: {e}") from e

    with stream, contextlib.suppress(EOFError, KeyboardInterrupt):
        input("Recording. Press Enter to stop.\n")

    if not frames:
        raise AudioError("No audio was captured during the recording.")

    audio = np.concatenate(frames, axis=0)
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        tmp_path = Path(f.name)
    sf.write(str(tmp_path), audio, sample_rate)
    return tmp_path


def record_until_event(sample_rate: int, stop_event: threading.Event) -> Path:
    """Record mono audio until *stop_event* is set.

    Used by the TUI where we cannot block on input() and instead
    rely on the event being set from a keybinding action.
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
        stream = sd.InputStream(
            samplerate=sample_rate,
            channels=1,
            dtype="float32",
            callback=callback,
        )
    except sd.PortAudioError as e:
        raise AudioError(f"Could not open audio input stream: {e}") from e

    with stream:
        stop_event.wait()

    if not frames:
        raise AudioError("No audio was captured during the recording.")

    audio = np.concatenate(frames, axis=0)
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        tmp_path = Path(f.name)
    sf.write(str(tmp_path), audio, sample_rate)
    return tmp_path
