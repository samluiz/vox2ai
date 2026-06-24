from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import Any

import pytest

from vox2ai.agent import AgentDecision
from vox2ai.capabilities import build_capabilities
from vox2ai.commands import classify_command_risk, describe_command_effect
from vox2ai.config import AppConfig
from vox2ai.conversation import ConversationMemory
from vox2ai.desktop_server import (
    DesktopController,
    ServerState,
    _format_prompt_context,
    _normalize_audio_level,
    _ocr_language,
)
from vox2ai.errors import Vox2AIError
from vox2ai.recorder import AudioLevel
from vox2ai.screen_context import CapturedScreen, OcrResult
from vox2ai.secrets import FallbackStore, set_secret_store
from vox2ai.settings import api_key_configured, sanitize_config


def test_product_phase_config_defaults() -> None:
    cfg = AppConfig()
    assert cfg.general.minimize_to_tray is True
    assert cfg.general.start_hidden is True
    assert cfg.general.start_at_login is False
    assert cfg.activation.global_shortcut == "Ctrl+Space"
    assert cfg.activation.shortcut_behavior == "show-and-record"
    assert cfg.voice.input_device == ""
    assert cfg.voice.auto_finish_enabled is True
    assert cfg.voice.silence_timeout_ms == 2000
    assert cfg.voice.min_recording_ms == 700
    assert cfg.voice.max_recording_ms == 60000
    assert cfg.voice.voice_activity_threshold == 0.025
    assert cfg.onboarding.completed is False
    assert cfg.conversation.enabled is False
    assert cfg.conversation.max_turns == 8
    assert cfg.conversation.max_messages == 16
    assert cfg.context.clipboard_enabled is True
    assert cfg.context.clipboard_auto_detect is True
    assert cfg.context.max_clipboard_chars == 8000
    assert cfg.context.active_window_enabled is True
    assert cfg.context.selected_text_enabled is False
    assert cfg.context.screen_context_enabled is True
    assert cfg.history.enabled is True
    assert cfg.history.persist is False
    assert cfg.notifications.enabled is True
    assert cfg.model_profiles.active == "fast"
    assert cfg.model_profiles.profiles["vision"].supports_vision is True
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


def test_audio_level_normalization_uses_recording_threshold() -> None:
    assert _normalize_audio_level(0.0009, 0.003) == 0.0
    assert _normalize_audio_level(0.003, 0.003) == 0.0
    assert 0.0 < _normalize_audio_level(0.006, 0.003) < 1.0
    assert _normalize_audio_level(0.1, 0.003) == 1.0


def test_ocr_language_mapping() -> None:
    assert _ocr_language("pt") == "por"
    assert _ocr_language("pt-BR") == "por"
    assert _ocr_language("es") == "spa"
    assert _ocr_language("en") == "eng"


@pytest.mark.asyncio
async def test_model_profiles_event_and_switch(monkeypatch: pytest.MonkeyPatch) -> None:
    cfg = AppConfig()
    monkeypatch.setattr("vox2ai.desktop_server.save_config", lambda _cfg: None)
    controller = DesktopController(cfg)
    events: list[Any] = []
    controller.set_broadcast(events.append, asyncio.get_running_loop())

    await controller.handle_command('{"type": "get_model_profiles"}')
    await asyncio.sleep(0)
    profiles = events[-1]
    assert profiles.type == "model_profiles"
    assert profiles.active == "fast"
    assert any(p["id"] == "vision" and p["supports_vision"] for p in profiles.profiles)

    await controller.handle_command('{"type": "set_model_profile", "profile": "smart"}')
    await asyncio.sleep(0)
    assert cfg.model_profiles.active == "smart"
    assert any(event.type == "model_profile_set" and event.active == "smart" for event in events)


