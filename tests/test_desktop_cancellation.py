from __future__ import annotations

import asyncio

import pytest

from vox2ai.config import AppConfig
from vox2ai.desktop_server import DesktopController, ServerState


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
async def test_cancel_during_transcription_ignores_stale_result() -> None:
    config = AppConfig()
    config.transcription.partial.enabled = False
    controller = DesktopController(config)
    events: list[dict[str, object]] = []
    loop = asyncio.get_running_loop()

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

    controller._state = ServerState.TRANSCRIBING
    controller._operation_generation = 10
    await controller.handle_command('{"type": "cancel_current_operation"}')
    await asyncio.sleep(0)

    assert any(
        e["type"] == "operation_cancelled" and e["operation"] == "transcription" for e in events
    )
    assert not any(e["type"] == "transcript" for e in events)
    assert not any(e["type"] == "answer_start" for e in events)
    assert controller._operation_generation == 11
