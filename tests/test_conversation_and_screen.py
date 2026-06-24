"""Tests for conversation state propagation and screen context backend handling."""

from __future__ import annotations

import asyncio
import struct
import zlib
from pathlib import Path

import pytest

from vox2ai.config import AppConfig
from vox2ai.desktop_server import DesktopController


def _make_minimal_png(path: Path) -> None:
    """Write a valid 1x1 opaque PNG for tests that need real image dimensions."""
    signature = b"\x89PNG\r\n\x1a\n"
    # IHDR: 1x1, 8-bit RGBA
    ihdr_data = struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0)
    ihdr_chunk = _png_chunk(b"IHDR", ihdr_data)
    # IDAT: one row with filter byte + single RGBA pixel
    raw = b"\x00\xff\x00\x00\xff"
    compressed = zlib.compress(raw)
    idat_chunk = _png_chunk(b"IDAT", compressed)
    iend_chunk = _png_chunk(b"IEND", b"")
    path.write_bytes(signature + ihdr_chunk + idat_chunk + iend_chunk)


def _png_chunk(chunk_type: bytes, data: bytes) -> bytes:
    chunk = chunk_type + data
    crc = zlib.crc32(chunk) & 0xFFFFFFFF
    return struct.pack(">I", len(data)) + chunk + struct.pack(">I", crc)


def _broadcast_capture(events: list[dict]) -> object:
    def broadcast(event: object) -> None:
        events.append(
            {
                "type": getattr(event, "type", None),
                "enabled": getattr(event, "enabled", None),
                "turn_count": getattr(event, "turn_count", None),
                "max_turns": getattr(event, "max_turns", None),
                "context_id": getattr(event, "context_id", None),
                "mode": getattr(event, "mode", None),
                "image_path": getattr(event, "image_path", None),
                "message": getattr(event, "message", None),
                "state": getattr(event, "state", None),
                "available": getattr(event, "available", None),
                "method": getattr(event, "method", None),
                "screen": getattr(event, "screen", {}),
            }
        )

    return broadcast


@pytest.mark.asyncio
async def test_set_conversation_mode_emits_state() -> None:
    config = AppConfig()
    controller = DesktopController(config)
    events: list[dict] = []
    loop = asyncio.get_running_loop()
    controller.set_broadcast(_broadcast_capture(events), loop)

    await controller.handle_command('{"type": "set_conversation_mode", "enabled": true}')
    await asyncio.sleep(0)

    state_events = [e for e in events if e["type"] == "conversation_state"]
    assert any(e["enabled"] is True and e["turn_count"] == 0 for e in state_events)


@pytest.mark.asyncio
async def test_clear_conversation_resets_turn_count() -> None:
    config = AppConfig()
    controller = DesktopController(config)
    events: list[dict] = []
    loop = asyncio.get_running_loop()
    controller.set_broadcast(_broadcast_capture(events), loop)

    controller._conversation.set_enabled(True)
    controller._conversation.append("user", "hello")
    controller._conversation.append("assistant", "hi")

    await controller.handle_command('{"type": "clear_conversation"}')
    await asyncio.sleep(0)

    state_events = [e for e in events if e["type"] == "conversation_state"]
    assert state_events[-1]["turn_count"] == 0


@pytest.mark.asyncio
async def test_submit_text_prompt_appends_user_and_emits_conversation_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = AppConfig()
    controller = DesktopController(config)
    events: list[dict] = []
    loop = asyncio.get_running_loop()
    controller.set_broadcast(_broadcast_capture(events), loop)
    controller._conversation.set_enabled(True)

    async def fake_run_ai_worker(
        _self: DesktopController,
        _fn: object,
        *_args: object,
    ) -> object:
        from vox2ai.agent import AgentDecision

        return AgentDecision(type="answer", message="hi", command=None, reason=None)

    monkeypatch.setattr(DesktopController, "_run_ai_worker", fake_run_ai_worker)

    await controller.handle_command('{"type": "submit_text_prompt", "text": "hello"}')
    await asyncio.sleep(0)

    state_events = [e for e in events if e["type"] == "conversation_state"]
    # User turn appended first, then assistant turn after streamed answer.
    assert any(e["turn_count"] == 1 for e in state_events)
    assert controller._conversation.state()["turn_count"] == 2


