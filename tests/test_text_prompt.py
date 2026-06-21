"""Tests for typed text prompt flow — no microphone, GUI, or API required."""

from __future__ import annotations

import pytest

from vox2ai.agent import AgentDecision
from vox2ai.config import AppConfig
from vox2ai.desktop_protocol import (
    CancelCurrentOperationCommand,
    SubmitTextPromptCommand,
    parse_command,
)
from vox2ai.desktop_server import DesktopController, ServerState


@pytest.mark.asyncio
async def test_submit_text_prompt_emits_transcript(monkeypatch: pytest.MonkeyPatch) -> None:
    import asyncio

    config = AppConfig()
    controller = DesktopController(config)
    events: list[dict] = []
    loop = asyncio.get_running_loop()

    def broadcast(event: object) -> None:
        events.append(
            {
                "type": getattr(event, "type", None),
                "text": getattr(event, "text", None),
                "source": getattr(event, "source", None),
            }
        )

    controller.set_broadcast(broadcast, loop)

    async def fake_process_prompt(
        self: DesktopController,
        _prompt: str,
        generation: int,
        _context: dict[str, object] | None = None,
    ) -> None:
        self._done_out(generation)

    monkeypatch.setattr(DesktopController, "_process_user_prompt", fake_process_prompt)

    await controller.handle_command('{"type": "submit_text_prompt", "text": "hello world"}')
    await asyncio.sleep(0)

    transcript_events = [e for e in events if e["type"] == "transcript"]
    assert len(transcript_events) == 1
    assert transcript_events[0]["text"] == "hello world"
    assert transcript_events[0]["source"] == "text"


@pytest.mark.asyncio
async def test_submit_text_prompt_rejects_empty() -> None:
    import asyncio

    config = AppConfig()
    controller = DesktopController(config)
    events: list[dict] = []
    loop = asyncio.get_running_loop()

    def broadcast(event: object) -> None:
        events.append({"type": getattr(event, "type", None)})

    controller.set_broadcast(broadcast, loop)

    await controller.handle_command('{"type": "submit_text_prompt", "text": "  "}')
    await asyncio.sleep(0)
    transcript_events = [e for e in events if e["type"] == "transcript"]
    assert len(transcript_events) == 0


@pytest.mark.asyncio
async def test_submit_text_prompt_rejects_when_busy() -> None:
    import asyncio

    config = AppConfig()
    controller = DesktopController(config)
    events: list[dict] = []
    loop = asyncio.get_running_loop()

    def broadcast(event: object) -> None:
        events.append({"type": getattr(event, "type", None)})

    controller.set_broadcast(broadcast, loop)

    # Set controller into a busy state.
    controller._state = ServerState.LISTENING

    await controller.handle_command('{"type": "submit_text_prompt", "text": "hello"}')
    await asyncio.sleep(0)
    error_events = [e for e in events if e["type"] == "error"]
    assert len(error_events) >= 1


@pytest.mark.asyncio
async def test_submit_text_prompt_can_produce_command_decision(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import asyncio

    config = AppConfig()
    controller = DesktopController(config)
    events: list[dict] = []
    loop = asyncio.get_running_loop()

    def broadcast(event: object) -> None:
        events.append({"type": getattr(event, "type", None)})

    controller.set_broadcast(broadcast, loop)

    decision = AgentDecision(
        type="command",
        message="Running command",
        command="git status",
        reason="Check repo",
    )

    async def fake_process_prompt(
        self: DesktopController,
        _prompt: str,
        generation: int,
        _context: dict[str, object] | None = None,
    ) -> None:
        await self._handle_decision(decision, generation)

    monkeypatch.setattr(DesktopController, "_process_user_prompt", fake_process_prompt)

    await controller.handle_command('{"type": "submit_text_prompt", "text": "check git"}')
    await asyncio.sleep(0)

    approval_events = [e for e in events if e["type"] == "command_approval"]
    assert len(approval_events) >= 1


@pytest.mark.asyncio
async def test_blocked_command_decision_streams_explanation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import asyncio

    config = AppConfig()
    controller = DesktopController(config)
    events: list[dict] = []
    loop = asyncio.get_running_loop()

    def broadcast(event: object) -> None:
        events.append(
            {
                "type": getattr(event, "type", None),
                "text": getattr(event, "text", None),
                "state": getattr(event, "state", None),
                "message": getattr(event, "message", None),
            }
        )

    controller.set_broadcast(broadcast, loop)

    decision = AgentDecision(
        type="command",
        message="Para atualizar o Fedora, use dnf upgrade.",
        command="sudo dnf upgrade --refresh",
        reason="Atualizar pacotes do sistema",
    )

    async def fake_process_prompt(
        self: DesktopController,
        _prompt: str,
        generation: int,
        _context: dict[str, object] | None = None,
    ) -> None:
        await self._handle_decision(decision, generation)

    monkeypatch.setattr(DesktopController, "_process_user_prompt", fake_process_prompt)

    await controller.handle_command(
        '{"type": "submit_text_prompt", "text": "como atualizar meu fedora?"}'
    )
    await asyncio.sleep(0)

    streamed_text = "".join(str(e["text"] or "") for e in events if e["type"] == "answer_delta")
    assert any(e["type"] == "answer_start" for e in events)
    assert any(e["type"] == "answer_done" for e in events)
    assert not any(e["type"] == "error" for e in events)
    assert "Para atualizar o Fedora" in streamed_text
    assert "I did not run `sudo dnf upgrade --refresh`" in streamed_text
    assert events[-1]["state"] == "ready"


def test_submit_text_prompt_protocol_parse() -> None:
    result = parse_command('{"type": "submit_text_prompt", "text": "hello"}')
    assert isinstance(result, SubmitTextPromptCommand)
    assert result.text == "hello"


def test_submit_text_prompt_allows_empty_text_in_protocol() -> None:
    result = parse_command('{"type": "submit_text_prompt", "text": ""}')
    assert isinstance(result, SubmitTextPromptCommand)
    assert result.text == ""


def test_cancel_current_operation_protocol_parse() -> None:
    result = parse_command('{"type": "cancel_current_operation"}')
    assert isinstance(result, CancelCurrentOperationCommand)


def test_transcript_event_default_source_is_voice() -> None:
    from vox2ai.desktop_protocol import TranscriptEvent

    ev = TranscriptEvent(text="test")
    assert ev.source == "voice"
    assert ev.raw_text is None
