class Vox2AIError(Exception):
    """Base exception for all vox2ai errors."""


class ConfigError(Vox2AIError):
    """Configuration related errors."""


class AudioError(Vox2AIError):
    """Audio recording or device errors."""


class TranscriptionError(Vox2AIError):
    """Speech-to-text transcription errors."""


class LLMError(Vox2AIError):
    """LLM API communication errors."""