@pytest.mark.asyncio
async def test_capabilities_report_portal_capture_for_auto() -> None:
    config = AppConfig()
    config.context.screen_context_enabled = True
    config.context.screen_capture_method = "auto"
    controller = DesktopController(config)
    events: list[dict] = []
    loop = asyncio.get_running_loop()
    controller.set_broadcast(_broadcast_capture(events), loop)

    await controller.handle_command('{"type": "get_capabilities"}')
    await asyncio.sleep(0)

    cap_events = [e for e in events if e["type"] == "capabilities"]
    assert cap_events
    screen = cap_events[0]["screen"]
    assert screen.get("capture_method") == "xdg-desktop-portal"
    assert "portal_available" in screen


@pytest.mark.asyncio
async def test_capture_screen_context_uses_portal(monkeypatch: pytest.MonkeyPatch) -> None:
    config = AppConfig()
    config.context.screen_context_enabled = True
    controller = DesktopController(config)
    events: list[dict] = []
    loop = asyncio.get_running_loop()
    controller.set_broadcast(_broadcast_capture(events), loop)

    image = Path("/tmp/vox2ai-test-portal.png")
    _make_minimal_png(image)

    async def fake_capture(*_args: object, **_kwargs: object):
        from vox2ai.screen_context import CapturedScreen

        return CapturedScreen(
            image_path=image,
            mime_type="image/png",
            width=1,
            height=1,
            method="xdg-desktop-portal",
        )

    monkeypatch.setattr("vox2ai.desktop_server.capture_screen", fake_capture)

    try:
        await controller.handle_command('{"type": "capture_screen_context", "mode": "ocr"}')
        await asyncio.sleep(0)

        started = [e for e in events if e["type"] == "screen_capture_started"]
        assert started and started[0]["method"] == "xdg-desktop-portal"
        ready_events = [e for e in events if e["type"] == "screen_context_ready"]
        assert len(ready_events) == 1
        assert ready_events[0]["context_id"]
        assert ready_events[0]["mode"] == "ocr"
    finally:
        image.unlink(missing_ok=True)


@pytest.mark.asyncio
async def test_capture_screen_context_with_extension_image_path() -> None:
    config = AppConfig()
    config.context.screen_context_enabled = True
    controller = DesktopController(config)
    events: list[dict] = []
    loop = asyncio.get_running_loop()
    controller.set_broadcast(_broadcast_capture(events), loop)

    image = Path("/tmp/vox2ai-test-screen.png")
    _make_minimal_png(image)

    try:
        await controller.handle_command(
            '{"type": "capture_screen_context", "mode": "ocr", "image_path": "' + str(image) + '"}'
        )
        await asyncio.sleep(0)

        ready_events = [e for e in events if e["type"] == "screen_context_ready"]
        assert len(ready_events) == 1
        assert ready_events[0]["context_id"]
        assert ready_events[0]["mode"] == "ocr"
    finally:
        image.unlink(missing_ok=True)


@pytest.mark.asyncio
async def test_capture_screen_context_rejects_unsafe_image_path() -> None:
    config = AppConfig()
    config.context.screen_context_enabled = True
    controller = DesktopController(config)
    events: list[dict] = []
    loop = asyncio.get_running_loop()
    controller.set_broadcast(_broadcast_capture(events), loop)

    await controller.handle_command(
        '{"type": "capture_screen_context", "mode": "ocr", "image_path": "/etc/passwd"}'
    )
    await asyncio.sleep(0)

    error_events = [e for e in events if e["type"] == "screen_context_error"]
    assert len(error_events) == 1
    assert "temporary" in error_events[0]["message"].lower()