@pytest.mark.asyncio
async def test_voice_activity_auto_stops_after_speech_and_silence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cfg = AppConfig()
    cfg.voice.auto_finish_enabled = True
    cfg.voice.silence_timeout_ms = 200
    cfg.voice.min_recording_ms = 100
    cfg.voice.voice_activity_threshold = 0.02
    controller = DesktopController(cfg)
    events: list[Any] = []
    stops: list[tuple[str, int]] = []
    controller.set_broadcast(events.append, asyncio.get_running_loop())
    controller._state = ServerState.LISTENING
    controller._operation_generation = 4
    controller._recording_started_at = time.monotonic() - 1.0

    async def fake_finish_recording(
        _self: DesktopController,
        reason: str,
        generation: int,
    ) -> None:
        stops.append((reason, generation))

    monkeypatch.setattr(DesktopController, "_finish_recording", fake_finish_recording)

    controller._handle_recording_audio_level(AudioLevel(rms=0.05, peak=0.08), 4)
    controller._last_voice_at = time.monotonic() - 0.25
    controller._handle_recording_audio_level(AudioLevel(rms=0.001, peak=0.002), 4)
    await asyncio.sleep(0.05)

    assert any(event.type == "voice_activity" for event in events)
    auto_event = next(event for event in events if event.type == "recording_auto_stopping")
    assert auto_event.reason == "silence"
    assert stops == [("auto_silence", 4)]


@pytest.mark.asyncio
async def test_voice_activity_waits_for_speech_before_auto_stop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cfg = AppConfig()
    cfg.voice.auto_finish_enabled = True
    cfg.voice.silence_timeout_ms = 100
    cfg.voice.min_recording_ms = 100
    cfg.voice.speech_start_required = True
    cfg.voice.voice_activity_threshold = 0.02
    controller = DesktopController(cfg)
    events: list[Any] = []
    stops: list[tuple[str, int]] = []
    controller.set_broadcast(events.append, asyncio.get_running_loop())
    controller._state = ServerState.LISTENING
    controller._operation_generation = 5
    controller._recording_started_at = time.monotonic() - 1.0

    async def fake_finish_recording(
        _self: DesktopController,
        reason: str,
        generation: int,
    ) -> None:
        stops.append((reason, generation))

    monkeypatch.setattr(DesktopController, "_finish_recording", fake_finish_recording)

    controller._handle_recording_audio_level(AudioLevel(rms=0.001, peak=0.002), 5)
    await asyncio.sleep(0.05)

    assert not any(event.type == "recording_auto_stopping" for event in events)
    assert stops == []


def test_config_file_api_key_counts_as_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    set_secret_store(FallbackStore())
    try:
        monkeypatch.delenv("VOX2AI_TEST_CONFIG_ONLY_KEY", raising=False)
        cfg = AppConfig()
        cfg.assistant.api_key_env = "VOX2AI_TEST_CONFIG_ONLY_KEY"
        cfg.assistant.api_key = "sk-config-secret"

        sanitized = sanitize_config(cfg)

        assert api_key_configured(cfg) is True
        assert sanitized["assistant"]["api_key_configured"] is True
        assert sanitized["assistant"]["api_key_preview"] == "sk-c…cret"
        assert "sk-config-secret" not in str(sanitized)
    finally:
        set_secret_store(FallbackStore())


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
        assert diagnostics["provider"]["api_key_present"] is True
    finally:
        set_secret_store(FallbackStore())


@pytest.mark.asyncio
async def test_conversation_context_is_bounded_and_clearable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cfg = AppConfig()
    cfg.conversation.enabled = True
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

    assert len(controller._conversation.turns) == 2
    assert "Recent conversation in this app session:" in captured_prompts[-1]
    assert "Clipboard context:" in captured_prompts[-1]

    await controller.handle_command('{"type": "clear_conversation"}')
    await asyncio.sleep(0)
    assert controller._conversation.turns == []
    assert any(event.type == "conversation_cleared" for event in events)


