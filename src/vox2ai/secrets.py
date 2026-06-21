"""Secret storage for API keys.

Uses the Python ``keyring`` package when available, falling back to
config-file-backed storage with a warning.
"""

from __future__ import annotations

import contextlib
import logging
from typing import Protocol

logger = logging.getLogger("vox2ai")

_SERVICE_NAME = "vox2ai"


class SecretStore(Protocol):
    def save(self, key: str, value: str) -> None: ...
    def get(self, key: str) -> str | None: ...
    def delete(self, key: str) -> None: ...


class KeyringStore:
    """Uses the OS keyring via the ``keyring`` package."""

    def save(self, key: str, value: str) -> None:
        import keyring

        keyring.set_password(_SERVICE_NAME, key, value)

    def get(self, key: str) -> str | None:
        import keyring

        val = keyring.get_password(_SERVICE_NAME, key)
        return str(val) if val is not None else None

    def delete(self, key: str) -> None:
        import keyring

        with contextlib.suppress(keyring.errors.PasswordDeleteError):
            keyring.delete_password(_SERVICE_NAME, key)


class FallbackStore:
    """Config-file-backed fallback.

    Stores secrets in memory during the session and writes to config
    only when explicitly requested.  This is less secure than keyring
    but works without extra dependencies.
    """

    def __init__(self, storage: dict[str, str] | None = None) -> None:
        self._storage: dict[str, str] = storage if storage is not None else {}

    def save(self, key: str, value: str) -> None:
        self._storage[key] = value

    def get(self, key: str) -> str | None:
        return self._storage.get(key)

    def delete(self, key: str) -> None:
        self._storage.pop(key, None)


# ── Singleton resolution ──────────────────────────────────────

_secret_store: SecretStore | None = None


def get_secret_store() -> SecretStore:
    global _secret_store
    if _secret_store is not None:
        return _secret_store

    try:
        import keyring  # noqa: F401

        _secret_store = KeyringStore()
        logger.info("Using keyring-backed secret store")
    except ImportError:
        _secret_store = FallbackStore()
        logger.info("keyring not available; using in-memory secret store")

    return _secret_store


def set_secret_store(store: SecretStore) -> None:
    global _secret_store
    _secret_store = store


def mask_api_key(key: str | None) -> str | None:
    """Return a masked preview of an API key (safe for UI/logs)."""
    if not key:
        return None
    if len(key) <= 8:
        return key[:3] + "…"
    return key[:4] + "…" + key[-4:]
