from __future__ import annotations

import asyncio
import contextlib
import copy
import logging
import os
import shutil
import subprocess
import tempfile
import time
import uuid
from collections.abc import Callable
from enum import Enum
from pathlib import Path
from typing import Any

from vox2ai.agent import AgentDecision, parse_agent_decision
from vox2ai.commands import (
    CommandResult,
    classify_command_risk,
    describe_command_effect,
    is_blocked,
    requires_approval,
    run_command,
)
from vox2ai.config import AppConfig, AssistantConfig, load_config, save_config
from vox2ai.credentials import resolve_api_key
from vox2ai.desktop_protocol import (
    AnswerDeltaEvent,
    AnswerDoneEvent,
    AnswerStartEvent,
    AskAboutScreenCommand,
    AudioLevelEvent,
    BackendEvent,
    BackendStatusEvent,
    CaptureScreenContextCommand,
    CommandApprovalEvent,
    CommandResultEvent,
    CommandRunningEvent,
    ContextPreviewEvent,
    ConversationClearedEvent,
    DiagnosticsEvent,
    ErrorEvent,
    ExplainCommandCommand,
    HelloEvent,
    ListProviderModelsCommand,
    ModelProfileSetEvent,
    ModelProfilesEvent,
    OperationCancelledEvent,
    PartialTranscriptEvent,
    ProviderModelsErrorEvent,
    ProviderModelsEvent,
    ProviderTestResultEvent,
    RecordingAutoStoppingEvent,
    RecordingStoppedEvent,
    RequestCommandApprovalCommand,
    ScreenCaptureDoneEvent,
    ScreenCaptureStartedEvent,
    ScreenContextErrorEvent,
    ScreenContextReadyEvent,
    ScreenContextStartedEvent,
    ScreenOcrDoneEvent,
    SetConversationModeCommand,
    SetModelProfileCommand,
    SettingsErrorEvent,
    SettingsEvent,
    SettingsSavedEvent,
    StateEvent,
    SubmitScreenQuestionCommand,
    SubmitTextPromptCommand,
    TestProviderCommand,
    TimingEvent,
    TranscriptEvent,
    UpdateSettingsCommand,
    VoiceActivityEvent,
    parse_command,
    serialize_event,
)
from vox2ai.errors import AudioError, Vox2AIError
from vox2ai.llm import LLMClient
from vox2ai.partial_transcriber import LocalPartialTranscriber, PartialTranscript
from vox2ai.prompts import COMMAND_AGENT_SYSTEM_PROMPT, COMMAND_RESULT_PROMPT
from vox2ai.providers import create_adapter
from vox2ai.recorder import StreamingRecorder
from vox2ai.secrets import get_secret_store
from vox2ai.settings import api_key_configured, needs_setup, sanitize_config
from vox2ai.stt import transcribe_audio
from vox2ai.timing import Timer
from vox2ai.transcript import build_initial_prompt
from vox2ai.vocabulary import build_vocabulary_context


class ServerState(Enum):
    READY = "ready"
    LISTENING = "listening"
    TRANSCRIBING = "transcribing"
    THINKING = "thinking"
    STREAMING_ANSWER = "streaming_answer"
    APPROVAL_REQUIRED = "approval_required"
    RUNNING_COMMAND = "running_command"
    DONE = "done"
    ERROR = "error"


_STATES_DISALLOWING_RECORD = {
    ServerState.LISTENING,
    ServerState.TRANSCRIBING,
    ServerState.THINKING,
    ServerState.STREAMING_ANSWER,
    ServerState.APPROVAL_REQUIRED,
    ServerState.RUNNING_COMMAND,
}


