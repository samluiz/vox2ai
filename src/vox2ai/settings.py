"""Config sanitization helpers for the settings UI.

These functions strip sensitive fields, validate patches, and
produce dicts safe to send to the frontend.
"""

from __future__ import annotations

import os

from vox2ai.config import AppConfig
from vox2ai.secrets import get_secret_store, mask_api_key


def api_key_configured(config: AppConfig) -> bool:
    """Return True when an API key is available from env or the secret store."""
    if get_secret_store().get("api_key"):
        return True
    key_env = config.assistant.api_key_env
    return bool(key_env and os.environ.get(key_env))


def sanitize_config(config: AppConfig) -> dict[str, object]:
    """Return a config dict safe to send to the frontend.

    * Never includes the full API key.
    * Never includes raw_text or internal fields.
    """
    configured_key = api_key_configured(config)
    env_key = os.environ.get(config.assistant.api_key_env, "")
    secret_key = get_secret_store().get("api_key") or ""
    return {
        "assistant": {
            "provider": config.assistant.provider,
            "base_url": config.assistant.base_url,
            "model": config.assistant.model,
            "temperature": config.assistant.temperature,
            "timeout_seconds": config.assistant.timeout_seconds,
            "api_key_env": config.assistant.api_key_env,
            "api_key_configured": configured_key,
            "api_key_preview": mask_api_key(secret_key or env_key or None),
        },
        "voice": {
            "language_mode": config.voice.language_mode,
            "primary_language": config.voice.primary_language,
            "allowed_languages": list(config.voice.allowed_languages),
            "min_language_probability": config.voice.min_language_probability,
            "whisper_model": config.voice.whisper_model,
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
        },
        "context": {
            "clipboard_enabled": config.context.clipboard_enabled,
            "clipboard_auto_detect": config.context.clipboard_auto_detect,
            "max_clipboard_chars": config.context.max_clipboard_chars,
            "active_window_enabled": config.context.active_window_enabled,
            "selected_text_enabled": config.context.selected_text_enabled,
        },
        "quick_actions": {
            "enabled": config.quick_actions.enabled,
        },
        "desktop_window": {
            "user_resizable": config.desktop_window.user_resizable,
            "remember_size": config.desktop_window.remember_size,
            "remember_position": config.desktop_window.remember_position,
            "manual_size": config.desktop_window.manual_size,
            "width": config.desktop_window.width,
            "height": config.desktop_window.height,
            "always_on_top": config.desktop_window.always_on_top,
            "summon_position": config.desktop_window.summon_position,
            "auto_hide_after_answer": config.desktop_window.auto_hide_after_answer,
            "auto_hide_delay_ms": config.desktop_window.auto_hide_delay_ms,
            "active_opacity": config.desktop_window.active_opacity,
            "inactive_opacity": config.desktop_window.inactive_opacity,
            "fade_after_seconds": config.desktop_window.fade_after_seconds,
            "position": config.desktop_window.position,
        },
        "desktop": {
            "auto_restart_backend": config.desktop.auto_restart_backend,
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