def test_conversation_memory_prompt_and_clear() -> None:
    memory = ConversationMemory(enabled=True, max_turns=1)
    memory.append("user", "In this test, my project name is Banana.")
    memory.append("assistant", "Got it.")
    memory.append("user", "What is my project name?")
    prompt = memory.prompt_context()
    assert "What is my project name?" in prompt
    assert "Banana" not in prompt
    memory.clear()
    assert memory.state()["turn_count"] == 0


def test_capabilities_reflect_missing_ocr(monkeypatch: pytest.MonkeyPatch) -> None:
    cfg = AppConfig()

    def fake_which(name: str) -> bool:
        return name == "gnome-screenshot"

    monkeypatch.setattr("vox2ai.screen_context._which", fake_which)
    monkeypatch.setattr("vox2ai.capabilities.list_input_devices", lambda: [{"id": "0"}])
    payload = build_capabilities(
        cfg,
        conversation={"enabled": False, "turn_count": 0, "max_turns": 8},
    )
    assert payload["capabilities"]["screen_capture"]["available"] is True
    assert payload["capabilities"]["ocr"]["available"] is False


def test_capabilities_reflect_missing_vision_model(monkeypatch: pytest.MonkeyPatch) -> None:
    cfg = AppConfig()
    cfg.model_profiles.profiles["fast"].supports_vision = False
    monkeypatch.setattr("vox2ai.screen_context._which", lambda _name: True)
    monkeypatch.setattr("vox2ai.capabilities.list_input_devices", lambda: [{"id": "0"}])
    payload = build_capabilities(
        cfg,
        conversation={"enabled": False, "turn_count": 0, "max_turns": 8},
    )
    assert payload["capabilities"]["vision"]["available"] is False
    assert "not marked as vision-capable" in payload["capabilities"]["vision"]["reason"]


def test_capabilities_reflect_audio_input_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    cfg = AppConfig()

    def fail_devices() -> list[dict[str, object]]:
        raise RuntimeError("no input")

    monkeypatch.setattr("vox2ai.capabilities.list_input_devices", fail_devices)
    payload = build_capabilities(
        cfg,
        conversation={"enabled": False, "turn_count": 0, "max_turns": 8},
    )
    assert payload["capabilities"]["voice_prompt"]["available"] is False
    assert payload["audio"]["input_available"] is False


@pytest.mark.asyncio
async def test_get_capabilities_event(monkeypatch: pytest.MonkeyPatch) -> None:
    cfg = AppConfig()
    monkeypatch.setattr("vox2ai.capabilities.list_input_devices", lambda: [{"id": "0"}])
    controller = DesktopController(cfg)
    events: list[Any] = []
    controller.set_broadcast(events.append, asyncio.get_running_loop())

    await controller.handle_command('{"type": "get_capabilities"}')
    await asyncio.sleep(0)

    event = events[-1]
    assert event.type == "capabilities"
    assert event.capabilities["text_prompt"]["available"] is True


@pytest.mark.asyncio
async def test_conversation_state_event() -> None:
    cfg = AppConfig()
    controller = DesktopController(cfg)
    events: list[Any] = []
    controller.set_broadcast(events.append, asyncio.get_running_loop())

    await controller.handle_command('{"type": "set_conversation_mode", "enabled": true}')
    await asyncio.sleep(0)
    state = next(event for event in events if event.type == "conversation_state")
    assert state.enabled is True
    assert state.turn_count == 0


