from __future__ import annotations

import asyncio
import threading
from pathlib import Path

import pytest

from vox2ai.audio import RecordedAudio
from vox2ai.config import AppConfig
from vox2ai.desktop_server import DesktopController


@pytest.mark.asyncio
async def test_cancel_during_recording_stops_recorder(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = AppConfig()
    controller = DesktopController(config)
    events: list[dict[str, object]] = []
    loop = asyncio.get_running_loop()
    recorder_ref: dict[str, object] = {}

    def broadcast(event: object) -> None:
        events.append(
            {
                "type": getattr(event, "type", None),
                "state": getattr(event, "state", None),
                "operation": getattr(event, "operation", None),
                "message": getattr(event, "message", None),
            }
        )

    controller.set_broadcast(broadcast, loop)

    class FakeRecorder:
        cancelled = False

        def __init__(self, **_kwargs: object) -> None:
            recorder_ref["recorder"] = self

        def start(self) -> None:
            pass

        def cancel(self) -> None:
            self.cancelled = True

        def snapshot_audio(self) -> tuple[object, int]:
            raise AssertionError("partial loop should be stopped before snapshot")

    monkeypatch.setattr("vox2ai.desktop_server.StreamingRecorder", FakeRecorder)

    await controller.handle_command('{"type": "start_recording"}')
    await controller.handle_command('{"type": "cancel_current_operation"}')
    await asyncio.sleep(0)

    recorder = recorder_ref["recorder"]
    assert recorder.cancelled is True
    assert any(e["type"] == "operation_cancelled" for e in events)
    assert events[-1]["state"] == "ready"
    assert events[-1]["message"] == "Cancelled."


@pytest.mark.asyncio
async def test_cancel_during_transcription_ignores_stale_result(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = AppConfig()
    config.transcription.partial.enabled = False
    controller = DesktopController(config)
    events: list[dict[str, object]] = []
    loop = asyncio.get_running_loop()
    transcription_started = threading.Event()
    transcription_release = threading.Event()
    audio_path = tmp_path / "fake.wav"

    def broadcast(event: object) -> None:
        events.append(
            {
                "type": getattr(event, "type", None),
                "state": getattr(event, "state", None),
                "text": getattr(event, "text", None),
                "operation": getattr(event, "operation", None),
            }
        )

    controller.set_broadcast(broadcast, loop)

    class FakeRecorder:
        def __init__(self, **_kwargs: object) -> None:
            pass

        def start(self) -> None:
            pass

        def stop(self) -> RecordedAudio:
            audio_path.write_bytes(b"fake")
            return RecordedAudio(path=audio_path, duration_seconds=1.0, rms=0.2)

        def cancel(self) -> None:
            pass

    def fake_transcription(_path: Path, _config: AppConfig) -> str:
        transcription_started.set()
        assert transcription_release.wait(timeout=2)
        return "stale transcript"

    def fail_decision(*_args: object) -> object:
        raise AssertionError("cancelled transcript must not be sent to AI")

    monkeypatch.setattr("vox2ai.desktop_server.StreamingRecorder", FakeRecorder)
    monkeypatch.setattr("vox2ai.desktop_server._do_transcription", fake_transcription)
    monkeypatch.setattr("vox2ai.desktop_server._do_decision", fail_decision)

    await controller.handle_command('{"type": "start_recording"}')
    stop_task = asyncio.create_task(controller.handle_command('{"type": "stop_recording"}'))

    assert await asyncio.to_thread(transcription_started.wait, 2)
    await controller.handle_command('{"type": "cancel_current_operation"}')
    transcription_release.set()
    await stop_task
    await asyncio.sleep(0)

    assert any(
        e["type"] == "operation_cancelled" and e["operation"] == "transcription" for e in events
    )
    assert not any(e["type"] == "transcript" for e in events)
    assert not any(e["type"] == "answer_start" for e in events)
    assert not audio_path.exists()
