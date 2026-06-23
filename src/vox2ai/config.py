import tomllib
from pathlib import Path
from typing import Any

import tomli_w
from platformdirs import user_config_dir
from pydantic import BaseModel, Field, field_validator

from vox2ai.errors import ConfigError
from vox2ai.shortcuts import validate_shortcut

_APP_NAME = "vox2ai"

DEFAULT_CONFIG_TOML = """\
[assistant]
provider = "openai-compatible"
base_url = "https://api.openai.com/v1"
api_key_env = "OPENAI_API_KEY"
api_key = ""
model = "gpt-4.1-mini"
temperature = 0.2
timeout_seconds = 60

[voice]
language = "auto"
language_mode = "auto"
primary_language = "en"
allowed_languages = []
min_language_probability = 0.55
stt_backend = "faster-whisper"
whisper_model = "small"
sample_rate = 16000
input_device = ""
min_duration_seconds = 0.7
min_rms = 0.003
auto_finish_enabled = true
silence_timeout_ms = 2000
speech_start_required = true
min_recording_ms = 700
max_recording_ms = 60000
voice_activity_threshold = 0.025
initial_prompt_enabled = true

[activation]
mode = "push-to-talk"
backend = "window"
key = "KEY_RIGHTCTRL"
fallback_key = "KEY_RIGHTCTRL"
global_shortcut = "Ctrl+Space"
shortcut_behavior = "show-and-record"

[recording]
activation_mode = "hold-to-talk"
shortcut = "Ctrl"

[transcription]
mode = "local-partial"
show_partial = true
refine = true
refine_mode = "auto"
show_raw = false
refiner_model = ""
custom_vocabulary = []
custom_replacements = {}

[transcription.context]
enabled = true
include_current_working_directory = true
include_git_repository_name = true
include_project_files = true
include_dependency_names = true
include_shell_commands = true
max_terms = 80

[transcription.partial]
enabled = true
interval_ms = 1600
min_audio_seconds = 1.2
window_seconds = 6.0
max_partial_chars = 220
emit_only_on_change = true
stability_strategy = "replace"
refine = false

[commands]
mode = "ask-before-run"
timeout_seconds = 30
max_output_chars = 12000
working_directory = "."
show_risk_level = true
blocked_patterns = [
  "rm ",
  "rm -",
  "sudo ",
  "shutdown",
  "reboot",
  "mkfs",
  "dd ",
  "chmod ",
  "chown ",
  "git reset",
  "git clean",
  "docker system prune",
  "docker compose down -v",
]

[performance]
preload_whisper = true
warmup_llm = false
max_workers = 2

[tui]
theme = "dark"

[tts]
enabled = false
backend = "none"
voice = ""

[general]
minimize_to_tray = true
start_hidden = true
start_at_login = false
launch_at_login = false

[onboarding]
completed = false

[conversation]
enabled = false
max_messages = 16
max_turns = 8

[context]
clipboard_enabled = true
clipboard_auto_detect = true
max_clipboard_chars = 8000
active_window_enabled = true
selected_text_enabled = false
screen_context_enabled = true
screen_capture_method = "auto"
screen_capture_save_debug = false

[history]
enabled = true
persist = false
max_items = 10

[notifications]
enabled = true
notify_answer_ready = true
notify_command_complete = true
notify_errors = true

[terminal]
command = "gnome-terminal"
run_mode = "copy-only"

[model_profiles]
active = "fast"

[model_profiles.profiles.fast]
label = "Fast"
provider = "openai-compatible"
base_url = "https://api.openai.com/v1"
api_key_env = "OPENAI_API_KEY"
model = "gpt-4.1-mini"
supports_vision = false

[model_profiles.profiles.smart]
label = "Smart"
provider = "openai-compatible"
base_url = "https://api.openai.com/v1"
api_key_env = "OPENAI_API_KEY"
model = "gpt-4.1"
supports_vision = false

[model_profiles.profiles.vision]
label = "Vision"
provider = "openai-compatible"
base_url = "https://api.openai.com/v1"
api_key_env = "OPENAI_API_KEY"
model = "gpt-4.1-mini"
supports_vision = true

[model_profiles.profiles.local]
label = "Local"
provider = "openai-compatible"
base_url = "http://localhost:11434/v1"
api_key_env = "OLLAMA_API_KEY"
model = "llama3.2"
supports_vision = false

[quick_actions]
enabled = true

[backend_service]
host = "127.0.0.1"
port = 8765
auto_start = true

[gnome]
show_panel_indicator = true
compact_density = true

[debug]
enabled = false
show_timings = false
log_file = ""
"""


