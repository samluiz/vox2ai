from pathlib import Path

import pytest
from pydantic import ValidationError

from vox2ai.config import (
    ActivationConfig,
    AppConfig,
    AssistantConfig,
    CommandsConfig,
    OverlayConfig,
    PartialTranscriptionConfig,
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
    assert 'backend = "window"' in content
    assert 'whisper_model = "small"' in content
    assert "[transcription]" in content
    assert "[performance]" in content
    assert "[debug]" in content
    assert "[commands]" in content
    assert "[transcription.partial]" in content


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
    cfg_path = config_path()
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    cfg_path.write_text("[[[invalid]]]")
    with pytest.raises(ConfigError, match="Invalid config TOML"):
        load_config()


def test_temperature_validation() -> None:
    with pytest.raises(ValidationError):
        AssistantConfig(temperature=-0.1)
    with pytest.raises(ValidationError):
        AssistantConfig(temperature=2.1)


def test_sample_rate_validation() -> None:
    with pytest.raises(ValidationError):
        VoiceConfig(sample_rate=0)


def test_language_validation() -> None:
    VoiceConfig(language="auto")
    VoiceConfig(language="en")
    with pytest.raises(ValidationError):
        VoiceConfig(language="")


def test_non_empty_strings_validation() -> None:
    with pytest.raises(ValidationError):
        AssistantConfig(base_url="", api_key_env="KEY", model="gpt-4")
    with pytest.raises(ValidationError):
        AssistantConfig(base_url="https://example.com", api_key_env="", model="gpt-4")
    with pytest.raises(ValidationError):
        AssistantConfig(base_url="https://example.com", api_key_env="KEY", model="")


def test_timeout_validation() -> None:
    with pytest.raises(ValidationError):
        AssistantConfig(timeout_seconds=0)


def test_app_config_defaults() -> None:
    cfg = AppConfig()
    assert cfg.activation.backend == "window"
    assert cfg.overlay.always_visible is True
    assert cfg.overlay.auto_hide is False
    assert cfg.overlay.active_opacity == 0.96
    assert cfg.overlay.inactive_opacity == 0.06
    assert cfg.overlay.inactive_opacity > 0
    assert cfg.overlay.inactive_opacity < cfg.overlay.active_opacity
    assert cfg.overlay.fade_after_seconds == 6
    assert cfg.voice.whisper_model == "small"
    assert cfg.performance.preload_whisper is True
    assert cfg.debug.show_timings is False
    assert cfg.transcription.refine is True
    assert cfg.transcription.context.enabled is True


@pytest.mark.usefixtures("isolated_config")
def test_old_minimal_config_loads_with_defaults() -> None:
    """Backward compatibility: old config missing new sections gets defaults."""
    old_toml = """\
[assistant]
provider = "test"
base_url = "http://localhost"
api_key_env = "TEST_KEY"
model = "test-model"
temperature = 0.5
timeout_seconds = 30

[voice]
language = "en"
whisper_model = "tiny"
sample_rate = 8000
"""
    cfg_path = config_path()
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    cfg_path.write_text(old_toml)
    cfg = load_config()
    assert cfg.assistant.provider == "test"
    assert cfg.voice.language == "en"
    # New sections get defaults
    assert cfg.activation.backend == "window"
    assert cfg.overlay.always_visible is True
    assert cfg.overlay.auto_hide is False
    assert cfg.transcription.refine is True
    assert cfg.performance.preload_whisper is True
    assert cfg.debug.show_timings is False


def test_activation_backend_validation() -> None:
    ActivationConfig(backend="window")
    ActivationConfig(backend="evdev")
    with pytest.raises(ValidationError):
        ActivationConfig(backend="x11")


def test_overlay_opacity_validation() -> None:
    OverlayConfig(active_opacity=1.0, inactive_opacity=0.04)
    with pytest.raises(ValidationError):
        OverlayConfig(inactive_opacity=0.0)
    with pytest.raises(ValidationError):
        OverlayConfig(active_opacity=0.0)
    with pytest.raises(ValidationError):
        OverlayConfig(active_opacity=1.5)


def test_commands_mode_validation() -> None:
    CommandsConfig(mode="ask-before-run")
    CommandsConfig(mode="allow-all")
    CommandsConfig(mode="disabled")
    with pytest.raises(ValidationError):
        CommandsConfig(mode="always")


def test_partial_transcription_defaults() -> None:
    partial = PartialTranscriptionConfig()
    assert partial.enabled is True
    assert partial.interval_ms == 1600
    assert partial.min_audio_seconds == 1.2
    assert partial.window_seconds == 6.0
    assert partial.max_partial_chars == 220
    assert partial.emit_only_on_change is True
    assert partial.stability_strategy == "replace"
    assert partial.refine is False


def test_partial_transcription_validation() -> None:
    with pytest.raises(ValidationError):
        PartialTranscriptionConfig(interval_ms=0)
    with pytest.raises(ValidationError):
        PartialTranscriptionConfig(min_audio_seconds=0)
    with pytest.raises(ValidationError):
        PartialTranscriptionConfig(window_seconds=-1)
    with pytest.raises(ValidationError):
        PartialTranscriptionConfig(max_partial_chars=0)
    with pytest.raises(ValidationError):
        PartialTranscriptionConfig(stability_strategy="append")


def test_transcription_mode_validation() -> None:
    from vox2ai.config import TranscriptionConfig

    TranscriptionConfig(mode="final")
    TranscriptionConfig(mode="local-partial")
    with pytest.raises(ValidationError):
        TranscriptionConfig(mode="realtime")


def test_app_config_partial_transcription_defaults() -> None:
    cfg = AppConfig()
    assert cfg.transcription.mode == "local-partial"
    assert cfg.transcription.show_partial is True
    assert cfg.transcription.partial.enabled is True
    assert cfg.transcription.partial.refine is False


@pytest.mark.usefixtures("isolated_config")
def test_old_minimal_config_loads_with_partial_defaults() -> None:
    old_toml = """\
[assistant]
provider = "test"
base_url = "http://localhost"
api_key_env = "TEST_KEY"
model = "test-model"
temperature = 0.5
timeout_seconds = 30

[voice]
language = "en"
whisper_model = "tiny"
sample_rate = 8000
"""
    cfg_path = config_path()
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    cfg_path.write_text(old_toml)
    cfg = load_config()
    assert cfg.transcription.mode == "local-partial"
    assert cfg.transcription.show_partial is True
    assert cfg.transcription.partial.enabled is True
    assert cfg.transcription.partial.interval_ms == 1600
