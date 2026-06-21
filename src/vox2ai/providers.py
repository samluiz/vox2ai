"""Provider adapter system for vox2ai.

Each provider implements a ``ProviderAdapter`` that handles authentication,
model listing, and chat completion.  OpenAI-compatible providers use a shared
adapter, while others (Gemini, Claude) need custom adapters.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass
class ProviderTemplate:
    provider_id: str
    display_name: str
    base_url: str
    auth_type: str  # "bearer", "optional", "none", "custom"
    models_endpoint: str = "/models"
    env_var_hint: str = ""


# ── Built-in provider templates ───────────────────────────────

PROVIDER_TEMPLATES: dict[str, ProviderTemplate] = {
    "openai": ProviderTemplate(
        provider_id="openai",
        display_name="OpenAI",
        base_url="https://api.openai.com/v1",
        auth_type="bearer",
        env_var_hint="OPENAI_API_KEY",
    ),
    "openrouter": ProviderTemplate(
        provider_id="openrouter",
        display_name="OpenRouter",
        base_url="https://openrouter.ai/api/v1",
        auth_type="bearer",
        env_var_hint="OPENROUTER_API_KEY",
    ),
    "lmstudio": ProviderTemplate(
        provider_id="lmstudio",
        display_name="LM Studio",
        base_url="http://localhost:1234/v1",
        auth_type="optional",
        models_endpoint="/v1/models",
    ),
    "ollama": ProviderTemplate(
        provider_id="ollama",
        display_name="Ollama",
        base_url="http://localhost:11434",
        auth_type="none",
        models_endpoint="/api/tags",
    ),
    "custom": ProviderTemplate(
        provider_id="custom",
        display_name="Custom OpenAI-compatible",
        base_url="",
        auth_type="bearer_or_none",
        models_endpoint="/v1/models",
    ),
}


def get_template(provider_id: str) -> ProviderTemplate | None:
    return PROVIDER_TEMPLATES.get(provider_id)


def list_provider_ids() -> list[str]:
    return list(PROVIDER_TEMPLATES.keys())


# ── Provider adapter base ─────────────────────────────────────


class ProviderAdapter(ABC):
    """Abstract base for provider-specific API adapters."""

    def __init__(self, base_url: str, api_key: str | None, model: str) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key or ""
        self._model = model

    @abstractmethod
    def test_connection(self) -> tuple[bool, str]:
        """Test the provider connection.  Returns (ok, message)."""
        ...

    @abstractmethod
    def list_models(self) -> tuple[list[dict[str, str]], str]:
        """Fetch available models.  Returns (models, error_message)."""
        ...


class OpenAICompatibleAdapter(ProviderAdapter):
    """Adapter for any OpenAI-compatible chat API."""

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        return headers

    def test_connection(self) -> tuple[bool, str]:
        import httpx

        try:
            resp = httpx.get(
                f"{self._base_url}/models",
                headers=self._headers(),
                timeout=10,
            )
            if resp.status_code == 200:
                return True, "Connection successful."
            if resp.status_code == 401:
                return False, "Authentication failed. Check your API key."
            return False, f"Server returned status {resp.status_code}."
        except httpx.ConnectError:
            return False, f"Could not connect to {self._base_url}."
        except httpx.TimeoutException:
            return False, "Connection timed out."
        except Exception as exc:
            return False, str(exc)

    def list_models(self) -> tuple[list[dict[str, str]], str]:
        import httpx

        try:
            resp = httpx.get(
                f"{self._base_url}/models",
                headers=self._headers(),
                timeout=15,
            )
            if resp.status_code != 200:
                return [], f"Failed to fetch models (HTTP {resp.status_code})."
            data = resp.json()
            models = [
                {"id": m.get("id", ""), "name": m.get("id", "")}
                for m in data.get("data", [])
                if isinstance(m, dict) and m.get("id")
            ]
            models.sort(key=lambda m: m["id"])
            return models, ""
        except Exception as exc:
            return [], str(exc)


class OllamaAdapter(ProviderAdapter):
    """Adapter for Ollama's local API."""

    def test_connection(self) -> tuple[bool, str]:
        import httpx

        try:
            resp = httpx.get(f"{self._base_url}/api/tags", timeout=10)
            if resp.status_code == 200:
                return True, "Ollama is running."
            return False, f"Ollama returned status {resp.status_code}."
        except httpx.ConnectError:
            return False, "Could not connect to Ollama (is it running?)."
        except Exception as exc:
            return False, str(exc)

    def list_models(self) -> tuple[list[dict[str, str]], str]:
        import httpx

        try:
            resp = httpx.get(f"{self._base_url}/api/tags", timeout=15)
            if resp.status_code != 200:
                return [], f"Failed to fetch models (HTTP {resp.status_code})."
            data = resp.json()
            models = [
                {"id": m.get("name", ""), "name": m.get("name", "")}
                for m in data.get("models", [])
                if isinstance(m, dict) and m.get("name")
            ]
            models.sort(key=lambda m: m["id"])
            return models, ""
        except Exception as exc:
            return [], str(exc)


def create_adapter(
    provider_id: str,
    base_url: str,
    api_key: str | None,
    model: str,
) -> ProviderAdapter:
    """Factory: return the appropriate adapter for a provider."""
    if provider_id == "ollama":
        return OllamaAdapter(base_url, api_key, model)
    return OpenAICompatibleAdapter(base_url, api_key, model)
