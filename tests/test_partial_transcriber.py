"""Tests for local partial transcription.

These tests use fake STT functions so they do not require a microphone,
Whisper download, real WebSocket, GUI, or API calls.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable

import numpy as np
import pytest

from vox2ai.partial_transcriber import LocalPartialTranscriber, PartialTranscript


def _make_audio(seconds: float, sample_rate: int = 16000) -> np.ndarray:
    """Generate a small float32 mono audio window."""
    samples = int(seconds * sample_rate)
    return np.linspace(-0.1, 0.1, samples).astype("float32")


def _collecting_callback() -> tuple[Callable[[PartialTranscript], None], list[PartialTranscript]]:
    results: list[PartialTranscript] = []

    def cb(partial: PartialTranscript) -> None:
        results.append(partial)

    return cb, results


def test_partial_emits_after_min_audio_seconds() -> None:
    cb, results = _collecting_callback()

    def transcribe(_audio: np.ndarray, _sample_rate: int, *_args: object) -> str:
        return "hello world"

    transcriber = LocalPartialTranscriber(
        model_name="tiny",
        language="en",
        initial_prompt=None,
        interval_ms=50,
        min_audio_seconds=0.5,
        window_seconds=2.0,
        max_partial_chars=220,
        emit_only_on_change=False,
        on_partial=cb,
        transcribe_fn=transcribe,
    )

    short_audio = _make_audio(0.3)
    assert transcriber.maybe_transcribe(short_audio, 16000) is False
    assert not results

    long_audio = _make_audio(0.6)
    assert transcriber.maybe_transcribe(long_audio, 16000) is True

    # Wait for the worker thread to finish.
    time.sleep(0.1)
    assert len(results) == 1
    assert results[0].text == "hello world"
    assert results[0].stable is False

    transcriber.close()


def test_partial_respects_interval_ms() -> None:
    cb, results = _collecting_callback()

    def transcribe(_audio: np.ndarray, _sample_rate: int, *_args: object) -> str:
        return "tick"

    transcriber = LocalPartialTranscriber(
        model_name="tiny",
        language="en",
        initial_prompt=None,
        interval_ms=200,
        min_audio_seconds=0.1,
        window_seconds=2.0,
        max_partial_chars=220,
        emit_only_on_change=False,
        on_partial=cb,
        transcribe_fn=transcribe,
    )

    audio = _make_audio(0.5)
    transcriber.maybe_transcribe(audio, 16000)
    # Immediate second call should be ignored because interval has not elapsed.
    assert transcriber.maybe_transcribe(audio, 16000) is False

    time.sleep(0.25)
    assert len(results) == 1

    transcriber.close()


def test_partial_skips_overlapping_jobs() -> None:
    cb, results = _collecting_callback()
    barrier = threading.Barrier(2)

    def slow_transcribe(_audio: np.ndarray, _sample_rate: int, *_args: object) -> str:
        barrier.wait(timeout=1)
        return "slow"

    transcriber = LocalPartialTranscriber(
        model_name="tiny",
        language="en",
        initial_prompt=None,
        interval_ms=50,
        min_audio_seconds=0.1,
        window_seconds=2.0,
        max_partial_chars=220,
        emit_only_on_change=False,
        on_partial=cb,
        transcribe_fn=slow_transcribe,
    )

    audio = _make_audio(0.5)
    assert transcriber.maybe_transcribe(audio, 16000) is True
    # While the first job is still running, another call must be skipped.
    assert transcriber.maybe_transcribe(audio, 16000) is False

    barrier.wait(timeout=1)
    time.sleep(0.05)
    assert len(results) == 1

    transcriber.close()


def test_partial_emit_only_on_change() -> None:
    cb, results = _collecting_callback()

    def transcribe(_audio: np.ndarray, _sample_rate: int, *_args: object) -> str:
        return "same"

    transcriber = LocalPartialTranscriber(
        model_name="tiny",
        language="en",
        initial_prompt=None,
        interval_ms=50,
        min_audio_seconds=0.1,
        window_seconds=2.0,
        max_partial_chars=220,
        emit_only_on_change=True,
        on_partial=cb,
        transcribe_fn=transcribe,
    )

    audio = _make_audio(0.5)
    transcriber.maybe_transcribe(audio, 16000)
    time.sleep(0.1)
    transcriber.maybe_transcribe(audio, 16000)
    time.sleep(0.1)

    assert len(results) == 1

    transcriber.close()


def test_partial_text_truncates_to_max_chars() -> None:
    cb, results = _collecting_callback()

    def transcribe(_audio: np.ndarray, _sample_rate: int, *_args: object) -> str:
        return "a" * 500

    transcriber = LocalPartialTranscriber(
        model_name="tiny",
        language="en",
        initial_prompt=None,
        interval_ms=50,
        min_audio_seconds=0.1,
        window_seconds=2.0,
        max_partial_chars=50,
        emit_only_on_change=False,
        on_partial=cb,
        transcribe_fn=transcribe,
    )

    audio = _make_audio(0.5)
    transcriber.maybe_transcribe(audio, 16000)
    time.sleep(0.1)

    assert len(results) == 1
    assert len(results[0].text) == 51  # 50 chars + ellipsis
    assert results[0].text.endswith("…")

    transcriber.close()


def test_partial_error_does_not_crash_session() -> None:
    cb, results = _collecting_callback()

    def failing_transcribe(_audio: np.ndarray, _sample_rate: int, *_args: object) -> str:
        raise RuntimeError("STT failure")

    transcriber = LocalPartialTranscriber(
        model_name="tiny",
        language="en",
        initial_prompt=None,
        interval_ms=50,
        min_audio_seconds=0.1,
        window_seconds=2.0,
        max_partial_chars=220,
        emit_only_on_change=False,
        on_partial=cb,
        transcribe_fn=failing_transcribe,
    )

    audio = _make_audio(0.5)
    transcriber.maybe_transcribe(audio, 16000)
    time.sleep(0.1)

    assert not results
    # A subsequent successful call should still work after the failure.

    def working_transcribe(_audio: np.ndarray, _sample_rate: int, *_args: object) -> str:
        return "recovered"

    transcriber._transcribe = working_transcribe  # type: ignore[assignment]
    transcriber.maybe_transcribe(audio, 16000)
    time.sleep(0.1)

    assert len(results) == 1
    assert results[0].text == "recovered"

    transcriber.close()


def test_partial_uses_rolling_window() -> None:
    cb, results = _collecting_callback()

    def transcribe(audio: np.ndarray, sample_rate: int, *_args: object) -> str:
        duration = audio.shape[0] / sample_rate
        return f"dur-{duration:.1f}"

    transcriber = LocalPartialTranscriber(
        model_name="tiny",
        language="en",
        initial_prompt=None,
        interval_ms=50,
        min_audio_seconds=0.1,
        window_seconds=1.0,
        max_partial_chars=220,
        emit_only_on_change=False,
        on_partial=cb,
        transcribe_fn=transcribe,
    )

    # 2.5 seconds of audio should be truncated to ~1.0 second window.
    audio = _make_audio(2.5)
    transcriber.maybe_transcribe(audio, 16000)
    time.sleep(0.1)

    assert len(results) == 1
    assert "dur-1.0" in results[0].text

    transcriber.close()


def test_close_ignores_late_callbacks() -> None:
    cb, results = _collecting_callback()
    barrier = threading.Barrier(2)

    def slow_transcribe(_audio: np.ndarray, _sample_rate: int, *_args: object) -> str:
        barrier.wait(timeout=1)
        return "late"

    transcriber = LocalPartialTranscriber(
        model_name="tiny",
        language="en",
        initial_prompt=None,
        interval_ms=50,
        min_audio_seconds=0.1,
        window_seconds=2.0,
        max_partial_chars=220,
        emit_only_on_change=False,
        on_partial=cb,
        transcribe_fn=slow_transcribe,
    )

    audio = _make_audio(0.5)
    transcriber.maybe_transcribe(audio, 16000)
    transcriber.close()

    # Even if the worker finishes after close, the callback must not fire.
    barrier.wait(timeout=1)
    time.sleep(0.05)
    assert not results


def test_partial_transcript_event_serializes() -> None:
    from vox2ai.desktop_protocol import PartialTranscriptEvent, serialize_event

    event = PartialTranscriptEvent(text="hello", stable=False)
    payload = serialize_event(event)
    import json

    data = json.loads(payload)
    assert data["type"] == "partial_transcript"
    assert data["text"] == "hello"
    assert data["stable"] is False


@pytest.mark.asyncio
async def test_controller_partial_loop_lifecycle(monkeypatch: pytest.MonkeyPatch) -> None:
    import asyncio

    from vox2ai.agent import AgentDecision
    from vox2ai.config import AppConfig
    from vox2ai.desktop_server import DesktopController

    config = AppConfig()
    config.transcription.mode = "local-partial"
    config.transcription.partial.interval_ms = 50
    config.transcription.partial.min_audio_seconds = 0.1
    config.transcription.partial.window_seconds = 1.0

    controller = DesktopController(config)
    events: list[dict] = []
    loop = asyncio.get_running_loop()

    def broadcast(event: object) -> None:
        data = {
            "type": getattr(event, "type", None),
            "text": getattr(event, "text", None),
            "state": getattr(event, "state", None),
        }
        events.append(data)

    controller.set_broadcast(broadcast, loop)

    fake_audio = np.linspace(-0.1, 0.1, 1600, dtype="float32")

    class FakeRecorder:
        def __init__(self, **kwargs: object) -> None:
            pass

        def start(self) -> None:
            pass

        def stop(self) -> object:
            from pathlib import Path

            from vox2ai.audio import RecordedAudio

            return RecordedAudio(path=Path("/tmp/fake.wav"), duration_seconds=1.0, rms=0.1)

        def cancel(self) -> None:
            pass

        def snapshot_audio(self) -> tuple[np.ndarray, int]:
            return fake_audio, 16000

    monkeypatch.setattr("vox2ai.desktop_server.StreamingRecorder", FakeRecorder)

    # Replace the real transcription with a fast fake.
    def fake_transcribe(_audio: np.ndarray, _sample_rate: int, *_args: object) -> str:
        return "partial text"

    monkeypatch.setattr(
        "vox2ai.desktop_server.LocalPartialTranscriber",
        lambda **kwargs: LocalPartialTranscriber(**{**kwargs, "transcribe_fn": fake_transcribe}),
    )

    # Avoid real Whisper during final transcription.
    monkeypatch.setattr(
        "vox2ai.desktop_server._do_transcription",
        lambda _path, _config: "final text",
    )
    # Avoid real LLM decision by returning a simple answer decision.
    monkeypatch.setattr(
        "vox2ai.desktop_server._do_decision",
        lambda _llm, _transcript: AgentDecision(
            type="answer", message="ok", command=None, reason=None
        ),
    )

    await controller.handle_command('{"type": "start_recording"}')
    await asyncio.sleep(0.2)

    partial_events = [e for e in events if e["type"] == "partial_transcript"]
    assert len(partial_events) >= 1
    assert partial_events[-1]["text"] == "partial text"

    # Stop should stop the partial loop and eventually produce a final transcript.
    # The final STT will fail because /tmp/fake.wav does not exist; that is fine
    # for this test because we only care that partials stop after stop_recording.
    await controller.handle_command('{"type": "stop_recording"}')
    await asyncio.sleep(0.1)

    # After stop, no new partial events should be emitted.
    post_stop = [e for e in events if e["type"] == "partial_transcript"]
    assert len(post_stop) == len(partial_events)


def test_recorder_snapshot_audio_returns_copy(monkeypatch: pytest.MonkeyPatch) -> None:
    import numpy as np

    from vox2ai.recorder import StreamingRecorder

    class FakeStream:
        def __init__(self, **kwargs: object) -> None:
            pass

        def start(self) -> None:
            pass

        def stop(self) -> None:
            pass

        def close(self) -> None:
            pass

    monkeypatch.setattr("sounddevice.InputStream", FakeStream)

    recorder = StreamingRecorder(
        sample_rate=16000,
        min_duration_seconds=0.1,
        min_rms=0.001,
    )
    recorder.start()

    fake_frame = np.array([[0.1], [0.2], [0.3]], dtype="float32")
    recorder.callback(fake_frame, 0, None, None)  # type: ignore[arg-type]

    audio, sr = recorder.snapshot_audio()
    assert sr == 16000
    assert audio.shape[0] == 3
    assert not np.shares_memory(audio, fake_frame)

    recorder.cancel()
