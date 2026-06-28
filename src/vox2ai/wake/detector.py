"""OpenWakeWord-based wake word detector."""

from __future__ import annotations

import logging
from collections.abc import Callable

import numpy as np

log = logging.getLogger(__name__)

# ponytail: openwakeword import is lazy to avoid import cost when disabled
_oww_model_cls = None


def _get_model_class():  # type: ignore[no-untyped-def]
    global _oww_model_cls
    if _oww_model_cls is None:
        from openwakeword import Model as OwwModel

        _oww_model_cls = OwwModel
    return _oww_model_cls


class WakeDetector:
    """Wraps OpenWakeWord for single-model wake detection."""

    def __init__(
        self,
        model_name: str = "hey_mycroft",
        threshold: float = 0.5,
        on_detect: Callable[[], None] | None = None,
    ) -> None:
        self._model_name = model_name
        self._threshold = threshold
        self._on_detect = on_detect
        self._model = None
        self._running = False

    def start(self) -> None:
        if self._running:
            return
        import openwakeword

        model_info = openwakeword.models.get(self._model_name)
        if not model_info:
            log.error("Unknown wake model: %s", self._model_name)
            return
        model_path = model_info["model_path"]
        model_cls = _get_model_class()  # type: ignore[no-untyped-call]
        self._model = model_cls(
            wakeword_model_paths=[model_path],
            vad_threshold=0,
        )
        self._running = True
        log.info(
            "Wake detector started: model=%s threshold=%.2f",
            self._model_name,
            self._threshold,
        )

    def stop(self) -> None:
        self._running = False
        self._model = None

    @property
    def is_running(self) -> bool:
        return self._running

    def process_frame(self, pcm: np.ndarray) -> float:
        """Process one audio frame (1280 samples int16 at 16kHz). Returns confidence."""
        if not self._running or self._model is None:
            return 0.0
        try:
            result = self._model.predict(pcm)
            # result is dict like {'hey_mycroft': 0.85}
            confidence = max(result.values()) if result else 0.0
            if confidence >= self._threshold:
                self._model.reset()
                if self._on_detect:
                    self._on_detect()
            return confidence
        except Exception:
            log.exception("Wake detection error")
            return 0.0

    def set_threshold(self, threshold: float) -> None:
        self._threshold = max(0.0, min(1.0, threshold))

    @property
    def model_name(self) -> str:
        return self._model_name