@pytest.mark.asyncio
async def test_screen_flow_chooses_vision_when_active_model_supports_vision(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    cfg = AppConfig()
    cfg.model_profiles.profiles["fast"].supports_vision = True
    image = tmp_path / "screen.png"
    image.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\0" * 16)

    async def fake_capture(_cfg: AppConfig) -> CapturedScreen:
        return CapturedScreen(image, "image/png", 100, 80, "test")

    monkeypatch.setattr("vox2ai.desktop_server.capture_screen", fake_capture)
    controller = DesktopController(cfg)
    events: list[Any] = []
    controller.set_broadcast(events.append, asyncio.get_running_loop())

    context_id = await controller._capture_screen_context("auto")
    await asyncio.sleep(0)

    assert context_id is not None
    assert controller._screen_contexts[context_id]["mode"] == "vision"
    assert any(event.type == "screen_context_ready" and event.mode == "vision" for event in events)


@pytest.mark.asyncio
async def test_screen_flow_chooses_ocr_when_vision_unavailable(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    cfg = AppConfig()
    cfg.model_profiles.profiles["fast"].supports_vision = False
    image = tmp_path / "screen.png"
    image.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\0" * 16)

    async def fake_capture(_cfg: AppConfig) -> CapturedScreen:
        return CapturedScreen(image, "image/png", 100, 80, "test")

    monkeypatch.setattr("vox2ai.desktop_server.capture_screen", fake_capture)
    monkeypatch.setattr(
        "vox2ai.desktop_server.ocr_screen",
        lambda _path, _cfg: OcrResult("visible text", 0.0, "tesseract", "eng"),
    )
    controller = DesktopController(cfg)
    events: list[Any] = []
    controller.set_broadcast(events.append, asyncio.get_running_loop())

    context_id = await controller._capture_screen_context("auto")
    await asyncio.sleep(0)

    assert context_id is not None
    assert controller._screen_contexts[context_id]["mode"] == "ocr"
    assert any(event.type == "screen_ocr_done" for event in events)


@pytest.mark.asyncio
async def test_screen_flow_accepts_frontend_captured_tmp_file(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    cfg = AppConfig()
    cfg.model_profiles.profiles["fast"].supports_vision = False
    image = tmp_path / "frontend-screen.png"
    image.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\0" * 16)
    monkeypatch.setattr(
        "vox2ai.desktop_server.ocr_screen",
        lambda _path, _cfg: OcrResult("visible text", 0.0, "tesseract", "eng"),
    )
    controller = DesktopController(cfg)
    events: list[Any] = []
    controller.set_broadcast(events.append, asyncio.get_running_loop())

    await controller.handle_command(
        '{"type": "capture_screen_context", "mode": "auto", '
        f'"image_path": "{image}", "method": "gnome-shell"}}'
    )
    await asyncio.sleep(0)

    assert any(event.type == "screen_context_ready" and event.mode == "ocr" for event in events)


@pytest.mark.asyncio
async def test_screen_flow_errors_when_neither_vision_nor_ocr_available(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    cfg = AppConfig()
    cfg.model_profiles.profiles["fast"].supports_vision = False
    image = tmp_path / "screen.png"
    image.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\0" * 16)

    async def fake_capture(_cfg: AppConfig) -> CapturedScreen:
        return CapturedScreen(image, "image/png", 100, 80, "test")

    monkeypatch.setattr("vox2ai.desktop_server.capture_screen", fake_capture)
    monkeypatch.setattr(
        "vox2ai.desktop_server.ocr_screen",
        lambda _path, _cfg: Vox2AIError("OCR is unavailable. Install tesseract."),
    )
    controller = DesktopController(cfg)
    events: list[Any] = []
    controller.set_broadcast(events.append, asyncio.get_running_loop())

    context_id = await controller._capture_screen_context("auto")
    await asyncio.sleep(0)

    assert context_id is None
    error = next(event for event in events if event.type == "screen_context_error")
    assert "OCR is unavailable" in error.message


@pytest.mark.asyncio
async def test_ai_worker_timeout_returns_error(monkeypatch: pytest.MonkeyPatch) -> None:
    cfg = AppConfig()
    cfg.assistant.timeout_seconds = 0.01
    controller = DesktopController(cfg)

    async def fake_wait_for(awaitable: Any, timeout: float) -> object:
        _ = timeout
        awaitable.cancel()
        raise TimeoutError

    monkeypatch.setattr("vox2ai.desktop_server.asyncio.wait_for", fake_wait_for)

    result = await controller._run_ai_worker(lambda: "too late")

    assert isinstance(result, Vox2AIError)
    assert "timed out" in str(result)


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
