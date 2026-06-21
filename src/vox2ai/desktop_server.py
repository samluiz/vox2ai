from __future__ import annotations

import asyncio
import logging
import os
import shutil
import subprocess
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
from vox2ai.config import AppConfig, load_config, save_config
from vox2ai.desktop_protocol import (
    AnswerDeltaEvent,
    AnswerDoneEvent,
    AnswerStartEvent,
    AudioLevelEvent,
    BackendEvent,
    BackendStatusEvent,
    CommandApprovalEvent,
    CommandResultEvent,
    CommandRunningEvent,
    ContextPreviewEvent,
    ConversationClearedEvent,
    DiagnosticsEvent,
    ErrorEvent,
    HelloEvent,
    ListProviderModelsCommand,
    OperationCancelledEvent,
    PartialTranscriptEvent,
    ProviderModelsErrorEvent,
    ProviderModelsEvent,
    ProviderTestResultEvent,
    SettingsErrorEvent,
    SettingsEvent,
    SettingsSavedEvent,
    StateEvent,
    SubmitTextPromptCommand,
    TestProviderCommand,
    TimingEvent,
    TranscriptEvent,
    UpdateSettingsCommand,
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
        self._llm_client = LLMClient(config.assistant)
        self._partial_task: asyncio.Task[object] | None = None
        self._partial_transcriber: LocalPartialTranscriber | None = None
        self._recording_generation = 0
        self._operation_generation = 0
        self._last_cmd: object | None = None
        self._conversation: list[dict[str, str]] = []

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
        if not self._config.conversation.enabled:
            return
        text = content.strip()
        if not text:
            return
        self._conversation.append({"role": role, "content": text})
        max_messages = self._config.conversation.max_messages
        if len(self._conversation) > max_messages:
            self._conversation = self._conversation[-max_messages:]

    def _build_prompt(self, user_text: str, context: dict[str, Any] | None = None) -> str:
        parts: list[str] = []
        if self._config.conversation.enabled and self._conversation:
            lines = ["Recent conversation in this app session:"]
            for item in self._conversation[-self._config.conversation.max_messages :]:
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

    def _build_diagnostics(self) -> dict[str, Any]:
        from vox2ai.config import config_path

        mic_available, mic_message = _check_microphone_available()
        cfg_path = config_path()
        log_dir = _get_log_dir()
        provider_configured = api_key_configured(self._config)
        return {
            "backend": {"status": "running"},
            "websocket": {"status": "connected"},
            "provider": {
                "configured": provider_configured,
                "provider": self._config.assistant.provider,
                "model": self._config.assistant.model,
                "base_url": self._config.assistant.base_url,
                "api_key": "configured" if provider_configured else "missing",
            },
            "microphone": {"available": mic_available, "message": mic_message},
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
            },
            "conversation": {
                "enabled": self._config.conversation.enabled,
                "messages": len(self._conversation),
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
        self._stop_partial_loop()
        self._timer.reset()
        self._timer.start("record")
        self._state = ServerState.LISTENING
        self._send_state("listening", "Listening...")
        # Clear any previous partial transcript from the UI.
        self._send_partial("")

        try:
            self._recorder = StreamingRecorder(
                sample_rate=self._config.voice.sample_rate,
                min_duration_seconds=self._config.voice.min_duration_seconds,
                min_rms=self._config.voice.min_rms,
                on_audio_level=lambda level: self._send(
                    AudioLevelEvent(rms=level.rms, peak=level.peak)
                ),
            )
            self._recorder.start()
            self._start_partial_loop()
        except AudioError as e:
            self._stop_partial_loop()
            self._error_out(str(e))

    async def _handle_stop_recording(self) -> None:
        if self._state != ServerState.LISTENING or self._recorder is None:
            return

        generation = self._operation_generation
        self._state = ServerState.TRANSCRIBING
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
            if "assistant" in patch:
                self._llm_client = LLMClient(updated.assistant)
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
        env_key = os.environ.get(self._config.assistant.api_key_env, "")
        api_key = cmd.api_key or get_secret_store().get("api_key") or env_key
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
        env_key = os.environ.get(self._config.assistant.api_key_env, "")
        api_key = cmd.api_key or get_secret_store().get("api_key") or env_key
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
        return True, f"{len(inputs)} input device(s) available."
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

        host = self._config.desktop.host
        port = self._config.desktop.port

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
            cfg.desktop.host = host
        if port is not None:
            cfg.desktop.port = port
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

    if "conversation" in patch:
        for k, v in patch["conversation"].items():
            if hasattr(updated.conversation, k):
                setattr(updated.conversation, k, v)

    if "context" in patch:
        for k, v in patch["context"].items():
            if hasattr(updated.context, k):
                setattr(updated.context, k, v)

    if "quick_actions" in patch:
        for k, v in patch["quick_actions"].items():
            if hasattr(updated.quick_actions, k):
                setattr(updated.quick_actions, k, v)

    if "desktop_window" in patch:
        for k, v in patch["desktop_window"].items():
            if hasattr(updated.desktop_window, k):
                setattr(updated.desktop_window, k, v)

    if "desktop" in patch:
        for k, v in patch["desktop"].items():
            if hasattr(updated.desktop, k):
                setattr(updated.desktop, k, v)

    if "debug" in patch:
        for k, v in patch["debug"].items():
            if hasattr(updated.debug, k):
                setattr(updated.debug, k, v)

    return AppConfig.model_validate(updated.model_dump())


def launch_frontend() -> None:
    """Launch the Tauri desktop app (best-effort)."""
    desktop_dir = Path(__file__).resolve().parent.parent.parent / "desktop"
    if not desktop_dir.exists():
        print("[vox2ai] Frontend directory not found at desktop/", flush=True)
        return

    if not (desktop_dir / "node_modules").is_dir():
        print("[vox2ai] node_modules/ not found. Run: cd desktop && npm install", flush=True)

    # Check for required tooling.
    if shutil.which("cargo") is None:
        print(
            "[vox2ai] Rust/Cargo not found. Install from https://rustup.rs, "
            "then run: cd desktop && npm install && npm run tauri dev",
            flush=True,
        )
        return
    if shutil.which("npm") is None:
        print(
            "[vox2ai] npm not found. Install Node.js via your package manager "
            "or https://nodejs.org",
            flush=True,
        )
        return

    try:
        proc = subprocess.Popen(
            ["npm", "run", "tauri", "dev"],
            cwd=str(desktop_dir),
        )
        print(f"[vox2ai] Tauri frontend started (PID {proc.pid})", flush=True)
    except Exception as exc:
        print(f"[vox2ai] Failed to launch frontend: {exc}", flush=True)
