"""Wake word manager — coordinates detector + listener + app callbacks."""

from __future__ import annotations

import logging
from collections.abc import Callable

from vox2ai.wake.detector import WakeDetector
from vox2ai.wake.listener import PassiveListener

log = logging.getLogger(__name__)


class WakeManager:
    """High-level wake word controller.

    Lifecycle:
        manager = WakeManager(...)
        manager.start()   # begins passive listening
        # ... on detection, on_wake callback fires ...
        manager.pause()   # stops listening (e.g., during recording)
        manager.resume()  # restarts listening
        manager.stop()    # full shutdown
    """

    def __init__(
        self,
        on_wake: Callable[[], None],
        model_name: str = "hey_mycroft",
        threshold: float = 0.5,
        device: str = "",
    ) -> None:
        self._on_wake = on_wake
        self._detector = WakeDetector(
            model_name=model_name,
            threshold=threshold,
            on_detect=self._handle_detect,
        )
        self._listener = PassiveListener(
            detector_process=self._detector.process_frame,
            device=device,
        )
        self._paused = False

    def start(self) -> None:
        self._detector.start()
        self._listener.start()
        log.info("Wake manager started")

    def stop(self) -> None:
        self._listener.stop()
        self._detector.stop()
        log.info("Wake manager stopped")

    def pause(self) -> None:
        """Pause listening (e.g., during active recording)."""
        self._paused = True
        self._listener.stop()
        log.debug("Wake manager paused")

    def resume(self) -> None:
        """Resume listening after recording."""
        if not self._paused:
            return
        self._paused = False
        try:
            self._listener.start()
            log.debug("Wake manager resumed")
        except Exception:
            log.exception("Failed to resume wake manager")

    @property
    def is_running(self) -> bool:
        return self._listener.is_running and not self._paused

    def set_threshold(self, threshold: float) -> None:
        self._detector.set_threshold(threshold)

    @property
    def model_name(self) -> str:
        return self._detector.model_name

    def _handle_detect(self) -> None:
        log.info("Wake word detected!")
        self._on_wake()
