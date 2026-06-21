import time
from collections.abc import Generator
from contextlib import contextmanager


class Timer:
    """Simple named-span timer for debug output.

    Usage::

        timer = Timer()
        timer.start("transcription")
        ...
        timer.stop("transcription")
        print(timer.summary())  # "transcription 1.23s"
    """

    def __init__(self) -> None:
        self._spans: dict[str, float] = {}
        self._current: dict[str, float] = {}

    def start(self, name: str) -> None:
        self._current[name] = time.monotonic()

    def stop(self, name: str) -> float:
        elapsed = time.monotonic() - self._current.pop(name, time.monotonic())
        self._spans[name] = elapsed
        return elapsed

    @contextmanager
    def measure(self, name: str) -> Generator[None, None, None]:
        self.start(name)
        try:
            yield
        finally:
            self.stop(name)

    def get(self, name: str) -> float:
        return self._spans.get(name, 0.0)

    def summary(self) -> str:
        if not self._spans:
            return ""
        parts = [f"{k} {v:.2f}s" for k, v in sorted(self._spans.items())]
        total = sum(self._spans.values())
        parts.append(f"total {total:.2f}s")
        return " · ".join(parts)

    def reset(self) -> None:
        self._spans.clear()
        self._current.clear()
