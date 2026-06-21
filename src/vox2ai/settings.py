"""Config sanitization helpers for the settings UI.

These functions strip sensitive fields, validate patches, and
produce dicts safe to send to the frontend.
"""

from __future__ import annotations

from vox2ai.config import AppConfig
from vox2ai.secrets import mask_api_key


def sanitize_config(config: AppConfig) -> dict[str, object]:
    """Return a config dict safe to send to the frontend.

    * Never includes the full API key.
    * Never includes raw_text or internal fields.
    """
    return {
        "assistant": {
            "provider": config.assistant.provider,
            "base_url": config.assistant.base_url,
            "model": config.assistant.model,
            "temperature": config.assistant.temperature,
            "timeout_seconds": config.assistant.timeout_seconds,
            "api_key_configured": bool(config.assistant.api_key_env),
            "api_key_preview": mask_api_key(config.assistant.api_key_env or None),
        },
        "voice": {
            "language_mode": config.voice.language_mode,
            "primary_language": config.voice.primary_language,
            "allowed_languages": list(config.voice.allowed_languages),
            "min_language_probability": config.voice.min_language_probability,
            "whisper_model": config.voice.whisper_model,
            "language": config.voice.language,
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
            "blocked_patterns": list(config.commands.blocked_patterns),
        },
        "desktop_window": {
            "always_on_top": config.desktop_window.always_on_top,
            "active_opacity": config.desktop_window.active_opacity,
            "inactive_opacity": config.desktop_window.inactive_opacity,
            "fade_after_seconds": config.desktop_window.fade_after_seconds,
            "position": config.desktop_window.position,
        },
        "debug": {
            "show_timings": config.debug.show_timings,
        },
        "needs_setup": not bool(config.assistant.api_key_env),
    }


def needs_setup(config: AppConfig) -> bool:
    """Return True if the app needs initial setup (no API key configured)."""
    key_env = config.assistant.api_key_env
    if not key_env:
        return True
    import os

    return not bool(os.environ.get(key_env))
