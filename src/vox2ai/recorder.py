import tempfile
import threading
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import sounddevice as sd
import soundfile as sf

from vox2ai.audio import RecordedAudio, _compute_rms
from vox2ai.errors import AudioError


@dataclass(frozen=True)
class AudioLevel:
    rms: float
    peak: float


class HoldToRecordSession:
    """Streaming audio recorder for push-to-talk hold behaviour.

    *start* opens a non-blocking InputStream and buffers frames.
    *stop* closes the stream, validates audio quality, writes a .wav.
    *cancel* discards the buffer without saving.
    """

    def __init__(
        self,
        sample_rate: int,
        min_duration_seconds: float,
        min_rms: float,
    ) -> None:
        self._sample_rate = sample_rate
        self._min_duration = min_duration_seconds
        self._min_rms = min_rms
        self._frames: list[np.ndarray] = []
        self._stream: sd.InputStream | None = None
        self._lock = threading.Lock()

    def start(self) -> None:
        with self._lock:
            if self._stream is not None:
                raise AudioError("Recording session already active.")
            self._frames.clear()

            def callback(
                indata: np.ndarray,
                _frames_count: int,
                _time_info: object,
                status: sd.CallbackFlags,
            ) -> None:
                if status:
                    import sys

                    print(f"Audio warning: {status}", file=sys.stderr)
                self._frames.append(indata.copy())

            try:
                self._stream = sd.InputStream(
                    samplerate=self._sample_rate,
                    channels=1,
                    dtype="float32",
                    callback=callback,
                )
                self._stream.start()
            except sd.PortAudioError as e:
                self._stream = None
                raise AudioError(f"Could not open audio input stream: {e}") from e

    def stop(self) -> RecordedAudio:
        with self._lock:
            if self._stream is None:
                raise AudioError("No active recording session to stop.")
            self._stream.stop()
            self._stream.close()
            self._stream = None
            frames = self._frames

        if not frames:
            raise AudioError("No audio was captured during the recording.")

        audio = np.concatenate(frames, axis=0)
        rms = _compute_rms(audio)
        duration = audio.shape[0] / self._sample_rate

        if duration < self._min_duration:
            raise AudioError(f"Recording too short ({duration:.2f}s < {self._min_duration}s).")
        if rms < self._min_rms:
            raise AudioError(f"Audio too quiet (RMS {rms:.5f} < {self._min_rms}).")

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            tmp_path = Path(f.name)
        sf.write(str(tmp_path), audio, self._sample_rate)
        return RecordedAudio(path=tmp_path, duration_seconds=duration, rms=rms)

    def cancel(self) -> None:
        with self._lock:
            if self._stream is not None:
                self._stream.stop()
                self._stream.close()
                self._stream = None
            self._frames.clear()

    def snapshot_audio(self) -> tuple[np.ndarray, int]:
        """Return a copy of currently buffered audio and the sample rate.

        This is thread-safe: the frame list is copied under the recorder
        lock so the audio callback is not blocked while we concatenate.
        """
        with self._lock:
            frames = self._frames.copy()
        if not frames:
            return np.array([], dtype="float32"), self._sample_rate
        audio = np.concatenate(frames, axis=0)
        return audio.copy(), self._sample_rate


class StreamingRecorder(HoldToRecordSession):
    """Extends HoldToRecordSession with live audio level events.

    Periodically computes RMS/peak from recent frames and calls
    ``on_audio_level`` so the frontend can render a waveform.
    Emits at roughly 25 events/sec.
    """

    def __init__(
        self,
        sample_rate: int,
        min_duration_seconds: float,
        min_rms: float,
        on_audio_level: Callable[[AudioLevel], None] | None = None,
    ) -> None:
        super().__init__(sample_rate, min_duration_seconds, min_rms)
        self._on_audio_level = on_audio_level
        self._level_frames: list[np.ndarray] = []

    def start(self) -> None:
        with self._lock:
            if self._stream is not None:
                raise AudioError("Recording session already active.")
            self._frames.clear()
            self._level_frames.clear()

            try:
                self._stream = sd.InputStream(
                    samplerate=self._sample_rate,
                    channels=1,
                    dtype="float32",
                    callback=self.callback,
                )
                self._stream.start()
            except sd.PortAudioError as e:
                self._stream = None
                raise AudioError(f"Could not open audio input stream: {e}") from e

    def callback(
        self,
        indata: np.ndarray,
        _frames_count: int,
        _time_info: object,
        status: sd.CallbackFlags,
    ) -> None:
        if status:
            import sys

            print(f"Audio warning: {status}", file=sys.stderr)
        copied = indata.copy()
        self._frames.append(copied)
        self._level_frames.append(copied)
        # Compute level from frames accumulated since last emission
        if len(self._level_frames) >= 3:  # roughly every ~40ms at 16kHz
            recent = np.concatenate(self._level_frames, axis=0)
            self._level_frames.clear()
            if self._on_audio_level:
                rms_val = float(np.sqrt(np.mean(recent**2)))
                peak_val = float(np.max(np.abs(recent)))
                self._on_audio_level(AudioLevel(rms=rms_val, peak=peak_val))
