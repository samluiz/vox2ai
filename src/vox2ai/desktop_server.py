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
from vox2ai.commands import CommandResult, is_blocked, requires_approval, run_command
from vox2ai.config import AppConfig, load_config, save_config
from vox2ai.desktop_protocol import (
    AnswerDeltaEvent,
    AnswerDoneEvent,
    AnswerStartEvent,
    AudioLevelEvent,
    BackendEvent,
    CommandApprovalEvent,
    CommandResultEvent,
    CommandRunningEvent,
    ErrorEvent,
    HelloEvent,
    ListProviderModelsCommand,
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
from vox2ai.settings import needs_setup, sanitize_config
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
        self._last_cmd: object | None = None

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
            "approve_command": self._handle_approve_command,
            "deny_command": self._handle_deny_command,
            "submit_text_prompt": self._handle_submit_text_prompt,
            "get_settings": self._handle_get_settings,
            "update_settings": self._handle_update_settings,
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

        async with self._busy_lock:
            await handler()

    async def _handle_start_recording(self) -> None:
        if self._state in _STATES_DISALLOWING_RECORD:
            self._send(ErrorEvent(message="Busy — finish current request first"))
            return

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

        self._state = ServerState.TRANSCRIBING
        self._send_state("transcribing", "Transcribing...")
        self._stop_partial_loop()

        recorder = self._recorder
        self._recorder = None

        loop = asyncio.get_running_loop()
        recorded = await loop.run_in_executor(None, _do_stop_recording, recorder)

        self._timer.stop("record")

        if isinstance(recorded, Vox2AIError):
            self._error_out(str(recorded))
            return

        path = recorded

        result = await loop.run_in_executor(None, _do_transcription, path, self._config)
        path.unlink(missing_ok=True)

        if isinstance(result, Vox2AIError):
            self._error_out(str(result))
            return

        transcript = result
        self._send(TranscriptEvent(text=transcript, source="voice"))
        self._timer.stop("stt")

        self._state = ServerState.THINKING
        self._send_state("thinking", "Thinking...")
        await self._process_user_prompt(transcript)

    async def _handle_cancel_recording(self) -> None:
        if self._state != ServerState.LISTENING:
            return
        if self._recorder is not None:
            self._recorder.cancel()
            self._recorder = None
        self._stop_partial_loop()
        self._send_partial("")
        self._state = ServerState.READY
        self._send_state("ready", "Ready")

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
        self._state = ServerState.THINKING
        self._send(TranscriptEvent(text=text, raw_text=None, source="text"))
        self._send_state("thinking", "Thinking...")
        await self._process_user_prompt(text)

    async def _handle_get_settings(self) -> None:
        """Return sanitized settings to the frontend."""
        sanitized = sanitize_config(self._config)
        sanitized["needs_setup"] = needs_setup(self._config)
        self._send(SettingsEvent(settings=sanitized))

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

    async def _process_user_prompt(self, prompt: str) -> None:
        """Run the agent decision and answer/command flow for a prompt.

        Shared by voice (after STT) and typed text flows.
        """
        loop = asyncio.get_running_loop()
        decision = await loop.run_in_executor(None, _do_decision, self._llm_client, prompt)
        if isinstance(decision, Vox2AIError):
            self._error_out(str(decision))
            return
        await self._handle_decision(decision)

    async def _handle_approve_command(self) -> None:
        if self._state != ServerState.APPROVAL_REQUIRED:
            return
        decision = self._pending_decision
        if decision is None or decision.command is None:
            return
        self._pending_decision = None
        await self._execute_command(decision)

    async def _handle_deny_command(self) -> None:
        if self._state != ServerState.APPROVAL_REQUIRED:
            return
        self._pending_decision = None
        self._done_out()

    async def _handle_decision(self, decision: AgentDecision) -> None:
        if decision.type == "command":
            cmd_config = self._config.commands
            if cmd_config.mode == "disabled" or (
                decision.command and is_blocked(decision.command, cmd_config)
            ):
                self._error_out(f"Command blocked by config: {decision.command}")
                return

            if requires_approval(decision.command or "", cmd_config):
                self._state = ServerState.APPROVAL_REQUIRED
                self._pending_decision = decision
                self._send(
                    CommandApprovalEvent(
                        command=decision.command or "",
                        reason=decision.reason,
                    )
                )
                return

            await self._execute_command(decision)
            return

        self._state = ServerState.STREAMING_ANSWER
        self._send(AnswerStartEvent())

        message = decision.message
        if not message:
            self._send(AnswerDoneEvent())
            self._done_out()
            return

        await self._stream_text(message)

    async def _execute_command(self, decision: AgentDecision) -> None:
        if decision.command is None:
            return

        self._state = ServerState.RUNNING_COMMAND
        self._send(CommandRunningEvent(command=decision.command))
        self._timer.start("command")

        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(None, _do_run_command, decision.command, self._config)

        self._timer.stop("command")

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

        self._state = ServerState.THINKING
        self._send_state("thinking", "Thinking...")

        explanation = await loop.run_in_executor(
            None, _do_command_explanation, self._llm_client, decision, result
        )

        if isinstance(explanation, Vox2AIError):
            self._error_out(str(explanation))
            return

        self._state = ServerState.STREAMING_ANSWER
        self._send(AnswerStartEvent())
        await self._stream_text(explanation)

    async def _stream_text(self, text: str) -> None:
        chunk_size = 60
        for i in range(0, len(text), chunk_size):
            self._send(AnswerDeltaEvent(text=text[i : i + chunk_size]))
            await asyncio.sleep(0.015)
        self._send(AnswerDoneEvent())
        self._done_out()

    def _done_out(self) -> None:
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

    if "desktop_window" in patch:
        for k, v in patch["desktop_window"].items():
            if hasattr(updated.desktop_window, k):
                setattr(updated.desktop_window, k, v)

    if "debug" in patch:
        for k, v in patch["debug"].items():
            if hasattr(updated.debug, k):
                setattr(updated.debug, k, v)

    return updated


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