class DesktopController:
    """Owns state, recorder, config, LLM, and command execution.

    All long-running work (STT, LLM, commands) runs in executor threads
    so the WebSocket event loop stays responsive.
    """

    def __init__(self, config: AppConfig) -> None:
        self._config = config
        self._state = ServerState.READY
        self._recorder: StreamingRecorder | None = None
        self._pending_decision: AgentDecision | None = None
        self._busy_lock = asyncio.Lock()
        self._broadcast: Callable[[BackendEvent], None] | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._timer = Timer()
        self._partial_task: asyncio.Task[object] | None = None
        self._partial_transcriber: LocalPartialTranscriber | None = None
        self._recording_generation = 0
        self._operation_generation = 0
        self._last_cmd: object | None = None
        self._conversation: list[dict[str, str]] = []
        self._recording_started_at: float = 0.0
        self._speech_started = False
        self._voice_active = False
        self._last_voice_at: float | None = None
        self._last_voice_activity_emit_at: float = 0.0
        self._auto_stop_requested = False
        self._last_voice_activity: dict[str, Any] = {"state": "unknown"}
        self._conversation_mode = config.conversation.enabled
        self._screen_contexts: dict[str, dict[str, Any]] = {}
        self._last_screen_error: str | None = None
        self._llm_client = LLMClient(self._active_assistant_config())

    def set_broadcast(
        self, fn: Callable[[BackendEvent], None], loop: asyncio.AbstractEventLoop
    ) -> None:
        self._broadcast = fn
        self._loop = loop

    def _send(self, event: BackendEvent) -> None:
        if self._broadcast and self._loop:
            self._loop.call_soon_threadsafe(self._broadcast, event)

    def _send_state(self, state: str, message: str) -> None:
        self._send(StateEvent(state=state, message=message))

    def _send_partial(self, text: str) -> None:
        self._send(PartialTranscriptEvent(text=text, stable=False))

    def _append_conversation(self, role: str, content: str) -> None:
        if not self._conversation_mode:
            return
        text = content.strip()
        if not text:
            return
        self._conversation.append({"role": role, "content": text})
        max_messages = min(
            self._config.conversation.max_messages,
            self._config.conversation.max_turns * 2,
        )
        if len(self._conversation) > max_messages:
            self._conversation = self._conversation[-max_messages:]

    def _build_prompt(self, user_text: str, context: dict[str, Any] | None = None) -> str:
        parts: list[str] = []
        if self._conversation_mode and self._conversation:
            lines = ["Recent conversation in this app session:"]
            max_messages = min(
                self._config.conversation.max_messages,
                self._config.conversation.max_turns * 2,
            )
            for item in self._conversation[-max_messages:]:
                role = "User" if item.get("role") == "user" else "Assistant"
                lines.append(f"{role}: {item.get('content', '')}")
            parts.append("\n".join(lines))

        context_parts = _format_prompt_context(
            context or {},
            self._config.context.max_clipboard_chars,
        )
        if context_parts:
            parts.append(context_parts)

        parts.append(f"User request:\n{user_text}")
        return "\n\n".join(parts)

    def _active_assistant_config(self) -> AssistantConfig:
        profile = self._config.model_profiles.profiles.get(self._config.model_profiles.active)
        if profile is None:
            return self._config.assistant

        assistant = copy.deepcopy(self._config.assistant)
        if profile.provider:
            assistant.provider = profile.provider
        if profile.base_url:
            assistant.base_url = profile.base_url
        if profile.api_key_env:
            assistant.api_key_env = profile.api_key_env
        if profile.model:
            assistant.model = profile.model
        return assistant

    def _client_for_profile(self, profile_id: str | None = None) -> LLMClient:
        if profile_id is None or profile_id == self._config.model_profiles.active:
            return self._llm_client

        original = self._config.model_profiles.active
        self._config.model_profiles.active = profile_id
        try:
            return LLMClient(self._active_assistant_config())
        finally:
            self._config.model_profiles.active = original

    def _active_profile_supports_vision(self) -> bool:
        profile = self._config.model_profiles.profiles.get(self._config.model_profiles.active)
        return bool(profile and profile.supports_vision)

    def _vision_profile_id(self) -> str | None:
        if self._active_profile_supports_vision():
            return self._config.model_profiles.active
        for pid, profile in self._config.model_profiles.profiles.items():
            if profile.supports_vision:
                return pid
        return None

    def _model_profiles_payload(self) -> ModelProfilesEvent:
        profiles = []
        for pid, profile in self._config.model_profiles.profiles.items():
            profiles.append(
                {
                    "id": pid,
                    "label": profile.label or pid.title(),
                    "provider": profile.provider or self._config.assistant.provider,
                    "model": profile.model or self._config.assistant.model,
                    "supports_vision": profile.supports_vision,
                }
            )
        return ModelProfilesEvent(profiles=profiles, active=self._config.model_profiles.active)

    def _screen_capture_method_label(self) -> str:
        if shutil.which("gnome-screenshot"):
            return "gnome-screenshot"
        return self._config.context.screen_capture_method

    def _build_diagnostics(self) -> dict[str, Any]:
        from vox2ai.config import config_path

        mic_available, mic_message = _check_microphone_available()
        cfg_path = config_path()
        log_dir = _get_log_dir()
        provider_configured = api_key_configured(self._config)
        api_key_env_val = self._config.assistant.api_key_env
        api_key_from_config = bool(self._config.assistant.api_key.strip())
        api_key_from_env = bool(os.environ.get(api_key_env_val, ""))
        api_key_from_secret = bool(get_secret_store().get("api_key"))
        if api_key_from_secret:
            api_key_source = "keyring"
        elif api_key_from_env:
            api_key_source = "env"
        elif api_key_from_config:
            api_key_source = "config"
        else:
            api_key_source = "unknown"
        return {
            "backend": {"status": "running"},
            "websocket": {"status": "connected"},
            "provider": {
                "configured": provider_configured,
                "provider": self._config.assistant.provider,
                "model": self._config.assistant.model,
                "base_url": self._config.assistant.base_url,
                "api_key_env": api_key_env_val,
                "api_key_present": provider_configured,
                "api_key_source": api_key_source,
                "active_profile": self._config.model_profiles.active,
                "model_profiles_enabled": True,
            },
            "microphone": {
                "available": mic_available,
                "message": mic_message,
                "input_device": self._config.voice.input_device or "default",
                "sample_rate": self._config.voice.sample_rate,
            },
            "shortcut": {
                "status": "configured",
                "shortcut": self._config.recording.shortcut,
                "mode": self._config.recording.activation_mode,
                "global": self._config.activation.global_shortcut,
                "behavior": self._config.activation.shortcut_behavior,
            },
            "activation": {
                "global_shortcut": self._config.activation.global_shortcut,
                "shortcut_behavior": self._config.activation.shortcut_behavior,
                "start_at_login": self._config.general.start_at_login,
                "start_hidden": self._config.general.start_hidden,
                "minimize_to_tray": self._config.general.minimize_to_tray,
            },
            "transcription": {
                "status": "ready",
                "mode": self._config.transcription.mode,
                "model": self._config.voice.whisper_model,
                "language": self._config.voice.primary_language,
                "auto_finish_enabled": self._config.voice.auto_finish_enabled,
                "silence_timeout_ms": self._config.voice.silence_timeout_ms,
                "voice_activity_threshold": self._config.voice.voice_activity_threshold,
                "last_voice_activity": self._last_voice_activity,
            },
            "conversation": {
                "enabled": self._conversation_mode,
                "messages": len(self._conversation),
                "max_turns": self._config.conversation.max_turns,
            },
            "history": {
                "enabled": self._config.history.enabled,
                "persist": self._config.history.persist,
                "count": 0,
            },
            "model_profiles": {
                "active": self._config.model_profiles.active,
                "available": list(self._config.model_profiles.profiles.keys()),
                "vision_profiles": [
                    pid
                    for pid, profile in self._config.model_profiles.profiles.items()
                    if profile.supports_vision
                ],
            },
            "screen_context": {
                "enabled": self._config.context.screen_context_enabled,
                "capture_method": self._screen_capture_method_label(),
                "capture_available": _screen_capture_available(),
                "vision_available": self._active_profile_supports_vision()
                or self._vision_profile_id() is not None,
                "ocr_available": _ocr_available(),
                "ocr_engine": "tesseract" if _ocr_available() else "",
                "last_error": self._last_screen_error,
            },
            "paths": {
                "logs": str(log_dir),
                "config": str(cfg_path),
            },
            "app": {"version": "0.1.0"},
            "backend_version": "0.1.0",
        }

    def _on_partial_result(self, generation: int, partial: PartialTranscript) -> None:
        """Handle a partial transcript result on the event loop."""
        if generation != self._recording_generation:
            return
        self._timer.stop("partial_stt")
        self._send_partial(partial.text)

    def _start_partial_loop(self) -> None:
        if self._config.transcription.mode != "local-partial":
            return
        if not self._config.transcription.partial.enabled:
            return

        self._recording_generation += 1
        generation = self._recording_generation
        partial_cfg = self._config.transcription.partial
        vocabulary = build_vocabulary_context(self._config)
        initial_prompt = build_initial_prompt(vocabulary, self._config)

        def on_partial(partial: PartialTranscript) -> None:
            if generation != self._recording_generation:
                return
            if self._loop is None:
                return
            self._loop.call_soon_threadsafe(self._on_partial_result, generation, partial)

        self._partial_transcriber = LocalPartialTranscriber(
            model_name=self._config.voice.whisper_model,
            language=self._config.voice.language,
            initial_prompt=initial_prompt,
            language_mode=self._config.voice.language_mode,
            primary_language=self._config.voice.primary_language,
            interval_ms=partial_cfg.interval_ms,
            min_audio_seconds=partial_cfg.min_audio_seconds,
            window_seconds=partial_cfg.window_seconds,
            max_partial_chars=partial_cfg.max_partial_chars,
            emit_only_on_change=partial_cfg.emit_only_on_change,
            on_partial=on_partial,
            replacements=self._config.transcription.custom_replacements,
        )

        self._partial_task = asyncio.create_task(
            self._partial_loop(generation, self._partial_transcriber)
        )

    async def _partial_loop(self, generation: int, transcriber: LocalPartialTranscriber) -> None:
        """Poll the recorder and schedule partial STT jobs while listening."""
        poll_interval = max(0.1, min(0.5, self._config.transcription.partial.interval_ms / 4000.0))
        try:
            while True:
                await asyncio.sleep(poll_interval)
                if generation != self._recording_generation:
                    return
                if self._state != ServerState.LISTENING or self._recorder is None:
                    return
                audio, sample_rate = self._recorder.snapshot_audio()
                if audio.shape[0] == 0:
                    continue
                if _audio_rms(audio) < self._config.voice.min_rms:
                    continue
                scheduled = transcriber.maybe_transcribe(audio, sample_rate)
                if scheduled:
                    self._timer.start("partial_stt")
        except asyncio.CancelledError:
            return
        except Exception as exc:
            # Partial transcription is best-effort. If the loop crashes, stop
            # partials for this session but keep recording alive.
            if self._config.debug.enabled:
                print(f"[vox2ai] Partial transcription loop error: {exc}", flush=True)

    def _stop_partial_loop(self) -> None:
        if self._partial_task is not None:
            self._partial_task.cancel()
            self._partial_task = None
        if self._partial_transcriber is not None:
            self._partial_transcriber.close()
            self._partial_transcriber = None
        self._recording_generation += 1

    # ── State machine ───────────────────────────────────────────

    async def handle_command(self, raw: str) -> None:
        cmd = parse_command(raw)
        if isinstance(cmd, ErrorEvent):
            self._send(cmd)
            return

        # Store the parsed command so handlers can access typed data.
        self._last_cmd = cmd

        handlers = {
            "start_recording": self._handle_start_recording,
            "stop_recording": self._handle_stop_recording,
            "cancel_recording": self._handle_cancel_recording,
            "cancel_current_operation": self._handle_cancel_current_operation,
            "approve_command": self._handle_approve_command,
            "deny_command": self._handle_deny_command,
            "submit_text_prompt": self._handle_submit_text_prompt,
            "get_settings": self._handle_get_settings,
            "update_settings": self._handle_update_settings,
            "get_diagnostics": self._handle_get_diagnostics,
            "clear_conversation": self._handle_clear_conversation,
            "get_context_preview": self._handle_get_context_preview,
            "set_conversation_mode": self._handle_set_conversation_mode,
            "get_model_profiles": self._handle_get_model_profiles,
            "set_model_profile": self._handle_set_model_profile,
            "request_command_approval": self._handle_request_command_approval,
            "explain_command": self._handle_explain_command,
            "capture_screen_context": self._handle_capture_screen_context,
            "submit_screen_question": self._handle_submit_screen_question,
            "ask_about_screen": self._handle_ask_about_screen,
            "test_provider": self._handle_test_provider,
            "list_provider_models": self._handle_list_provider_models,
            "delete_api_key": self._handle_delete_api_key,
            "open_logs": self._handle_open_logs,
            "open_config_folder": self._handle_open_config_folder,
            "reset_settings": self._handle_reset_settings,
            "ping": None,
        }
        handler = handlers.get(cmd.type)

        if handler is None:
            if cmd.type != "ping":
                self._send(ErrorEvent(message=f"Unknown command: {cmd.type}"))
            return

        if cmd.type in {"cancel_recording", "cancel_current_operation"}:
            await handler()
            return

        async with self._busy_lock:
            await handler()

    async def _handle_start_recording(self) -> None:
        if self._state in _STATES_DISALLOWING_RECORD:
            self._send(ErrorEvent(message="Busy — finish current request first"))
            return

        self._operation_generation += 1
        generation = self._operation_generation
        self._stop_partial_loop()
        self._timer.reset()
        self._timer.start("record")
        self._recording_started_at = time.monotonic()
        self._speech_started = False
        self._voice_active = False
        self._last_voice_at = None
        self._last_voice_activity_emit_at = 0.0
        self._auto_stop_requested = False
        self._last_voice_activity = {"state": "waiting"}
        self._state = ServerState.LISTENING
        self._send_state("listening", "Listening...")
        # Clear any previous partial transcript from the UI.
        self._send_partial("")

        try:
            self._recorder = StreamingRecorder(
                sample_rate=self._config.voice.sample_rate,
                min_duration_seconds=self._config.voice.min_duration_seconds,
                min_rms=self._config.voice.min_rms,
                input_device=self._config.voice.input_device,
                on_audio_level=lambda level: self._handle_recording_audio_level(level, generation),
            )
            self._recorder.start()
            self._start_partial_loop()
        except AudioError as e:
            self._stop_partial_loop()
            self._send(ErrorEvent(
                message=f"audio_input_unavailable: Could not open microphone input: {e}",
            ))
            self._error_out(f"Microphone could not be opened: {e}")

    def _handle_recording_audio_level(self, level: Any, generation: int) -> None:
        if generation != self._operation_generation or self._state != ServerState.LISTENING:
            return

        now = time.monotonic()
        threshold = self._voice_activity_threshold()
        normalized = _normalize_audio_level(level.rms, threshold)
        self._send(AudioLevelEvent(rms=level.rms, peak=level.peak, level=normalized))

        duration_ms = int(max(0.0, now - self._recording_started_at) * 1000)
        is_voice = level.rms >= threshold
        silence_ms = 0

        if is_voice:
            self._speech_started = True
            self._voice_active = True
            self._last_voice_at = now
            self._last_voice_activity = {"state": "active", "rms": level.rms}
        else:
            self._voice_active = False
            if self._speech_started and self._last_voice_at is not None:
                silence_ms = int(max(0.0, now - self._last_voice_at) * 1000)
                self._last_voice_activity = {
                    "state": "silent",
                    "rms": level.rms,
                    "silence_ms": silence_ms,
                }
            else:
                self._last_voice_activity = {"state": "waiting", "rms": level.rms}

        if now - self._last_voice_activity_emit_at >= 0.15:
            self._last_voice_activity_emit_at = now
            self._send(
                VoiceActivityEvent(
                    active=is_voice,
                    rms=level.rms,
                    peak=level.peak,
                    speech_started=self._speech_started,
                    silence_ms=silence_ms,
                )
            )

        if self._auto_stop_requested:
            return

        if duration_ms >= self._config.voice.max_recording_ms:
            self._schedule_auto_stop(generation, "max_duration", silence_ms)
            return

        if not self._config.voice.auto_finish_enabled:
            return
        if duration_ms < self._config.voice.min_recording_ms:
            return
        if self._config.voice.speech_start_required and not self._speech_started:
            return
        if self._speech_started and silence_ms >= self._config.voice.silence_timeout_ms:
            self._schedule_auto_stop(generation, "silence", silence_ms)

    def _voice_activity_threshold(self) -> float:
        configured = self._config.voice.voice_activity_threshold
        if configured > 0:
            return configured
        return max(self._config.voice.min_rms, 0.001)

    def _schedule_auto_stop(self, generation: int, reason: str, silence_ms: int) -> None:
        if self._auto_stop_requested:
            return
        self._auto_stop_requested = True
        self._send(RecordingAutoStoppingEvent(reason=reason, silence_ms=silence_ms))
        if self._loop is None:
            return
        self._loop.call_soon_threadsafe(
            lambda: asyncio.create_task(
                self._finish_recording(
                    reason="auto_silence" if reason == "silence" else reason,
                    generation=generation,
                )
            )
        )

    async def _handle_stop_recording(self) -> None:
        await self._finish_recording(reason="manual", generation=self._operation_generation)

    async def _finish_recording(self, reason: str, generation: int) -> None:
        if generation != self._operation_generation:
            return
        if self._state != ServerState.LISTENING or self._recorder is None:
            return

        self._state = ServerState.TRANSCRIBING
        self._send(RecordingStoppedEvent(reason=reason))
        self._send_state("transcribing", "Transcribing...")
        self._stop_partial_loop()

        recorder = self._recorder
        self._recorder = None

        loop = asyncio.get_running_loop()
        recorded = await loop.run_in_executor(None, _do_stop_recording, recorder)

        self._timer.stop("record")

        if generation != self._operation_generation:
            if isinstance(recorded, Path):
                recorded.unlink(missing_ok=True)
            return

        if isinstance(recorded, Vox2AIError):
            self._error_out(str(recorded))
            return

        path = recorded

        result = await loop.run_in_executor(None, _do_transcription, path, self._config)
        path.unlink(missing_ok=True)
        if generation != self._operation_generation:
            return

        if isinstance(result, Vox2AIError):
            self._error_out(str(result))
            return

        transcript = result
        self._send(TranscriptEvent(text=transcript, source="voice"))
        self._timer.stop("stt")

        self._state = ServerState.THINKING
        self._send_state("thinking", "Thinking...")
        await self._process_user_prompt(transcript, generation)

    async def _handle_cancel_recording(self) -> None:
        await self._handle_cancel_current_operation()

    async def _handle_cancel_current_operation(self) -> None:
        if self._state == ServerState.READY:
            return

        operation = "recording"
        if self._state == ServerState.TRANSCRIBING:
            operation = "transcription"
        elif self._state in {ServerState.THINKING, ServerState.STREAMING_ANSWER}:
            operation = "answer"
        elif self._state == ServerState.APPROVAL_REQUIRED:
            operation = "approval"
        elif self._state == ServerState.RUNNING_COMMAND:
            operation = "command"

        if self._recorder is not None:
            self._recorder.cancel()
            self._recorder = None
        self._pending_decision = None
        self._stop_partial_loop()
        self._operation_generation += 1
        self._send_partial("")
        self._state = ServerState.READY
        self._send(OperationCancelledEvent(operation=operation))
        self._send_state("ready", "Cancelled.")

    async def _handle_submit_text_prompt(self) -> None:
        """Handle a typed text prompt from the frontend."""
        cmd = self._last_cmd
        if not isinstance(cmd, SubmitTextPromptCommand):
            return
        text = cmd.text.strip()
        if not text:
            return
        if self._state in _STATES_DISALLOWING_RECORD:
            self._send(ErrorEvent(message="vox2ai is busy."))
            return

        self._timer.reset()
        generation = self._operation_generation + 1
        self._operation_generation = generation
        if cmd.conversation_mode is not None:
            self._conversation_mode = cmd.conversation_mode
        if not self._conversation_mode:
            self._conversation.clear()
        self._state = ServerState.THINKING
        self._send(TranscriptEvent(text=text, raw_text=None, source="text"))
        self._send_state("thinking", "Thinking...")
        await self._process_user_prompt(text, generation, cmd.context)

    async def _handle_get_settings(self) -> None:
        """Return sanitized settings to the frontend."""
        sanitized = sanitize_config(self._config)
        sanitized["needs_setup"] = needs_setup(self._config)
        self._send(SettingsEvent(settings=sanitized))

    async def _handle_get_diagnostics(self) -> None:
        self._send(DiagnosticsEvent(diagnostics=self._build_diagnostics()))

    async def _handle_clear_conversation(self) -> None:
        self._conversation.clear()
        self._send(ConversationClearedEvent())
        self._send_state("ready", "Conversation cleared.")

    async def _handle_set_conversation_mode(self) -> None:
        cmd = self._last_cmd
        if not isinstance(cmd, SetConversationModeCommand):
            return
        self._conversation_mode = bool(cmd.enabled)
        self._config.conversation.enabled = self._conversation_mode
        if not self._conversation_mode:
            self._conversation.clear()
        self._send(SettingsSavedEvent(settings=sanitize_config(self._config)))

    async def _handle_get_model_profiles(self) -> None:
        self._send(self._model_profiles_payload())

    async def _handle_set_model_profile(self) -> None:
        cmd = self._last_cmd
        if not isinstance(cmd, SetModelProfileCommand):
            return
        profile = cmd.profile.strip()
        if profile not in self._config.model_profiles.profiles:
            self._send(
                SettingsErrorEvent(
                    field="model_profile",
                    message=f"Unknown profile: {profile}",
                )
            )
            return
        self._config.model_profiles.active = profile
        self._llm_client = LLMClient(self._active_assistant_config())
        save_config(self._config)
        self._send(ModelProfileSetEvent(active=profile))
        self._send(self._model_profiles_payload())

    async def _handle_request_command_approval(self) -> None:
        cmd = self._last_cmd
        if not isinstance(cmd, RequestCommandApprovalCommand):
            return
        command = cmd.command.strip()
        if not command:
            return
        decision = AgentDecision(
            type="command",
            message="Requested from a command block.",
            command=command,
            reason=cmd.reason or "Run command proposed in the answer.",
        )
        self._operation_generation += 1
        await self._handle_decision(decision, self._operation_generation)

    async def _handle_explain_command(self) -> None:
        cmd = self._last_cmd
        if not isinstance(cmd, ExplainCommandCommand):
            return
        command = cmd.command.strip()
        if not command:
            return
        self._operation_generation += 1
        generation = self._operation_generation
        self._state = ServerState.THINKING
        self._send_state("thinking", "Thinking...")
        prompt = (
            "Explain this shell command in plain language. Include what it changes, "
            "whether it is risky, and what to check before running it.\n\n"
            f"Command:\n{command}"
        )
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(
            None,
            _do_plain_completion,
            self._llm_client,
            "You are vox2ai, a careful Linux assistant.",
            prompt,
        )
        if generation != self._operation_generation:
            return
        if isinstance(result, Vox2AIError):
            self._error_out(str(result))
            return
        self._state = ServerState.STREAMING_ANSWER
        self._send(AnswerStartEvent())
        await self._stream_text(result, generation)

    async def _handle_capture_screen_context(self) -> None:
        cmd = self._last_cmd
        if not isinstance(cmd, CaptureScreenContextCommand):
            return
        await self._capture_screen_context(cmd.mode)

    async def _handle_submit_screen_question(self) -> None:
        cmd = self._last_cmd
        if not isinstance(cmd, SubmitScreenQuestionCommand):
            return
        await self._submit_screen_question(cmd.question, cmd.context_id)

    async def _handle_ask_about_screen(self) -> None:
        cmd = self._last_cmd
        if not isinstance(cmd, AskAboutScreenCommand):
            return
        context_id = await self._capture_screen_context(cmd.mode)
        if context_id and cmd.question.strip():
            await self._submit_screen_question(cmd.question, context_id)

    async def _capture_screen_context(self, mode: str = "auto") -> str | None:
        if not self._config.context.screen_context_enabled:
            message = "Ask about screen is disabled in Settings."
            self._last_screen_error = message
            self._send(ScreenContextErrorEvent(message=message))
            return None

        self._send(ScreenCaptureStartedEvent())
        loop = asyncio.get_running_loop()
        captured = await loop.run_in_executor(None, _capture_screen, self._config)
        if isinstance(captured, Vox2AIError):
            self._last_screen_error = str(captured)
            self._send(ScreenContextErrorEvent(message=str(captured)))
            return None

        context_id = uuid.uuid4().hex
        vision_profile = self._vision_profile_id()
        use_vision = mode == "vision" or (mode == "auto" and vision_profile is not None)
        context: dict[str, Any] = {
            "id": context_id,
            "mode": "vision" if use_vision else "ocr",
            "image_path": str(captured["image_path"]),
            "mime_type": captured["mime_type"],
            "width": captured["width"],
            "height": captured["height"],
            "vision_profile": vision_profile if use_vision else None,
            "ocr_text": "",
            "ocr_engine": "",
        }
        self._screen_contexts[context_id] = context
        self._send(
            ScreenCaptureDoneEvent(
                context_id=context_id,
                width=int(captured["width"]),
                height=int(captured["height"]),
            )
        )

        if use_vision:
            self._send(ScreenContextStartedEvent(mode="vision"))
            self._send(ScreenContextReadyEvent(context_id=context_id, mode="vision"))
            return context_id

        self._send(ScreenContextStartedEvent(mode="ocr"))
        ocr = await loop.run_in_executor(
            None,
            _ocr_screen,
            Path(context["image_path"]),
            self._config,
        )
        if isinstance(ocr, Vox2AIError):
            self._last_screen_error = str(ocr)
            self._cleanup_screen_context(context_id)
            self._send(ScreenContextErrorEvent(message=str(ocr)))
            return None

        context["ocr_text"] = ocr["text"]
        context["ocr_engine"] = ocr["engine"]
        self._send(
            ScreenOcrDoneEvent(
                engine=ocr["engine"],
                text_length=len(ocr["text"]),
                confidence=float(ocr.get("confidence", 0.0)),
            )
        )
        if not self._config.context.screen_capture_save_debug:
            _unlink_silent(Path(context["image_path"]))
            context["image_path"] = ""
        self._send(ScreenContextReadyEvent(context_id=context_id, mode="ocr"))
        return context_id

    async def _submit_screen_question(self, question: str, context_id: str) -> None:
        clean = question.strip()
        context = self._screen_contexts.get(context_id)
        if not clean or context is None:
            self._send(ScreenContextErrorEvent(message="Screen context is no longer available."))
            return

        self._operation_generation += 1
        generation = self._operation_generation
        self._state = ServerState.THINKING
        self._send(TranscriptEvent(text=clean, raw_text=None, source="screen"))
        self._send_state("thinking", "Thinking...")
        self._send(AnswerStartEvent())

        loop = asyncio.get_running_loop()
        try:
            if context.get("mode") == "vision":
                image_path = Path(str(context.get("image_path", "")))
                result = await loop.run_in_executor(
                    None,
                    _do_vision_screen_answer,
                    self._client_for_profile(str(context.get("vision_profile") or "")),
                    clean,
                    image_path,
                    str(context.get("mime_type") or "image/png"),
                )
            else:
                result = await loop.run_in_executor(
                    None,
                    _do_ocr_screen_answer,
                    self._llm_client,
                    clean,
                    str(context.get("ocr_text") or ""),
                )
        finally:
            if not self._config.context.screen_capture_save_debug:
                self._cleanup_screen_context(context_id)

        if generation != self._operation_generation:
            return
        if isinstance(result, Vox2AIError):
            self._error_out(str(result))
            return
        await self._stream_text(result, generation)

    def _cleanup_screen_context(self, context_id: str) -> None:
        context = self._screen_contexts.pop(context_id, None)
        if not context:
            return
        image_path = str(context.get("image_path") or "")
        if image_path and not self._config.context.screen_capture_save_debug:
            _unlink_silent(Path(image_path))

    async def _handle_get_context_preview(self) -> None:
        self._send(
            ContextPreviewEvent(
                clipboard_available=False,
                clipboard_preview="",
                active_window=None,
            )
        )

    async def _handle_update_settings(self) -> None:
        """Apply a partial settings patch from the frontend."""
        cmd = self._last_cmd
        if not isinstance(cmd, UpdateSettingsCommand):
            return
        patch = cmd.settings
        try:
            updated = _apply_settings_patch(self._config, patch)
            save_config(updated)
            self._config = updated
            # Recreate LLM client if provider settings changed.
            if "assistant" in patch or "model_profiles" in patch:
                self._llm_client = LLMClient(self._active_assistant_config())
            if "conversation" in patch:
                self._conversation_mode = updated.conversation.enabled
            sanitized = sanitize_config(updated)
            sanitized["needs_setup"] = needs_setup(updated)
            self._send(SettingsSavedEvent(settings=sanitized))
        except Exception as exc:
            self._send(SettingsErrorEvent(message=str(exc)))

    async def _handle_test_provider(self) -> None:
        """Test a provider connection."""
        cmd = self._last_cmd
        if not isinstance(cmd, TestProviderCommand):
            return
        # Use the configured API key if none provided in the test request.
        api_key = resolve_api_key(self._config.assistant, cmd.api_key)
        try:
            pid = cmd.provider_id or self._config.assistant.provider
            burl = cmd.base_url or self._config.assistant.base_url
            mdl = cmd.model or self._config.assistant.model
            adapter = create_adapter(pid, burl, api_key, mdl)
            ok, msg = adapter.test_connection()
            self._send(ProviderTestResultEvent(ok=ok, message=msg))
        except Exception as exc:
            self._send(ProviderTestResultEvent(ok=False, message=str(exc)))

    async def _handle_list_provider_models(self) -> None:
        """Fetch available models from a provider."""
        cmd = self._last_cmd
        if not isinstance(cmd, ListProviderModelsCommand):
            return
        api_key = resolve_api_key(self._config.assistant, cmd.api_key)
        try:
            adapter = create_adapter(cmd.provider_id, cmd.base_url, api_key, "")
            models, error = adapter.list_models()
            if error:
                self._send(ProviderModelsErrorEvent(provider_id=cmd.provider_id, message=error))
            else:
                self._send(ProviderModelsEvent(provider_id=cmd.provider_id, models=models))
        except Exception as exc:
            self._send(ProviderModelsErrorEvent(provider_id=cmd.provider_id, message=str(exc)))

    async def _handle_delete_api_key(self) -> None:
        """Delete the stored API key."""
        try:
            get_secret_store().delete("api_key")
            if self._config.assistant.api_key:
                self._config.assistant.api_key = ""
                save_config(self._config)
            self._send(SettingsSavedEvent(settings=sanitize_config(self._config)))
        except Exception as exc:
            self._send(SettingsErrorEvent(message=str(exc)))

    async def _handle_open_logs(self) -> None:
        """Open the log directory in the file manager."""
        log_dir = _get_log_dir()
        if log_dir.exists():
            import subprocess

            subprocess.Popen(["xdg-open", str(log_dir)])

    async def _handle_open_config_folder(self) -> None:
        """Open the config directory in the file manager."""
        from vox2ai.config import config_path

        cfg_dir = config_path().parent
        if cfg_dir.exists():
            import subprocess

            subprocess.Popen(["xdg-open", str(cfg_dir)])

    async def _handle_reset_settings(self) -> None:
        """Reset config to defaults."""
        from vox2ai.config import ensure_config

        ensure_config(force=True)
        self._config = load_config()
        sanitized = sanitize_config(self._config)
        self._send(SettingsSavedEvent(settings=sanitized))

    async def _process_user_prompt(
        self,
        prompt: str,
        generation: int,
        context: dict[str, Any] | None = None,
    ) -> None:
        """Run the agent decision and answer/command flow for a prompt.

        Shared by voice (after STT) and typed text flows.
        """
        self._append_conversation("user", prompt)
        llm_prompt = self._build_prompt(prompt, context)
        loop = asyncio.get_running_loop()
        decision = await loop.run_in_executor(None, _do_decision, self._llm_client, llm_prompt)
        if generation != self._operation_generation:
            return
        if isinstance(decision, Vox2AIError):
            self._error_out(str(decision))
            return
        await self._handle_decision(decision, generation)

    async def _handle_approve_command(self) -> None:
        if self._state != ServerState.APPROVAL_REQUIRED:
            return
        decision = self._pending_decision
        if decision is None or decision.command is None:
            return
        self._pending_decision = None
        await self._execute_command(decision, self._operation_generation)

    async def _handle_deny_command(self) -> None:
        if self._state != ServerState.APPROVAL_REQUIRED:
            return
        self._pending_decision = None
        self._done_out()

    async def _handle_decision(self, decision: AgentDecision, generation: int) -> None:
        if generation != self._operation_generation:
            return

        if decision.type == "command":
            cmd_config = self._config.commands
            command_is_blocked = bool(decision.command and is_blocked(decision.command, cmd_config))
            if cmd_config.mode == "disabled" or command_is_blocked:
                reason = (
                    "Command execution is disabled."
                    if cmd_config.mode == "disabled"
                    else "That command is blocked by config."
                )
                message = decision.message.strip()
                command_note = f"I did not run `{decision.command}`. {reason}"
                message = f"{message}\n\n{command_note}" if message else command_note

                self._state = ServerState.STREAMING_ANSWER
                self._send(AnswerStartEvent())
                await self._stream_text(message, generation)
                return

            risk = classify_command_risk(decision.command or "")
            if requires_approval(decision.command or "", cmd_config) or risk == "high":
                self._state = ServerState.APPROVAL_REQUIRED
                self._pending_decision = decision
                if decision.message or decision.command:
                    self._append_conversation(
                        "assistant",
                        f"{decision.message}\nProposed command: {decision.command or ''}".strip(),
                    )
                self._send(
                    CommandApprovalEvent(
                        command=decision.command or "",
                        reason=decision.reason,
                        working_directory=str(Path(cmd_config.working_directory).resolve()),
                        risk=risk,
                        expected_effect=describe_command_effect(decision.command or ""),
                    )
                )
                return

            await self._execute_command(decision, generation)
            return

        self._state = ServerState.STREAMING_ANSWER
        self._send(AnswerStartEvent())

        message = decision.message
        if not message:
            self._send(AnswerDoneEvent())
            self._done_out(generation)
            return

        await self._stream_text(message, generation)

    async def _execute_command(self, decision: AgentDecision, generation: int) -> None:
        if decision.command is None:
            return
        if generation != self._operation_generation:
            return

        self._state = ServerState.RUNNING_COMMAND
        self._send(CommandRunningEvent(command=decision.command))
        self._timer.start("command")

        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(None, _do_run_command, decision.command, self._config)

        self._timer.stop("command")
        if generation != self._operation_generation:
            return

        if isinstance(result, Vox2AIError):
            self._error_out(str(result))
            return

        self._send(
            CommandResultEvent(
                command=result.command,
                exit_code=result.exit_code,
                stdout=result.stdout,
                stderr=result.stderr,
            )
        )
        self._append_conversation(
            "assistant",
            _summarize_command_result(result),
        )

        self._state = ServerState.THINKING
        self._send_state("thinking", "Thinking...")

        explanation = await loop.run_in_executor(
            None, _do_command_explanation, self._llm_client, decision, result
        )
        if generation != self._operation_generation:
            return

        if isinstance(explanation, Vox2AIError):
            self._error_out(str(explanation))
            return

        self._state = ServerState.STREAMING_ANSWER
        self._send(AnswerStartEvent())
        await self._stream_text(explanation, generation)

    async def _stream_text(self, text: str, generation: int) -> None:
        chunk_size = 60
        for i in range(0, len(text), chunk_size):
            if generation != self._operation_generation:
                return
            self._send(AnswerDeltaEvent(text=text[i : i + chunk_size]))
            await asyncio.sleep(0.015)
        if generation != self._operation_generation:
            return
        self._send(AnswerDoneEvent())
        self._append_conversation("assistant", text)
        self._done_out(generation)

    def _done_out(self, generation: int | None = None) -> None:
        if generation is not None and generation != self._operation_generation:
            return
        self._state = ServerState.READY
        self._send_state("ready", "Ready")
        if self._config.debug.show_timings:
            spans = sorted(self._timer._spans.items())
            items = [{"name": k, "ms": round(v * 1000, 1)} for k, v in spans]
            self._send(TimingEvent(items=items))

    def _error_out(self, message: str) -> None:
        self._state = ServerState.ERROR
        self._send(ErrorEvent(message=message))
        self._send_state("ready", "Ready")


