import tomllib
from pathlib import Path

import tomli_w
from platformdirs import user_config_dir
from pydantic import BaseModel, Field, field_validator

from vox2ai.errors import ConfigError

_APP_NAME = "vox2ai"

DEFAULT_CONFIG_TOML = """\
[assistant]
provider = "openai-compatible"
base_url = "https://api.openai.com/v1"
api_key_env = "OPENAI_API_KEY"
model = "gpt-4.1-mini"
temperature = 0.2
timeout_seconds = 60

[voice]
language = "auto"
stt_backend = "faster-whisper"
whisper_model = "base"
sample_rate = 16000

[tui]
theme = "dark"

[tts]
enabled = false
backend = "none"
voice = ""
"""


class AssistantConfig(BaseModel):
    provider: str = "openai-compatible"
    base_url: str = "https://api.openai.com/v1"
    api_key_env: str = "OPENAI_API_KEY"
    model: str = "gpt-4.1-mini"
    temperature: float = 0.2
    timeout_seconds: int = 60

    @field_validator("temperature")
    @classmethod
    def validate_temperature(cls, v: float) -> float:
        if not 0 <= v <= 2:
            raise ValueError("temperature must be between 0 and 2")
        return v

    @field_validator("base_url", "api_key_env", "model")
    @classmethod
    def validate_non_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("must not be empty")
        return v

    @field_validator("timeout_seconds")
    @classmethod
    def validate_timeout_positive(cls, v: int) -> int:
        if v <= 0:
            raise ValueError("timeout_seconds must be positive")
        return v


class VoiceConfig(BaseModel):
    language: str = "auto"
    stt_backend: str = "faster-whisper"
    whisper_model: str = "base"
    sample_rate: int = 16000

    @field_validator("sample_rate")
    @classmethod
    def validate_sample_rate(cls, v: int) -> int:
        if v <= 0:
            raise ValueError("sample_rate must be positive")
        return v

    @field_validator("language")
    @classmethod
    def validate_language(cls, v: str) -> str:
        if v != "auto" and not v.strip():
            raise ValueError('language must be "auto" or a language code')
        return v


class TUIConfig(BaseModel):
    theme: str = "dark"


class TTSConfig(BaseModel):
    enabled: bool = False
    backend: str = "none"
    voice: str = ""


class AppConfig(BaseModel):
    assistant: AssistantConfig = Field(default_factory=AssistantConfig)
    voice: VoiceConfig = Field(default_factory=VoiceConfig)
    tui: TUIConfig = Field(default_factory=TUIConfig)
    tts: TTSConfig = Field(default_factory=TTSConfig)


def config_path() -> Path:
    return Path(user_config_dir(_APP_NAME, ensure_exists=True)) / "config.toml"


def ensure_config(force: bool = False) -> Path:
    path = config_path()
    if path.exists() and not force:
        return path
    parent = path.parent
    parent.mkdir(parents=True, exist_ok=True)
    path.write_text(DEFAULT_CONFIG_TOML.strip() + "\n")
    return path


def load_config() -> AppConfig:
    path = config_path()
    if not path.exists():
        raise ConfigError(f"Config not found at {path}. Run 'vox2ai init' to create one.")
    try:
        data = tomllib.loads(path.read_text())
    except tomllib.TOMLDecodeError as e:
        raise ConfigError(f"Invalid config TOML at {path}: {e}") from e
    try:
        return AppConfig.model_validate(data)
    except Exception as e:
        raise ConfigError(f"Config validation failed: {e}") from e


def save_config(config: AppConfig) -> None:
    path = config_path()
    parent = path.parent
    parent.mkdir(parents=True, exist_ok=True)
    raw = config.model_dump()
    path.write_text(tomli_w.dumps(raw))
