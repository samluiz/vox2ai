"""Output sanitizer - strips internal protocol from user-facing text."""

from __future__ import annotations

import logging
import re

log = logging.getLogger(__name__)

_PATTERNS = []

_FALLBACK = "I encountered an internal error while preparing the response."


def _init_patterns() -> list[re.Pattern[str]]:
    raw = [
        r"<tool_call\w*>",
        r"</tool_call>",
        r"<function_call\w*>",
        r"</function_call>",
        r"<invoke\b",
        r"</invoke>",
        r"<parameter\b",
        r"</parameter>",
        r"<function\b",
        r"</function>",
        r"<thinking>",
        r"</thinking>",
        r"<scratchpad>",
        r"</scratchpad>",
        r"\bDSML\b",
        r"\bworking memory\b",
        r"\btool registry\b",
        r"\bDEVELOPER_PROMPT\b",
        r"\bPLANNER_SYSTEM_PROMPT\b",
        r'"pending_tool"\s*:',
        r'"pending_args"\s*:',
        r"\biteration \d+/\d+",
        r"exit_code:\s*\d+",
    ]
    return [re.compile(p, re.IGNORECASE) for p in raw]


_PATTERNS.extend(_init_patterns())


def sanitize_output(text: str) -> str:
    """Strip internal protocol from output."""
    if not text or not text.strip():
        return text
    original = text
    stripped = text
    for pat in _PATTERNS:
        stripped = pat.sub("", stripped)
    stripped = re.sub(r"\n{3,}", "\n\n", stripped).strip()
    if len(stripped) < len(original) * 0.3 and len(original) > 50 and len(stripped) < 20:
        log.warning("Sanitizer: stripped too much, using fallback")
        return _FALLBACK
    if _looks_like_protocol(stripped):
        log.warning("Sanitizer: detected protocol content")
        return _FALLBACK
    return stripped


def _looks_like_protocol(text: str) -> bool:
    if not text:
        return False
    first50 = text[:50].strip()
    return bool(first50.startswith(("{", "[", "<", "```")))


def sanitize_answer(text: str) -> str:
    """Sanitize final answer before streaming to UI."""
    return sanitize_output(text)


def sanitize_chunk(text: str) -> str:
    """Sanitize streaming chunk."""
    if not text:
        return text
    for pat in _PATTERNS[:14]:
        if pat.search(text):
            log.warning("Sanitizer caught leak in chunk")
            return ""
    return text