def _format_prompt_context(context: dict[str, Any], max_clipboard_chars: int) -> str:
    """Format explicit frontend context for the LLM without logging it."""
    parts: list[str] = []
    clipboard = context.get("clipboard")
    if isinstance(clipboard, str) and clipboard.strip():
        text = clipboard.strip()
        truncated = len(text) > max_clipboard_chars
        text = text[:max_clipboard_chars]
        suffix = "\n[clipboard truncated]" if truncated else ""
        parts.append(f"Clipboard context:\n{text}{suffix}")

    active_window = context.get("active_window")
    if isinstance(active_window, dict):
        app = str(active_window.get("app") or "").strip()
        title = str(active_window.get("title") or "").strip()
        if app or title:
            parts.append(
                f"Active window context:\napp: {app or 'unknown'}\ntitle: {title or 'unknown'}"
            )

    return "\n\n".join(parts)


def _check_microphone_available() -> tuple[bool, str]:
    try:
        import sounddevice as sd

        devices = sd.query_devices()
        inputs = [d for d in devices if isinstance(d, dict) and d.get("max_input_channels", 0) > 0]
        if not inputs:
            return False, "No input devices found."
        default_dev = sd.default.device[0]
        default_name = "unknown"
        for d in inputs:
            if d.get("index") == default_dev or d.get("name", ""):
                default_name = str(d.get("name", d.get("hostapi", "unknown")))
        return True, f"{len(inputs)} input device(s) available. Default: {default_name}"
    except Exception as exc:
        return False, str(exc)


