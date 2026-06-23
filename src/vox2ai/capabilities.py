"""Backend capability contract for the GNOME Shell extension."""

from __future__ import annotations

from typing import Any

from vox2ai.audio_input import list_input_devices
from vox2ai.config import AppConfig
from vox2ai.screen_context import ocr_status, screen_capture_status
from vox2ai.settings import api_key_configured


def build_capabilities(
    config: AppConfig,
    *,
    conversation: dict[str, Any],
    last_audio_error: str | None = None,
    last_screen_error: str | None = None,
) -> dict[str, Any]:
    audio_available, audio_reason = _audio_status()
    screen_status = screen_capture_status(config)
    ocr = ocr_status()
    supports_vision = _active_profile_supports_vision(config)
    screen_enabled = bool(config.context.screen_context_enabled)
    screen_available = bool(screen_status["available"])
    vision_available = screen_available and supports_vision
    ocr_available = screen_available and bool(ocr["available"])

    return {
        "type": "capabilities",
        "capabilities": {
            "text_prompt": {"available": True},
            "voice_prompt": {
                "available": audio_available,
                "reason": None if audio_available else audio_reason,
            },
            "auto_finish_recording": {"available": audio_available},
            "audio_input_test": {
                "available": audio_available,
                "reason": None if audio_available else audio_reason,
            },
            "conversation": {"available": True},
            "screen_capture": {
                "available": screen_enabled and screen_available,
                "method": screen_status["method"],
                "reason": None if screen_enabled and screen_available else screen_status["reason"],
            },
            "vision": {
                "available": vision_available,
                "reason": None
                if vision_available
                else "Active model is not marked as vision-capable",
            },
            "ocr": {
                "available": ocr_available,
                "engine": ocr["engine"],
                "reason": None if ocr_available else ocr["reason"],
            },
            "commands": {"available": config.commands.mode != "disabled"},
        },
        "audio": {
            "input_available": audio_available,
            "input_device": config.voice.input_device or "default",
            "sample_rate": config.voice.sample_rate,
            "last_error": last_audio_error
            if last_audio_error
            else (None if audio_available else audio_reason),
        },
        "assistant": {
            "provider_configured": bool(config.assistant.provider and config.assistant.base_url),
            "api_key_present": api_key_configured(config),
            "api_key_source": _api_key_source(config),
            "model": config.assistant.model,
            "supports_vision": supports_vision,
        },
        "conversation": conversation,
        "screen": {
            "capture_available": screen_enabled and screen_available,
            "capture_method": screen_status["method"],
            "vision_available": vision_available,
            "ocr_available": ocr_available,
            "ocr_engine": ocr["engine"],
            "last_error": last_screen_error,
        },
    }


def _audio_status() -> tuple[bool, str | None]:
    try:
        devices = list_input_devices()
    except Exception as exc:
        return False, str(exc)
    if not devices:
        return False, "No microphone input devices found."
    return True, None


def _active_profile_supports_vision(config: AppConfig) -> bool:
    profile = config.model_profiles.profiles.get(config.model_profiles.active)
    if profile is None:
        return False
    return bool(profile.supports_vision)


def _api_key_source(config: AppConfig) -> str:
    import os

    from vox2ai.secrets import get_secret_store

    if os.environ.get(config.assistant.api_key_env):
        return "env"
    if get_secret_store().get("api_key"):
        return "keyring"
    if config.assistant.api_key:
        return "config"
    return "unknown"
