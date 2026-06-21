from __future__ import annotations

import pytest

from vox2ai.shortcuts import normalize_shortcut, validate_shortcut


def test_normalize_shortcut_aliases() -> None:
    assert normalize_shortcut("Control+space") == "Ctrl+Space"
    assert normalize_shortcut("meta+shift+f8") == "Shift+Super+F8"


def test_recording_shortcut_allows_modifier_only() -> None:
    assert validate_shortcut("Ctrl", allow_modifier_only=True) == "Ctrl"


def test_global_shortcut_requires_primary_key() -> None:
    with pytest.raises(ValueError, match="non-modifier"):
        validate_shortcut("Ctrl", allow_modifier_only=False)


def test_escape_is_reserved() -> None:
    with pytest.raises(ValueError, match="reserved"):
        validate_shortcut("Esc", allow_modifier_only=True)