class AssistantConfig(BaseModel):
    provider: str = "openai-compatible"
    base_url: str = "https://api.openai.com/v1"
    api_key_env: str = "OPENAI_API_KEY"
    api_key: str = ""
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

    @field_validator("api_key")
    @classmethod
    def strip_api_key(cls, v: str) -> str:
        return v.strip()

    @field_validator("timeout_seconds")
    @classmethod
    def validate_timeout_positive(cls, v: int) -> int:
        if v <= 0:
            raise ValueError("timeout_seconds must be positive")
        return v


class VoiceConfig(BaseModel):
    language: str = "auto"
    language_mode: str = "auto"
    primary_language: str = "en"
    allowed_languages: list[str] = Field(default_factory=list)
    min_language_probability: float = 0.55
    stt_backend: str = "faster-whisper"
    whisper_model: str = "small"
    sample_rate: int = 16000
    input_device: str = ""
    min_duration_seconds: float = 0.7
    min_rms: float = 0.003
    auto_finish_enabled: bool = True
    silence_timeout_ms: int = 2000
    speech_start_required: bool = True
    min_recording_ms: int = 700
    max_recording_ms: int = 60000
    voice_activity_threshold: float = 0.025
    initial_prompt_enabled: bool = True

    @field_validator("sample_rate")
    @classmethod
    def validate_sample_rate(cls, v: int) -> int:
        if v <= 0:
            raise ValueError("sample_rate must be positive")
        return v

    @field_validator("input_device")
    @classmethod
    def strip_input_device(cls, v: str) -> str:
        return v.strip()

    @field_validator("language")
    @classmethod
    def validate_language(cls, v: str) -> str:
        if v != "auto" and not v.strip():
            raise ValueError('language must be "auto" or a language code')
        return v

    @field_validator("language_mode")
    @classmethod
    def validate_language_mode(cls, v: str) -> str:
        allowed = {"auto", "force", "constrained-auto"}
        if v not in allowed:
            raise ValueError(f"language_mode must be one of {allowed}")
        return v

    @field_validator("primary_language")
    @classmethod
    def validate_primary_language(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("primary_language must be non-empty")
        return v

    @field_validator("allowed_languages")
    @classmethod
    def validate_allowed_languages(cls, v: list[str]) -> list[str]:
        for lang in v:
            if not lang.strip():
                raise ValueError("allowed_languages entries must be non-empty")
        return v

    @field_validator("min_language_probability")
    @classmethod
    def validate_min_lang_prob(cls, v: float) -> float:
        if not 0.0 <= v <= 1.0:
            raise ValueError("min_language_probability must be between 0.0 and 1.0")
        return v

    @field_validator("min_duration_seconds")
    @classmethod
    def validate_min_duration(cls, v: float) -> float:
        if v < 0:
            raise ValueError("min_duration_seconds must be non-negative")
        return v

    @field_validator("min_rms")
    @classmethod
    def validate_min_rms(cls, v: float) -> float:
        if v < 0:
            raise ValueError("min_rms must be non-negative")
        return v

    @field_validator("silence_timeout_ms", "min_recording_ms", "max_recording_ms")
    @classmethod
    def validate_recording_ms(cls, v: int) -> int:
        if v <= 0:
            raise ValueError("recording timing values must be positive")
        return v

    @field_validator("voice_activity_threshold")
    @classmethod
    def validate_voice_activity_threshold(cls, v: float) -> float:
        if v < -0.2:
            raise ValueError("voice_activity_threshold must be >= -0.2")
        return v


class TranscriptionContextConfig(BaseModel):
    enabled: bool = True
    include_current_working_directory: bool = True
    include_git_repository_name: bool = True
    include_project_files: bool = True
    include_dependency_names: bool = True
    include_shell_commands: bool = True
    max_terms: int = 80


class PartialTranscriptionConfig(BaseModel):
    enabled: bool = True
    interval_ms: int = 1600
    min_audio_seconds: float = 1.2
    window_seconds: float = 6.0
    max_partial_chars: int = 220
    emit_only_on_change: bool = True
    stability_strategy: str = "replace"
    refine: bool = False

    @field_validator("interval_ms")
    @classmethod
    def validate_interval_positive(cls, v: int) -> int:
        if v <= 0:
            raise ValueError("interval_ms must be positive")
        return v

    @field_validator("min_audio_seconds", "window_seconds")
    @classmethod
    def validate_positive_float(cls, v: float) -> float:
        if v <= 0:
            raise ValueError("must be positive")
        return v

    @field_validator("max_partial_chars")
    @classmethod
    def validate_max_partial_chars(cls, v: int) -> int:
        if v <= 0:
            raise ValueError("max_partial_chars must be positive")
        return v

    @field_validator("stability_strategy")
    @classmethod
    def validate_stability_strategy(cls, v: str) -> str:
        allowed = {"replace"}
        if v not in allowed:
            raise ValueError(f"stability_strategy must be one of {allowed}")
        return v


class TranscriptionConfig(BaseModel):
    mode: str = "local-partial"
    show_partial: bool = True
    refine: bool = True
    refine_mode: str = "auto"
    show_raw: bool = False
    refiner_model: str = ""
    custom_vocabulary: list[str] = Field(default_factory=list)
    custom_replacements: dict[str, str] = Field(default_factory=dict)
    context: TranscriptionContextConfig = Field(default_factory=TranscriptionContextConfig)
    partial: PartialTranscriptionConfig = Field(default_factory=PartialTranscriptionConfig)

    @field_validator("mode")
    @classmethod
    def validate_mode(cls, v: str) -> str:
        allowed = {"final", "local-partial"}
        if v not in allowed:
            raise ValueError(f"transcription.mode must be one of {allowed}")
        return v


class ActivationConfig(BaseModel):
    mode: str = "push-to-talk"
    backend: str = "window"
    key: str = "KEY_RIGHTCTRL"
    fallback_key: str = "KEY_RIGHTCTRL"
    global_shortcut: str = "Ctrl+Space"
    shortcut_behavior: str = "show-and-record"

    @field_validator("backend")
    @classmethod
    def validate_backend(cls, v: str) -> str:
        allowed = {"window", "evdev"}
        if v not in allowed:
            raise ValueError(f"activation.backend must be one of {allowed}")
        return v

    @field_validator("global_shortcut")
    @classmethod
    def validate_global_shortcut(cls, v: str) -> str:
        return validate_shortcut(v, allow_modifier_only=False)

    @field_validator("shortcut_behavior")
    @classmethod
    def validate_shortcut_behavior(cls, v: str) -> str:
        allowed = {"show-widget", "show-and-focus-input", "show-and-record", "toggle-widget"}
        if v not in allowed:
            raise ValueError(f"activation.shortcut_behavior must be one of {allowed}")
        return v


class RecordingConfig(BaseModel):
    activation_mode: str = "hold-to-talk"
    shortcut: str = "Ctrl"

    @field_validator("activation_mode")
    @classmethod
    def validate_activation_mode(cls, v: str) -> str:
        allowed = {"hold-to-talk", "toggle-to-talk"}
        if v not in allowed:
            raise ValueError(f"recording.activation_mode must be one of {allowed}")
        return v

    @field_validator("shortcut")
    @classmethod
    def validate_shortcut(cls, v: str) -> str:
        return validate_shortcut(v, allow_modifier_only=True)


class OverlayConfig(BaseModel):
    enabled: bool = True
    position: str = "top-center"
    width: int = 860
    min_height: int = 72
    max_height: int = 280
    margin_top: int = 24
    active_opacity: float = 0.96
    inactive_opacity: float = 0.06
    fade_after_seconds: int = 6
    fade_duration_ms: int = 220
    always_visible: bool = True
    always_on_top: bool = True
    restore_opacity_on_hover: bool = True
    restore_opacity_on_activity: bool = True
    auto_hide: bool = False
    show_partial_states: bool = True

    @field_validator("inactive_opacity")
    @classmethod
    def validate_inactive_opacity(cls, v: float) -> float:
        if v <= 0 or v >= 1:
            raise ValueError("inactive_opacity must be > 0 and < 1")
        return v

    @field_validator("active_opacity")
    @classmethod
    def validate_active_opacity(cls, v: float) -> float:
        if v <= 0 or v > 1:
            raise ValueError("active_opacity must be > 0 and <= 1")
        return v


class CommandsConfig(BaseModel):
    mode: str = "ask-before-run"
    timeout_seconds: int = 30
    max_output_chars: int = 12000
    working_directory: str = "."
    show_risk_level: bool = True
    blocked_patterns: list[str] = [
        "rm ",
        "rm -",
        "sudo ",
        "shutdown",
        "reboot",
        "mkfs",
        "dd ",
        "chmod ",
        "chown ",
        "git reset",
        "git clean",
        "docker system prune",
        "docker compose down -v",
    ]

    @field_validator("mode")
    @classmethod
    def validate_mode(cls, v: str) -> str:
        allowed = {"disabled", "ask-before-run", "allow-all"}
        if v not in allowed:
            raise ValueError(f"commands.mode must be one of {allowed}")
        return v


class PerformanceConfig(BaseModel):
    preload_whisper: bool = True
    warmup_llm: bool = False
    max_workers: int = 2


class TUIConfig(BaseModel):
    theme: str = "dark"


class TTSConfig(BaseModel):
    enabled: bool = False
    backend: str = "none"
    voice: str = ""


class GeneralConfig(BaseModel):
    minimize_to_tray: bool = True
    start_hidden: bool = True
    start_at_login: bool = False
    launch_at_login: bool = False


class OnboardingConfig(BaseModel):
    completed: bool = False


class ConversationConfig(BaseModel):
    enabled: bool = False
    max_messages: int = 16
    max_turns: int = 8

    @field_validator("max_messages", "max_turns")
    @classmethod
    def validate_max_messages(cls, v: int) -> int:
        if v <= 0:
            raise ValueError("conversation limits must be positive")
        return v


class ContextConfig(BaseModel):
    clipboard_enabled: bool = True
    clipboard_auto_detect: bool = True
    max_clipboard_chars: int = 8000
    active_window_enabled: bool = True
    selected_text_enabled: bool = False
    screen_context_enabled: bool = True
    screen_capture_method: str = "auto"
    screen_capture_save_debug: bool = False

    @field_validator("max_clipboard_chars")
    @classmethod
    def validate_max_clipboard_chars(cls, v: int) -> int:
        if v <= 0:
            raise ValueError("context.max_clipboard_chars must be positive")
        return v

    @field_validator("screen_capture_method")
    @classmethod
    def validate_screen_capture_method(cls, v: str) -> str:
        allowed = {"auto", "gnome-screenshot", "portal"}
        if v not in allowed:
            raise ValueError(f"context.screen_capture_method must be one of {allowed}")
        return v


class HistoryConfig(BaseModel):
    enabled: bool = True
    persist: bool = False
    max_items: int = 10

    @field_validator("max_items")
    @classmethod
    def validate_max_items(cls, v: int) -> int:
        if v <= 0:
            raise ValueError("history.max_items must be positive")
        return v


class NotificationsConfig(BaseModel):
    enabled: bool = True
    notify_answer_ready: bool = True
    notify_command_complete: bool = True
    notify_errors: bool = True


class TerminalConfig(BaseModel):
    command: str = "gnome-terminal"
    run_mode: str = "copy-only"

    @field_validator("run_mode")
    @classmethod
    def validate_run_mode(cls, v: str) -> str:
        allowed = {"prefill", "copy-only"}
        if v not in allowed:
            raise ValueError(f"terminal.run_mode must be one of {allowed}")
        return v


class ModelProfileConfig(BaseModel):
    label: str = ""
    provider: str = ""
    base_url: str = ""
    api_key_env: str = ""
    model: str = ""
    supports_vision: bool = False


class ModelProfilesConfig(BaseModel):
    active: str = "fast"
    profiles: dict[str, ModelProfileConfig] = Field(
        default_factory=lambda: {
            "fast": ModelProfileConfig(
                label="Fast",
                provider="openai-compatible",
                base_url="https://api.openai.com/v1",
                api_key_env="OPENAI_API_KEY",
                model="gpt-4.1-mini",
            ),
            "smart": ModelProfileConfig(
                label="Smart",
                provider="openai-compatible",
                base_url="https://api.openai.com/v1",
                api_key_env="OPENAI_API_KEY",
                model="gpt-4.1",
            ),
            "vision": ModelProfileConfig(
                label="Vision",
                provider="openai-compatible",
                base_url="https://api.openai.com/v1",
                api_key_env="OPENAI_API_KEY",
                model="gpt-4.1-mini",
                supports_vision=True,
            ),
            "local": ModelProfileConfig(
                label="Local",
                provider="openai-compatible",
                base_url="http://localhost:11434/v1",
                api_key_env="OLLAMA_API_KEY",
                model="llama3.2",
            ),
        }
    )

    @field_validator("active")
    @classmethod
    def validate_active(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("model_profiles.active must be non-empty")
        return v


class QuickActionsConfig(BaseModel):
    enabled: bool = True


class BackendServiceConfig(BaseModel):
    host: str = "127.0.0.1"
    port: int = 8765
    auto_start: bool = True


class GnomeConfig(BaseModel):
    show_panel_indicator: bool = True
    compact_density: bool = True


class DebugConfig(BaseModel):
    enabled: bool = False
    show_timings: bool = False
    log_file: str = ""


class AppConfig(BaseModel):
    assistant: AssistantConfig = Field(default_factory=AssistantConfig)
    voice: VoiceConfig = Field(default_factory=VoiceConfig)
    activation: ActivationConfig = Field(default_factory=ActivationConfig)
    recording: RecordingConfig = Field(default_factory=RecordingConfig)
    transcription: TranscriptionConfig = Field(default_factory=TranscriptionConfig)
    overlay: OverlayConfig = Field(default_factory=OverlayConfig)
    commands: CommandsConfig = Field(default_factory=CommandsConfig)
    performance: PerformanceConfig = Field(default_factory=PerformanceConfig)
    backend_service: BackendServiceConfig = Field(default_factory=BackendServiceConfig)
    gnome: GnomeConfig = Field(default_factory=GnomeConfig)
    tui: TUIConfig = Field(default_factory=TUIConfig)
    tts: TTSConfig = Field(default_factory=TTSConfig)
    general: GeneralConfig = Field(default_factory=GeneralConfig)
    onboarding: OnboardingConfig = Field(default_factory=OnboardingConfig)
    conversation: ConversationConfig = Field(default_factory=ConversationConfig)
    context: ContextConfig = Field(default_factory=ContextConfig)
    history: HistoryConfig = Field(default_factory=HistoryConfig)
    notifications: NotificationsConfig = Field(default_factory=NotificationsConfig)
    terminal: TerminalConfig = Field(default_factory=TerminalConfig)
    model_profiles: ModelProfilesConfig = Field(default_factory=ModelProfilesConfig)
    quick_actions: QuickActionsConfig = Field(default_factory=QuickActionsConfig)
    debug: DebugConfig = Field(default_factory=DebugConfig)

    model_config = {"extra": "ignore"}


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


def _migrate_voice_config(data: dict[str, object]) -> dict[str, object]:
    """Backward compatibility: migrate old ``language`` key to new language_mode fields."""
    voice = data.get("voice")
    if not isinstance(voice, dict):
        return data
    if "language_mode" not in voice and "language" in voice:
        lang_val = voice["language"]
        if isinstance(lang_val, str):
            if lang_val == "auto":
                voice.setdefault("language_mode", "auto")
            else:
                voice["language_mode"] = "force"
                voice.setdefault("primary_language", lang_val)
    return data


def _migrate_general_config(data: dict[str, object]) -> dict[str, object]:
    """Backward compatibility: map old ``launch_at_login`` to ``start_at_login``."""
    general = data.get("general")
    if not isinstance(general, dict):
        return data
    if "start_at_login" not in general and "launch_at_login" in general:
        general["start_at_login"] = general["launch_at_login"]
    return data


def load_config() -> AppConfig:
    path = config_path()
    if not path.exists():
        raise ConfigError(f"Config not found at {path}. Run 'vox2ai init' to create one.")
    try:
        data = tomllib.loads(path.read_text())
    except tomllib.TOMLDecodeError as e:
        raise ConfigError(f"Invalid config TOML at {path}: {e}") from e
    try:
        data = _migrate_voice_config(data)
        data = _migrate_general_config(data)
        data = migrate_config_for_model_profiles(data)
        return AppConfig.model_validate(data)
    except Exception as e:
        raise ConfigError(f"Config validation failed: {e}") from e


def _backup_config(path: Path) -> None:
    """Create a timestamped backup before overwriting config."""
    if not path.exists():
        return
    import shutil
    from datetime import datetime

    backup_dir = path.parent / "backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = backup_dir / f"config.backup.{ts}.toml"
    shutil.copy2(path, backup_path)


def migrate_config_for_model_profiles(data: dict[str, Any]) -> dict[str, Any]:
    """Ensure existing provider/api_key settings are preserved in model_profiles.

    If the user had an existing [assistant] config but no [model_profiles] section,
    create model profiles derived from their existing provider/model/api_key.
    Never overwrite existing model profiles.
    """
    if "model_profiles" in data and "profiles" in data.get("model_profiles", {}):
        profiles = data["model_profiles"]["profiles"]
        if isinstance(profiles, dict) and len(profiles) > 0:
            return data  # Profiles already configured, nothing to migrate.

    assistant = data.get("assistant", {})
    if not isinstance(assistant, dict):
        return data
    provider = assistant.get("provider", "openai-compatible")
    base_url = assistant.get("base_url", "https://api.openai.com/v1")
    api_key_env = assistant.get("api_key_env", "OPENAI_API_KEY")
    model = assistant.get("model", "gpt-4.1-mini")

    profiles = {
        "fast": {
            "label": "Fast",
            "provider": provider,
            "base_url": base_url,
            "api_key_env": api_key_env,
            "model": model,
            "supports_vision": False,
        },
        "smart": {
            "label": "Smart",
            "provider": provider,
            "base_url": base_url,
            "api_key_env": api_key_env,
            "model": model,
            "supports_vision": False,
        },
        "vision": {
            "label": "Vision",
            "provider": provider,
            "base_url": base_url,
            "api_key_env": api_key_env,
            "model": model,
            "supports_vision": True,
        },
        "local": {
            "label": "Local",
            "provider": "openai-compatible",
            "base_url": "http://localhost:11434/v1",
            "api_key_env": "OLLAMA_API_KEY",
            "model": "llama3.2",
            "supports_vision": False,
        },
    }
    data["model_profiles"] = {"active": "fast", "profiles": profiles}
    return data


def save_config(config: AppConfig) -> None:
    path = config_path()
    parent = path.parent
    parent.mkdir(parents=True, exist_ok=True)
    _backup_config(path)
    raw = config.model_dump()
    path.write_text(tomli_w.dumps(raw))
