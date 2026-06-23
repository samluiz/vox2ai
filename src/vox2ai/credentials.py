"""Credential resolution helpers."""

from __future__ import annotations

import os

from vox2ai.config import AssistantConfig
from vox2ai.secrets import get_secret_store


def resolve_api_key(config: AssistantConfig, override: str | None = None) -> str:
    """Resolve an API key without exposing where it came from to callers."""
    candidates = (
        override,
        os.environ.get(config.api_key_env),
        get_secret_store().get("api_key"),
        config.api_key,
    )
    for candidate in candidates:
        key = (candidate or "").strip()
        if key:
            return key
    return ""
