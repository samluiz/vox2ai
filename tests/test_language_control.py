"""Tests for configurable language control — no real Whisper required."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from vox2ai.config import VoiceConfig, _migrate_voice_config


def test_old_language_auto_maps_to_language_mode_auto() -> None:
    migrated = _migrate_voice_config({"voice": {"language": "auto"}})
    assert migrated["voice"]["language_mode"] == "auto"


def test_old_language_pt_maps_to_force_primary_pt() -> None:
    migrated = _migrate_voice_config({"voice": {"language": "pt"}})
    assert migrated["voice"]["language_mode"] == "force"
    assert migrated["voice"]["primary_language"] == "pt"


def test_old_language_en_maps_to_force_primary_en() -> None:
    migrated = _migrate_voice_config({"voice": {"language": "en"}})
    assert migrated["voice"]["language_mode"] == "force"
    assert migrated["voice"]["primary_language"] == "en"


def test_new_config_unchanged() -> None:
    migrated = _migrate_voice_config(
        {"voice": {"language_mode": "constrained-auto", "language": "auto"}}
    )
    assert migrated["voice"]["language_mode"] == "constrained-auto"
    # language should not be overwritten
    assert migrated["voice"]["language"] == "auto"


def test_voice_config_defaults() -> None:
    cfg = VoiceConfig()
    assert cfg.language_mode == "auto"
    assert cfg.primary_language == "en"
    assert cfg.allowed_languages == []
    assert cfg.min_language_probability == 0.55


def test_voice_config_validation() -> None:
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        VoiceConfig(language_mode="invalid")
    with pytest.raises(ValidationError):
        VoiceConfig(primary_language="")
    with pytest.raises(ValidationError):
        VoiceConfig(allowed_languages=[""])
    with pytest.raises(ValidationError):
        VoiceConfig(min_language_probability=1.5)
    with pytest.raises(ValidationError):
        VoiceConfig(min_language_probability=-0.1)


# ── STT language mode tests ─────────────────────────────────────

FAKE_TRANSCRIPT = "hello world"
MODEL_NAME = "tiny"


def _make_fake_model(
    side_effect: list[tuple[str, str | None, float | None]] | None = None,
) -> MagicMock:
    """Create a mock WhisperModel.

    Each call to transcribe returns (segments, info) where
    ``segments`` is an iterable of objects with .text, and
    ``info`` has .language and .language_probability attributes.
    """
    if side_effect is None:
        side_effect = [(FAKE_TRANSCRIPT, "en", 0.95)]

    def _fake_transcribe(
        _audio_path: str = "",
        **_kwargs: object,
    ) -> tuple[list[object], object]:
        idx = _fake_transcribe.call_count  # type: ignore[attr-defined]
        _fake_transcribe.call_count += 1  # type: ignore[attr-defined]
        entry_idx = min(idx, len(side_effect) - 1)
        text, lang, prob = side_effect[entry_idx]

        class FakeSeg:
            def __init__(self, text: str) -> None:
                self.text = text

        class FakeInfo:
            language = lang
            language_probability = prob

        return ([FakeSeg(text)], FakeInfo())

    _fake_transcribe.call_count = 0  # type: ignore[attr-defined]

    model = MagicMock()
    model.transcribe.side_effect = _fake_transcribe
    return model


@pytest.fixture(autouse=True)
def _mock_load_model() -> None:
    """Replace _load_model so tests never load real Whisper."""
    with patch("vox2ai.stt._load_model") as mock:
        mock.return_value = _make_fake_model()
        yield


@pytest.mark.parametrize("mode", ["auto", "force"])
@patch("vox2ai.stt._load_model")
def test_language_mode_produces_transcript(mock_load: MagicMock, mode: str) -> None:
    from pathlib import Path

    from vox2ai.stt import transcribe_audio

    mock_load.return_value = _make_fake_model()

    result = transcribe_audio(
        Path("/tmp/fake.wav"),
        MODEL_NAME,
        language="auto",
        language_mode=mode,
        primary_language="en",
    )
    assert result.raw_text == FAKE_TRANSCRIPT


@patch("vox2ai.stt._load_model")
def test_constrained_auto_accepts_allowed_language(mock_load: MagicMock) -> None:
    from pathlib import Path

    from vox2ai.stt import transcribe_audio

    mock_load.return_value = _make_fake_model([(FAKE_TRANSCRIPT, "pt", 0.90)])

    result = transcribe_audio(
        Path("/tmp/fake.wav"),
        MODEL_NAME,
        language="auto",
        language_mode="constrained-auto",
        primary_language="en",
        allowed_languages=["pt", "en"],
        min_language_probability=0.5,
    )
    assert result.raw_text == FAKE_TRANSCRIPT
    assert result.retried_with_primary_language is False


@patch("vox2ai.stt._load_model")
def test_constrained_auto_retries_on_not_allowed_language(mock_load: MagicMock) -> None:
    from pathlib import Path

    from vox2ai.stt import transcribe_audio

    # First call: detected as "ar" (Arabic, not in allowed list)
    # Second call (retry): forced to primary "pt"
    mock_model = _make_fake_model(
        [
            (FAKE_TRANSCRIPT, "ar", 0.95),
            (FAKE_TRANSCRIPT, "pt", 0.99),
        ]
    )
    mock_load.return_value = mock_model

    result = transcribe_audio(
        Path("/tmp/fake.wav"),
        MODEL_NAME,
        language="auto",
        language_mode="constrained-auto",
        primary_language="pt",
        allowed_languages=["pt", "en"],
        min_language_probability=0.5,
    )
    assert result.raw_text == FAKE_TRANSCRIPT
    assert result.retried_with_primary_language is True
    assert result.used_language == "pt"


@patch("vox2ai.stt._load_model")
def test_constrained_auto_retries_on_low_probability(mock_load: MagicMock) -> None:
    from pathlib import Path

    from vox2ai.stt import transcribe_audio

    # First call: detected as "pt" but probability too low
    mock_model = _make_fake_model(
        [
            (FAKE_TRANSCRIPT, "pt", 0.30),
            (FAKE_TRANSCRIPT, "pt", 0.99),
        ]
    )
    mock_load.return_value = mock_model

    result = transcribe_audio(
        Path("/tmp/fake.wav"),
        MODEL_NAME,
        language="auto",
        language_mode="constrained-auto",
        primary_language="pt",
        allowed_languages=["pt"],
        min_language_probability=0.55,
    )
    assert result.raw_text == FAKE_TRANSCRIPT
    assert result.retried_with_primary_language is True
    assert result.used_language == "pt"


@patch("vox2ai.stt._load_model")
def test_constrained_auto_uses_primary_as_effective_allowed_when_empty(
    mock_load: MagicMock,
) -> None:
    from pathlib import Path

    from vox2ai.stt import transcribe_audio

    # Effective allowed = ["de"] (from primary_language).
    # First call detects "fr" — not allowed → retry with "de".
    mock_model = _make_fake_model(
        [
            (FAKE_TRANSCRIPT, "fr", 0.90),
            (FAKE_TRANSCRIPT, "fr", 0.90),  # retry returns same detected lang
        ]
    )
    mock_load.return_value = mock_model

    result = transcribe_audio(
        Path("/tmp/fake.wav"),
        MODEL_NAME,
        language="auto",
        language_mode="constrained-auto",
        primary_language="de",
        allowed_languages=[],
        min_language_probability=0.5,
    )
    assert result.retried_with_primary_language is True
    assert result.used_language == "de"


@patch("vox2ai.stt._load_model")
def test_auto_mode_uses_no_language_hint(mock_load: MagicMock) -> None:
    from pathlib import Path

    from vox2ai.stt import transcribe_audio

    mock_model = _make_fake_model([(FAKE_TRANSCRIPT, "en", 0.95)])
    mock_load.return_value = mock_model

    result = transcribe_audio(
        Path("/tmp/fake.wav"),
        MODEL_NAME,
        language="auto",
        language_mode="auto",
    )
    assert result.raw_text == FAKE_TRANSCRIPT
    assert result.retried_with_primary_language is False


def test_partial_language_resolution() -> None:
    from vox2ai.partial_transcriber import _resolve_partial_language

    # force mode
    assert _resolve_partial_language("force", "pt", "auto") == "pt"
    assert _resolve_partial_language("force", "en", "auto") == "en"

    # constrained-auto → uses primary language directly (no retry for partials)
    assert _resolve_partial_language("constrained-auto", "pt", "auto") == "pt"

    # auto mode
    assert _resolve_partial_language("auto", "en", "auto") is None
    assert _resolve_partial_language("auto", "en", "fr") == "fr"
