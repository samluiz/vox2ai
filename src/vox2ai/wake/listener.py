"""Passive microphone listener for wake word detection.

Runs a low-power audio stream, feeds frames to the detector.
Does NOT record or save audio.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable

import numpy as np
import sounddevice as sd

log = logging.getLogger(__name__)

# ponytail: 16kHz, 80ms frames (1280 samples) — matches openwakeword expectation
SAMPLE_RATE = 16000
FRAME_SAMPLES = 1280


class PassiveListener:
    """Opens a mic stream and feeds frames to a wake detector."""

    def __init__(
        self,
        detector_process: Callable[[np.ndarray], float],
        device: str = "",
    ) -> None:
        self._process = detector_process
        self._device = device
        self._stream: sd.InputStream | None = None
        self._running = False
        self._lock = threading.Lock()

    def start(self) -> None:
        if self._running:
            return
        with self._lock:
            self._running = True
            try:
                self._stream = sd.InputStream(
                    samplerate=SAMPLE_RATE,
                    channels=1,
                    dtype="int16",
                    blocksize=FRAME_SAMPLES,
                    device=self._device or None,
                    callback=self._audio_callback,
                )
                self._stream.start()
                log.info("Passive listener started (device=%s)", self._device or "default")
            except Exception:
                self._running = False
                log.exception("Failed to start passive listener")
                raise

    def stop(self) -> None:
        with self._lock:
            self._running = False
            if self._stream is not None:
                try:
                    self._stream.stop()
                    self._stream.close()
                except Exception:
                    log.debug("Stream close error (expected on shutdown)")
                self._stream = None

    @property
    def is_running(self) -> bool:
        return self._running

    def _audio_callback(
        self, indata: np.ndarray, _frames: int, _time_info: object, _status: object
    ) -> None:
        if not self._running:
            return
        # indata shape: (frames, 1), int16
        pcm = indata[:, 0].copy()
        self._process(pcm)
