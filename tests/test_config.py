from pathlib import Path

import pytest
from pydantic import ValidationError

from vox2ai.config import (
    AppConfig,
    AssistantConfig,
    VoiceConfig,
    config_path,
    ensure_config,
    load_config,
    save_config,
)
from vox2ai.errors import ConfigError


@pytest.fixture
def isolated_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    return tmp_path


@pytest.mark.usefixtures("isolated_config")
def test_default_config_creation() -> None:
    path = ensure_config()
    assert path.exists()
    content = path.read_text()
    assert "openai-compatible" in content
    assert "OPENAI_API_KEY" in content


@pytest.mark.usefixtures("isolated_config")
def test_ensure_config_force_overwrites() -> None:
    path = ensure_config()
    original = path.read_text()

    path.write_text("# modified")
    ensure_config(force=True)
    restored = path.read_text()

    assert restored != "# modified"
    assert restored == original


@pytest.mark.usefixtures("isolated_config")
def test_load_and_save_roundtrip() -> None:
    ensure_config()
    config = load_config()
    assert isinstance(config, AppConfig)
    assert config.assistant.provider == "openai-compatible"

    config.assistant.model = "gpt-4"
    save_config(config)

    loaded = load_config()
    assert loaded.assistant.model == "gpt-4"


@pytest.mark.usefixtures("isolated_config")
def test_config_path_resolves(isolated_config: Path) -> None:
    expected = isolated_config / "vox2ai" / "config.toml"
    assert config_path() == expected


@pytest.mark.usefixtures("isolated_config")
def test_missing_config_raises() -> None:
    with pytest.raises(ConfigError, match="Config not found"):
        load_config()


@pytest.mark.usefixtures("isolated_config")
def test_invalid_toml_raises() -> None:
    from vox2ai.config import config_path

    cfg_path = config_path()
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    cfg_path.write_text("[[[invalid]]]")
    with pytest.raises(ConfigError, match="Invalid config TOML"):
        load_config()


def test_temperature_validation() -> None:
    AssistantConfig(temperature=0.0)
    AssistantConfig(temperature=1.0)
    AssistantConfig(temperature=2.0)
    with pytest.raises(ValidationError):
        AssistantConfig(temperature=-0.1)
    with pytest.raises(ValidationError):
        AssistantConfig(temperature=2.1)


def test_sample_rate_validation() -> None:
    VoiceConfig(sample_rate=8000)
    VoiceConfig(sample_rate=44100)
    with pytest.raises(ValidationError):
        VoiceConfig(sample_rate=0)
    with pytest.raises(ValidationError):
        VoiceConfig(sample_rate=-1)


def test_language_validation() -> None:
    VoiceConfig(language="auto")
    VoiceConfig(language="en")
    VoiceConfig(language="pt")
    VoiceConfig(language="fr")
    with pytest.raises(ValidationError):
        VoiceConfig(language="")


def test_non_empty_strings_validation() -> None:
    AssistantConfig(base_url="https://example.com", api_key_env="KEY", model="gpt-4")
    with pytest.raises(ValidationError):
        AssistantConfig(base_url="", api_key_env="KEY", model="gpt-4")
    with pytest.raises(ValidationError):
        AssistantConfig(base_url="https://example.com", api_key_env="", model="gpt-4")
    with pytest.raises(ValidationError):
        AssistantConfig(base_url="https://example.com", api_key_env="KEY", model="")


def test_timeout_validation() -> None:
    AssistantConfig(timeout_seconds=1)
    with pytest.raises(ValidationError):
        AssistantConfig(timeout_seconds=0)
    with pytest.raises(ValidationError):
        AssistantConfig(timeout_seconds=-5)


def test_app_config_defaults() -> None:
    cfg = AppConfig()
    assert cfg.assistant.provider == "openai-compatible"
    assert cfg.voice.language == "auto"
    assert cfg.tui.theme == "dark"
    assert cfg.tts.enabled is False