def _summarize_command_result(result: CommandResult) -> str:
    stdout = result.stdout.strip().splitlines()
    stderr = result.stderr.strip().splitlines()
    details: list[str] = [f"Command `{result.command}` exited with {result.exit_code}."]
    if stdout:
        details.append("stdout: " + stdout[0][:240])
    if stderr:
        details.append("stderr: " + stderr[0][:240])
    return "\n".join(details)


# ── Sync workers ───────────────────────────────────────────────


def _do_stop_recording(recorder: StreamingRecorder) -> Path | Vox2AIError:
    try:
        r = recorder.stop()
        return r.path
    except Vox2AIError as e:
        return e


def _normalize_audio_level(rms: float, min_rms: float) -> float:
    gate = max(min_rms, 0.001)
    if rms <= gate:
        return 0.0
    scale = max(min_rms * 6.0, 0.006)
    return max(0.0, min(1.0, (rms - gate) / scale))


def _audio_rms(audio: Any) -> float:
    try:
        import numpy as np

        return float(np.sqrt(np.mean(audio**2)))
    except Exception:
        return 0.0


def _do_transcription(path: Path, config: AppConfig) -> str | Vox2AIError:
    try:
        voice = config.voice
        result = transcribe_audio(
            path,
            voice.whisper_model,
            language=voice.language,
            language_mode=voice.language_mode,
            primary_language=voice.primary_language,
            allowed_languages=voice.allowed_languages,
            min_language_probability=voice.min_language_probability,
            initial_prompt=None,
        )
        return result.raw_text
    except Vox2AIError as e:
        return e


