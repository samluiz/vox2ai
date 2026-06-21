from __future__ import annotations

import re

MODIFIER_ALIASES = {
    "control": "Ctrl",
    "ctrl": "Ctrl",
    "alt": "Alt",
    "option": "Alt",
    "shift": "Shift",
    "super": "Super",
    "meta": "Super",
    "cmd": "Cmd",
    "command": "Cmd",
}
MODIFIERS = {"Ctrl", "Alt", "Shift", "Super", "Cmd"}
MODIFIER_ORDER = ("Ctrl", "Alt", "Shift", "Super", "Cmd")
RESERVED_KEYS = {"Esc", "Escape"}


def normalize_shortcut(shortcut: str) -> str:
    parts: list[str] = []
    for raw_part in shortcut.split("+"):
        part = raw_part.strip()
        if not part:
            continue
        lower = part.lower()
        if lower in MODIFIER_ALIASES:
            parts.append(MODIFIER_ALIASES[lower])
        elif lower in {"escape", "esc"}:
            parts.append("Escape")
        elif lower == "space":
            parts.append("Space")
        elif re.fullmatch(r"f\d{1,2}", lower):
            parts.append(lower.upper())
        elif len(part) == 1:
            parts.append(part.upper())
        else:
            parts.append(part[0].upper() + part[1:])

    modifiers = [modifier for modifier in MODIFIER_ORDER if modifier in parts]
    primary = next((part for part in parts if part not in MODIFIERS), "")
    return "+".join([*modifiers, *([primary] if primary else [])])


def validate_shortcut(shortcut: str, *, allow_modifier_only: bool = False) -> str:
    normalized = normalize_shortcut(shortcut)
    if not normalized:
        raise ValueError("shortcut must not be empty")
    if normalized in RESERVED_KEYS:
        raise ValueError("Esc is reserved for cancel")
    parts = normalized.split("+")
    has_primary = any(part not in MODIFIERS for part in parts)
    if not has_primary and not allow_modifier_only:
        raise ValueError("shortcut must include a non-modifier key")
    if len(parts) == 1 and re.fullmatch(r"[A-Z0-9]", normalized):
        raise ValueError("single text keys are not allowed as shortcuts")
    return normalized
