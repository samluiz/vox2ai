import pytest

from vox2ai.config import AssistantConfig
from vox2ai.errors import LLMError
from vox2ai.llm import LLMClient


def test_missing_api_key_raises() -> None:
    config = AssistantConfig(
        api_key_env="VOX2AI_TEST_KEY_THAT_DOES_NOT_EXIST",
        base_url="https://api.openai.com/v1",
        model="gpt-4.1-mini",
    )
    client = LLMClient(config)
    with pytest.raises(LLMError, match="API key environment variable"):
        client.complete("system", "user prompt")


def test_empty_api_key_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VOX2AI_TEST_EMPTY_KEY", "")
    config = AssistantConfig(
        api_key_env="VOX2AI_TEST_EMPTY_KEY",
        base_url="https://api.openai.com/v1",
        model="gpt-4.1-mini",
    )
    client = LLMClient(config)
    with pytest.raises(LLMError, match="API key environment variable"):
        client.complete("system", "user prompt")


def test_api_key_present_but_connection_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VOX2AI_TEST_UNREACHABLE_KEY", "sk-test123")
    config = AssistantConfig(
        api_key_env="VOX2AI_TEST_UNREACHABLE_KEY",
        base_url="https://api-invalid.openai.com/v1",
        model="gpt-4.1-mini",
        timeout_seconds=1,
    )
    client = LLMClient(config)
    with pytest.raises(LLMError):
        client.complete("system", "user prompt")


def test_config_defaults_used() -> None:
    config = AssistantConfig()
    assert config.provider == "openai-compatible"
    assert config.base_url == "https://api.openai.com/v1"
    assert config.api_key_env == "OPENAI_API_KEY"
    assert config.model == "gpt-4.1-mini"
    assert config.temperature == 0.2
    assert config.timeout_seconds == 60