def _do_decision(llm: LLMClient, transcript: str) -> AgentDecision | Vox2AIError:
    try:
        raw = llm.complete(COMMAND_AGENT_SYSTEM_PROMPT, transcript)
        return parse_agent_decision(raw)
    except Vox2AIError as e:
        return e


def _do_plain_completion(llm: LLMClient, system_prompt: str, prompt: str) -> str | Vox2AIError:
    try:
        return llm.complete(system_prompt, prompt)
    except Vox2AIError as e:
        return e


def _do_vision_screen_answer(
    llm: LLMClient,
    question: str,
    image_path: Path,
    mime_type: str,
) -> str | Vox2AIError:
    try:
        prompt = (
            "The user explicitly captured their screen and asked about it.\n\n"
            f"User question:\n{question}\n\n"
            "Answer based on the screenshot. Be direct, and call out uncertainty when needed."
        )
        return llm.complete_with_image(
            "You are vox2ai, a concise GNOME desktop assistant.",
            prompt,
            image_path,
            mime_type,
        )
    except Vox2AIError as e:
        return e


def _do_ocr_screen_answer(llm: LLMClient, question: str, ocr_text: str) -> str | Vox2AIError:
    if not ocr_text.strip():
        return Vox2AIError(
            "I captured the screen but could not extract readable text. "
            "Configure a vision-capable model or install OCR support."
        )
    try:
        prompt = (
            "The user asked about their screen.\n\n"
            "OCR-extracted text from screenshot:\n"
            "---\n"
            f"{ocr_text.strip()}\n"
            "---\n\n"
            f"User question:\n{question}\n\n"
            "Answer based on the visible text. If OCR may be incomplete, say what is uncertain."
        )
        return llm.complete("You are vox2ai, a concise GNOME desktop assistant.", prompt)
    except Vox2AIError as e:
        return e


