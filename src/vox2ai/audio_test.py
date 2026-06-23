"""Live microphone level test used by GNOME preferences."""

from __future__ import annotations

import contextlib
import threading
from collections.abc import Callable

import numpy as np
import sounddevice as sd

from vox2ai.audio_input import start_input_stream
from vox2ai.config import VoiceConfig
from vox2ai.errors import AudioError

AudioTestCallback = Callable[[dict[str, float | bool]], None]


class AudioInputTestSession:
    """Open the configured microphone and emit live RMS/peak levels."""

    def __init__(self, voice: VoiceConfig, callback: AudioTestCallback) -> None:
        self._voice = voice
        self._callback = callback
        self._stream: sd.InputStream | None = None
        self._frames: list[np.ndarray] = []
        self._lock = threading.Lock()
        self._threshold = voice.voice_activity_threshold

    def start(self) -> None:
        with self._lock:
            if self._stream is not None:
                raise AudioError("Audio input test is already running.")
            self._frames.clear()
            self._stream = start_input_stream(
                sample_rate=self._voice.sample_rate,
                channels=1,
                dtype="float32",
                callback=self._on_audio,
                device=self._voice.input_device,
            )

    def stop(self) -> None:
        with self._lock:
            stream = self._stream
            self._stream = None
            self._frames.clear()
        if stream is not None:
            with contextlib.suppress(Exception):
                stream.stop()
            with contextlib.suppress(Exception):
                stream.close()

    def update_threshold(self, threshold: float) -> None:
        with self._lock:
            self._threshold = threshold

    def _on_audio(
        self,
        indata: np.ndarray,
        _frames_count: int,
        _time_info: object,
        _status: sd.CallbackFlags,
    ) -> None:
        with self._lock:
            if self._stream is None:
                return
            self._frames.append(indata.copy())
            if len(self._frames) < 3:
                return
            frames = self._frames
            self._frames = []
            threshold = self._threshold

        audio = np.concatenate(frames, axis=0)
        rms = float(np.sqrt(np.mean(audio**2)))
        peak = float(np.max(np.abs(audio)))
        effective_threshold = self._effective_threshold(threshold)
        self._callback(
            {
                "rms": rms,
                "peak": peak,
                "speech_detected": rms >= effective_threshold,
                "threshold": effective_threshold,
            }
        )

    def _effective_threshold(self, threshold: float) -> float:
        if threshold >= 0:
            return threshold
        return max(0.00001, self._voice.min_rms + threshold)
