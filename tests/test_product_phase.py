from __future__ import annotations

import asyncio
from typing import Any

import pytest

from vox2ai.agent import AgentDecision
from vox2ai.commands import classify_command_risk, describe_command_effect
from vox2ai.config import AppConfig
from vox2ai.desktop_server import DesktopController, _format_prompt_context
from vox2ai.secrets import FallbackStore, set_secret_store


def test_product_phase_config_defaults() -> None:
    cfg = AppConfig()
    assert cfg.general.minimize_to_tray is True
    assert cfg.general.start_hidden is True
    assert cfg.general.start_at_login is False
    assert cfg.activation.global_shortcut == "Ctrl+Space"
    assert cfg.activation.shortcut_behavior == "show-and-record"
    assert cfg.onboarding.completed is False
    assert cfg.conversation.enabled is True
    assert cfg.conversation.max_messages == 10
    assert cfg.context.clipboard_enabled is True
    assert cfg.context.clipboard_auto_detect is True
    assert cfg.context.max_clipboard_chars == 8000
    assert cfg.context.active_window_enabled is True
    assert cfg.context.selected_text_enabled is False
    assert cfg.quick_actions.enabled is True
    assert cfg.commands.show_risk_level is True


def test_prompt_context_labels_and_truncates_clipboard() -> None:
    formatted = _format_prompt_context(
        {
            "clipboard": "abcdef",
            "active_window": {"app": "Ghostty", "title": "project terminal"},
        },
        3,
    )
    assert "Clipboard context:" in formatted
    assert "abc" in formatted
    assert "[clipboard truncated]" in formatted
    assert "Active window context:" in formatted
    assert "Ghostty" in formatted


def test_command_risk_classifier() -> None:
    assert classify_command_risk("ls -la") == "low"
    assert classify_command_risk("sudo dnf upgrade --refresh") == "medium"
    assert classify_command_risk("rm -rf /tmp/example") == "high"
    assert "Updates installed system packages" in describe_command_effect("sudo dnf upgrade")


@pytest.mark.asyncio
async def test_diagnostics_payload_sanitizes_secret() -> None:
    set_secret_store(FallbackStore({"api_key": "sk-secret-value"}))
    try:
        cfg = AppConfig()
        controller = DesktopController(cfg)
        events: list[Any] = []
        controller.set_broadcast(events.append, asyncio.get_running_loop())

        await controller.handle_command('{"type": "get_diagnostics"}')
        await asyncio.sleep(0)
        diagnostics = events[-1].diagnostics
        serialized = str(diagnostics)
        assert "sk-secret-value" not in serialized
        assert diagnostics["provider"]["api_key"] == "configured"
    finally:
        set_secret_store(FallbackStore())


@pytest.mark.asyncio
async def test_conversation_context_is_bounded_and_clearable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cfg = AppConfig()
    cfg.conversation.max_messages = 2
    controller = DesktopController(cfg)
    events: list[Any] = []
    captured_prompts: list[str] = []
    controller.set_broadcast(events.append, asyncio.get_running_loop())

    async def fake_process_prompt(
        self: DesktopController,
        prompt: str,
        generation: int,
        context: dict[str, object] | None = None,
    ) -> None:
        self._append_conversation("user", prompt)
        captured_prompts.append(self._build_prompt(prompt, context))
        await self._handle_decision(
            AgentDecision(type="answer", message="ok", command=None, reason=None),
            generation,
        )

    monkeypatch.setattr(DesktopController, "_process_user_prompt", fake_process_prompt)

    await controller.handle_command('{"type": "submit_text_prompt", "text": "first"}')
    await asyncio.sleep(0)
    await controller.handle_command('{"type": "submit_text_prompt", "text": "second"}')
    await asyncio.sleep(0)
    await controller.handle_command(
        '{"type": "submit_text_prompt", "text": "now use clipboard", '
        '"context": {"clipboard": "clip"}}'
    )
    await asyncio.sleep(0)

    assert len(controller._conversation) == 2
    assert "Recent conversation in this app session:" in captured_prompts[-1]
    assert "Clipboard context:" in captured_prompts[-1]

    await controller.handle_command('{"type": "clear_conversation"}')
    await asyncio.sleep(0)
    assert controller._conversation == []
    assert any(event.type == "conversation_cleared" for event in events)


@pytest.mark.asyncio
async def test_command_approval_event_includes_risk_metadata(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cfg = AppConfig()
    controller = DesktopController(cfg)
    events: list[Any] = []
    controller.set_broadcast(events.append, asyncio.get_running_loop())

    decision = AgentDecision(
        type="command",
        message="Check files",
        command="ls -la",
        reason="List current files",
    )

    async def fake_process_prompt(
        self: DesktopController,
        prompt: str,
        generation: int,
        _context: dict[str, object] | None = None,
    ) -> None:
        self._append_conversation("user", prompt)
        await self._handle_decision(decision, generation)

    monkeypatch.setattr(DesktopController, "_process_user_prompt", fake_process_prompt)

    await controller.handle_command('{"type": "submit_text_prompt", "text": "list files"}')
    await asyncio.sleep(0)
    approval = next(event for event in events if event.type == "command_approval")
    assert approval.risk == "low"
    assert approval.working_directory
    assert "Lists files" in approval.expected_effect


@pytest.mark.asyncio
async def test_high_risk_command_requires_approval_even_in_allow_all(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cfg = AppConfig()
    cfg.commands.mode = "allow-all"
    cfg.commands.blocked_patterns = []
    controller = DesktopController(cfg)
    events: list[Any] = []
    controller.set_broadcast(events.append, asyncio.get_running_loop())

    decision = AgentDecision(
        type="command",
        message="Dangerous cleanup",
        command="rm -rf ./build",
        reason="Remove build output",
    )

    async def fake_process_prompt(
        self: DesktopController,
        prompt: str,
        generation: int,
        _context: dict[str, object] | None = None,
    ) -> None:
        self._append_conversation("user", prompt)
        await self._handle_decision(decision, generation)

    monkeypatch.setattr(DesktopController, "_process_user_prompt", fake_process_prompt)

    await controller.handle_command('{"type": "submit_text_prompt", "text": "clean build"}')
    await asyncio.sleep(0)
    approval = next(event for event in events if event.type == "command_approval")
    assert approval.risk == "high"