def _do_run_command(command: str, config: AppConfig) -> CommandResult | Vox2AIError:
    try:
        return run_command(
            command,
            Path(config.commands.working_directory).resolve(),
            config.commands.timeout_seconds,
            config.commands.max_output_chars,
        )
    except Vox2AIError as e:
        return e


def _screen_capture_available() -> bool:
    return shutil.which("gnome-screenshot") is not None


def _ocr_available() -> bool:
    return shutil.which("tesseract") is not None


def _capture_screen(config: AppConfig) -> dict[str, Any] | Vox2AIError:
    if not _screen_capture_available():
        return Vox2AIError(
            "Screen capture is unavailable. Install gnome-screenshot or configure a portal "
            "capture method."
        )

    cache_dir = Path(tempfile.gettempdir()) / "vox2ai-screen"
    cache_dir.mkdir(parents=True, exist_ok=True)
    image_path = cache_dir / f"screen-{uuid.uuid4().hex}.png"

    method = config.context.screen_capture_method
    if method not in {"auto", "gnome-screenshot"}:
        return Vox2AIError("Configured screen capture method is not available yet.")

    try:
        subprocess.run(
            ["gnome-screenshot", "-f", str(image_path)],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            timeout=15,
        )
    except subprocess.CalledProcessError as exc:
        return Vox2AIError((exc.stderr or "Screen capture failed.").strip())
    except subprocess.TimeoutExpired:
        return Vox2AIError("Screen capture timed out.")
    except OSError as exc:
        return Vox2AIError(f"Screen capture failed: {exc}")

    width, height = _png_dimensions(image_path)
    return {
        "image_path": image_path,
        "mime_type": "image/png",
        "width": width,
        "height": height,
    }


