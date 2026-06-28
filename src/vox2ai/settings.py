"""Config sanitization helpers for the settings UI.

These functions strip sensitive fields, validate patches, and
produce dicts safe to send to the frontend.
"""

from __future__ import annotations

import os

from vox2ai.config import AppConfig
from vox2ai.credentials import resolve_api_key
from vox2ai.secrets import get_secret_store, mask_api_key


def api_key_configured(config: AppConfig) -> bool:
    """Return True when an API key is available from any supported source."""
    return bool(resolve_api_key(config.assistant))


def sanitize_config(config: AppConfig) -> dict[str, object]:
    """Return a config dict safe to send to the frontend.

    * Never includes the full API key.
    * Never includes raw_text or internal fields.
    """
    configured_key = api_key_configured(config)
    env_key = os.environ.get(config.assistant.api_key_env, "")
    secret_key = get_secret_store().get("api_key") or ""
    config_key = config.assistant.api_key
    return {
        "assistant": {
            "provider": config.assistant.provider,
            "base_url": config.assistant.base_url,
            "model": config.assistant.model,
            "temperature": config.assistant.temperature,
            "timeout_seconds": config.assistant.timeout_seconds,
            "api_key_env": config.assistant.api_key_env,
            "api_key_configured": configured_key,
            "api_key_preview": mask_api_key(env_key or secret_key or config_key or None),
        },
        "voice": {
            "language_mode": config.voice.language_mode,
            "primary_language": config.voice.primary_language,
            "allowed_languages": list(config.voice.allowed_languages),
            "min_language_probability": config.voice.min_language_probability,
            "whisper_model": config.voice.whisper_model,
            "input_device": config.voice.input_device,
            "auto_finish_enabled": config.voice.auto_finish_enabled,
            "silence_timeout_ms": config.voice.silence_timeout_ms,
            "speech_start_required": config.voice.speech_start_required,
            "min_recording_ms": config.voice.min_recording_ms,
            "max_recording_ms": config.voice.max_recording_ms,
            "voice_activity_threshold": config.voice.voice_activity_threshold,
            "language": config.voice.language,
        },
        "recording": {
            "activation_mode": config.recording.activation_mode,
            "shortcut": config.recording.shortcut,
        },
        "activation": {
            "global_shortcut": config.activation.global_shortcut,
            "shortcut_behavior": config.activation.shortcut_behavior,
            "mode": config.activation.mode,
            "backend": config.activation.backend,
        },
        "transcription": {
            "mode": config.transcription.mode,
            "show_partial": config.transcription.show_partial,
            "show_raw": config.transcription.show_raw,
            "custom_vocabulary": list(config.transcription.custom_vocabulary),
            "custom_replacements": dict(config.transcription.custom_replacements),
            "partial": {
                "enabled": config.transcription.partial.enabled,
                "interval_ms": config.transcription.partial.interval_ms,
                "window_seconds": config.transcription.partial.window_seconds,
            },
        },
        "commands": {
            "mode": config.commands.mode,
            "approval_mode": config.commands.approval_mode,
            "timeout_seconds": config.commands.timeout_seconds,
            "max_output_chars": config.commands.max_output_chars,
            "working_directory": config.commands.working_directory,
            "show_risk_level": config.commands.show_risk_level,
            "blocked_patterns": list(config.commands.blocked_patterns),
        },
        "general": {
            "minimize_to_tray": config.general.minimize_to_tray,
            "start_hidden": config.general.start_hidden,
            "start_at_login": config.general.start_at_login,
            "launch_at_login": config.general.launch_at_login,
        },
        "onboarding": {
            "completed": config.onboarding.completed,
        },
        "conversation": {
            "enabled": config.conversation.enabled,
            "max_messages": config.conversation.max_messages,
            "max_turns": config.conversation.max_turns,
        },
        "context": {
            "clipboard_enabled": config.context.clipboard_enabled,
            "clipboard_auto_detect": config.context.clipboard_auto_detect,
            "max_clipboard_chars": config.context.max_clipboard_chars,
            "active_window_enabled": config.context.active_window_enabled,
            "selected_text_enabled": config.context.selected_text_enabled,
            "screen_context_enabled": config.context.screen_context_enabled,
            "screen_capture_method": config.context.screen_capture_method,
            "screen_capture_save_debug": config.context.screen_capture_save_debug,
        },
        "history": {
            "enabled": config.history.enabled,
            "persist": config.history.persist,
            "max_items": config.history.max_items,
        },
        "notifications": {
            "enabled": config.notifications.enabled,
            "notify_answer_ready": config.notifications.notify_answer_ready,
            "notify_command_complete": config.notifications.notify_command_complete,
            "notify_errors": config.notifications.notify_errors,
        },
        "terminal": {
            "command": config.terminal.command,
            "run_mode": config.terminal.run_mode,
        },
        "model_profiles": {
            "active": config.model_profiles.active,
            "profiles": {
                pid: {
                    "label": profile.label,
                    "provider": profile.provider,
                    "base_url": profile.base_url,
                    "model": profile.model,
                    "supports_vision": profile.supports_vision,
                }
                for pid, profile in config.model_profiles.profiles.items()
            },
        },
        "quick_actions": {
            "enabled": config.quick_actions.enabled,
        },
        "backend_service": {
            "host": config.backend_service.host,
            "port": config.backend_service.port,
            "auto_start": config.backend_service.auto_start,
        },
        "gnome": {
            "show_panel_indicator": config.gnome.show_panel_indicator,
            "compact_density": config.gnome.compact_density,
        },
        "debug": {
            "show_timings": config.debug.show_timings,
        },
        "needs_setup": needs_setup(config),
    }


def needs_setup(config: AppConfig) -> bool:
    """Return True if the app needs initial provider setup."""
    if not config.assistant.provider.strip():
        return True
    if not config.assistant.base_url.strip():
        return True
    if not config.assistant.model.strip():
        return True
    return not api_key_configured(config)