def _ocr_screen(image_path: Path, config: AppConfig) -> dict[str, Any] | Vox2AIError:
    if not _ocr_available():
        return Vox2AIError(
            "OCR is unavailable. Install tesseract or configure a vision-capable model."
        )
    lang = _ocr_language(config.voice.primary_language)
    try:
        proc = subprocess.run(
            ["tesseract", str(image_path), "stdout", "-l", lang],
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except subprocess.TimeoutExpired:
        return Vox2AIError("OCR timed out.")
    except OSError as exc:
        return Vox2AIError(f"OCR failed: {exc}")

    if proc.returncode != 0:
        detail = (proc.stderr or "OCR failed.").strip()
        return Vox2AIError(detail)

    return {
        "text": proc.stdout.strip(),
        "confidence": 0.0,
        "engine": "tesseract",
        "language": lang,
        "blocks": [],
    }


def _ocr_language(primary_language: str) -> str:
    lang = primary_language.lower().strip()
    if lang.startswith("pt"):
        return "por"
    if lang.startswith("es"):
        return "spa"
    return "eng"


def _png_dimensions(path: Path) -> tuple[int, int]:
    try:
        data = path.read_bytes()[:24]
        if data[:8] != b"\x89PNG\r\n\x1a\n":
            return 0, 0
        width = int.from_bytes(data[16:20], "big")
        height = int.from_bytes(data[20:24], "big")
        return width, height
    except Exception:
        return 0, 0


def _unlink_silent(path: Path) -> None:
    with contextlib.suppress(Exception):
        path.unlink(missing_ok=True)


def _do_command_explanation(
    llm: LLMClient, decision: AgentDecision, result: CommandResult
) -> str | Vox2AIError:
    try:
        prompt = COMMAND_RESULT_PROMPT.format(
            original_prompt=decision.message,
            command=result.command,
            exit_code=result.exit_code,
            stdout=result.stdout,
            stderr=result.stderr,
        )
        return llm.complete("You are vox2ai, a Linux assistant.", prompt)
    except Vox2AIError as e:
        return e


# ── WebSocket server ───────────────────────────────────────────


class _HandshakeNoiseFilter(logging.Filter):
    """Suppress benign handshake failures caused by HMR reloads."""

    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        if "opening handshake failed" not in message:
            return True
        # Only suppress the common "no close frame" abort seen during dev reloads.
        exc_info = record.exc_info
        if exc_info is None:
            return True
        exc = exc_info[1]
        if exc is None:
            return True
        return "no close frame received or sent" not in str(exc)


# Handshake aborts are expected when the webview reloads during development.
logging.getLogger("websockets.server").addFilter(_HandshakeNoiseFilter())


class DesktopServer:
    """WebSocket server for the vox2ai desktop frontend."""

    def __init__(self, config: AppConfig) -> None:
        self._config = config
        self._controller = DesktopController(config)
        self._server = None

    async def start(self) -> None:
        import websockets

        host = self._config.backend_service.host
        port = self._config.backend_service.port

        self._server = await websockets.serve(  # type: ignore[assignment]
            self._handle_client,
            host,
            port,
            ping_interval=20,
            ping_timeout=10,
            open_timeout=5,
        )

        # Retrieve the actual bound port (important when port=0).
        bound_port = port
        if self._server is not None:
            sockets = self._server.sockets
            if sockets:
                sockname = sockets[0].getsockname()
                bound_port = sockname[1]

        print(f"[vox2ai] WebSocket server listening on ws://{host}:{bound_port}", flush=True)

    async def stop(self) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()

    async def _handle_client(self, websocket) -> None:  # type: ignore[no-untyped-def]
        loop = asyncio.get_running_loop()

        def _broadcast(event: BackendEvent) -> None:
            asyncio.run_coroutine_threadsafe(self._send_event(websocket, event), loop)

        self._controller.set_broadcast(_broadcast, loop)
        self._controller._send(HelloEvent())
        self._controller._send(BackendStatusEvent(status="connected", message="Ready"))
        self._controller._send_state("ready", "Ready")

        try:
            async for raw in websocket:
                await self._controller.handle_command(raw)
        except Exception:
            pass

    async def _send_event(self, websocket, event: BackendEvent) -> None:  # type: ignore[no-untyped-def]
        try:
            payload = serialize_event(event)
            await websocket.send(payload)
        except Exception:
            pass


def run_server(
    config: AppConfig | None = None,
    *,
    host: str | None = None,
    port: int | None = None,
) -> None:
    """Entry point for ``vox2ai server``.

    Parameters
    ----------
    config : AppConfig | None
        Pre-loaded config, or None to load from the default path.
    host : str | None
        Override bind address (e.g. ``"127.0.0.1"``).
    port : int | None
        Override port (``0`` = random free port).
    """

    async def _run() -> None:
        cfg = config or load_config()
        if host is not None:
            cfg.backend_service.host = host
        if port is not None:
            cfg.backend_service.port = port
        server = DesktopServer(cfg)
        await server.start()
        await asyncio.Future()  # run forever

    asyncio.run(_run())


def _get_log_dir() -> Path:
    from platformdirs import user_state_dir

    return Path(user_state_dir("vox2ai", ensure_exists=True))


def _apply_settings_patch(config: AppConfig, patch: dict[str, Any]) -> AppConfig:
    """Apply a partial settings patch to a config object."""
    import copy

    updated = copy.deepcopy(config)

    if "assistant" in patch:
        for k, v in patch["assistant"].items():
            if k == "api_key":
                if v:
                    get_secret_store().save("api_key", v)
                continue
            if hasattr(updated.assistant, k):
                setattr(updated.assistant, k, v)

    if "voice" in patch:
        for k, v in patch["voice"].items():
            if hasattr(updated.voice, k):
                setattr(updated.voice, k, v)

    if "recording" in patch:
        for k, v in patch["recording"].items():
            if hasattr(updated.recording, k):
                setattr(updated.recording, k, v)

    if "activation" in patch:
        for k, v in patch["activation"].items():
            if hasattr(updated.activation, k):
                setattr(updated.activation, k, v)

    if "transcription" in patch:
        t = patch["transcription"]
        if isinstance(t, dict):
            for k, v in t.items():
                if k == "partial" and isinstance(v, dict):
                    for pk, pv in v.items():
                        if hasattr(updated.transcription.partial, pk):
                            setattr(updated.transcription.partial, pk, pv)
                elif hasattr(updated.transcription, k):
                    setattr(updated.transcription, k, v)

    if "commands" in patch:
        for k, v in patch["commands"].items():
            if hasattr(updated.commands, k):
                setattr(updated.commands, k, v)

    if "general" in patch:
        for k, v in patch["general"].items():
            if hasattr(updated.general, k):
                setattr(updated.general, k, v)
        updated.general.launch_at_login = updated.general.start_at_login

    if "onboarding" in patch:
        for k, v in patch["onboarding"].items():
            if hasattr(updated.onboarding, k):
                setattr(updated.onboarding, k, v)

    if "context" in patch:
        for k, v in patch["context"].items():
            if hasattr(updated.context, k):
                setattr(updated.context, k, v)

    if "conversation" in patch:
        for k, v in patch["conversation"].items():
            if hasattr(updated.conversation, k):
                setattr(updated.conversation, k, v)

    if "history" in patch:
        for k, v in patch["history"].items():
            if hasattr(updated.history, k):
                setattr(updated.history, k, v)

    if "notifications" in patch:
        for k, v in patch["notifications"].items():
            if hasattr(updated.notifications, k):
                setattr(updated.notifications, k, v)

    if "terminal" in patch:
        for k, v in patch["terminal"].items():
            if hasattr(updated.terminal, k):
                setattr(updated.terminal, k, v)

    if "model_profiles" in patch:
        mp = patch["model_profiles"]
        if isinstance(mp, dict):
            active = mp.get("active")
            if isinstance(active, str):
                updated.model_profiles.active = active
            profiles = mp.get("profiles")
            if isinstance(profiles, dict):
                for pid, profile_patch in profiles.items():
                    if pid not in updated.model_profiles.profiles or not isinstance(
                        profile_patch, dict
                    ):
                        continue
                    profile = updated.model_profiles.profiles[pid]
                    for k, v in profile_patch.items():
                        if hasattr(profile, k):
                            setattr(profile, k, v)

    if "quick_actions" in patch:
        for k, v in patch["quick_actions"].items():
            if hasattr(updated.quick_actions, k):
                setattr(updated.quick_actions, k, v)

    if "backend_service" in patch:
        for k, v in patch["backend_service"].items():
            if hasattr(updated.backend_service, k):
                setattr(updated.backend_service, k, v)

    if "gnome" in patch:
        for k, v in patch["gnome"].items():
            if hasattr(updated.gnome, k):
                setattr(updated.gnome, k, v)

    if "debug" in patch:
        for k, v in patch["debug"].items():
            if hasattr(updated.debug, k):
                setattr(updated.debug, k, v)

    return AppConfig.model_validate(updated.model_dump())
