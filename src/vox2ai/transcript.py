from collections.abc import Mapping
from dataclasses import dataclass

from vox2ai.config import AppConfig
from vox2ai.llm import LLMClient
from vox2ai.vocabulary import VocabularyContext


@dataclass(frozen=True)
class TranscriptCandidate:
    raw_text: str
    normalized_text: str
    refined_text: str | None

    @property
    def final_text(self) -> str:
        return self.refined_text or self.normalized_text


def normalize_transcript(raw_text: str, replacements: Mapping[str, str]) -> str:
    """Apply user-configured deterministic replacements to a transcript.

    Replacements are case-insensitive by default and apply to whole-word
    matches only (surrounded by non-alphanumeric characters or string
    boundaries) to avoid corrupting unrelated natural-language text.
    """
    if not replacements:
        return raw_text

    import re

    result = raw_text
    for original, replacement in replacements.items():
        pattern = re.compile(
            r"(^|\W)" + re.escape(original) + r"($|\W)",
            re.IGNORECASE,
        )
        result = pattern.sub(r"\g<1>" + replacement + r"\g<2>", result)
    return result


REFINER_SYSTEM_PROMPT = """\
You correct speech-to-text transcripts. The speaker may use any natural \
language mixed with technical terms, commands, file names, package names, \
product names, framework names, identifiers, and code words.

Rules:
- Do not answer the user.
- Only correct likely transcription mistakes.
- Preserve the user's original language and intent.
- Preserve technical terms exactly when likely.
- Do not translate unless the raw transcript clearly contains a \
mistranscribed technical term.
- Do not add new information.
- Return JSON only: {{"text": "..."}}.

Relevant vocabulary for this session:
{vocabulary}
"""


def refine_transcript_if_enabled(
    text: str,
    config: AppConfig,
    llm: LLMClient,
    vocabulary: VocabularyContext,
) -> str | None:
    """Run the transcript through an LLM refiner when enabled.

    Returns the refined text, or *None* if the refiner is not enabled
    or returns invalid JSON (caller should fallback to normalized text).
    """
    if not config.transcription.refine:
        return None
    if config.transcription.refine_mode not in ("auto", "always"):
        return None

    vocab_str = ", ".join(vocabulary.terms) if vocabulary.terms else "(none)"
    prompt = REFINER_SYSTEM_PROMPT.format(vocabulary=vocab_str)

    try:
        raw = llm.complete(prompt, text)
    except Exception:
        return None

    import json

    raw = raw.strip()
    if raw.startswith("```"):
        raw = raw.strip("`").strip()
        if raw.startswith("json"):
            raw = raw[4:].strip()
    try:
        data = json.loads(raw)
        if isinstance(data, dict) and "text" in data:
            return str(data["text"])
    except (json.JSONDecodeError, TypeError):
        pass
    return None


def build_initial_prompt(
    vocabulary: VocabularyContext,
    config: AppConfig,
) -> str | None:
    """Build a Whisper ``initial_prompt`` from dynamic vocabulary.

    Returns ``None`` when the prompt would be empty or when the feature
    is disabled via ``config.voice.initial_prompt_enabled``.
    """
    if not config.voice.initial_prompt_enabled:
        return None

    parts = [
        "The speaker may use any natural language mixed with software, terminal, editor, file, "
        "framework, package, product, or code terms."
    ]
    if vocabulary.terms:
        parts.append("Relevant terms: " + ", ".join(vocabulary.terms[:60]) + ".")

    return "\n".join(parts) if len(parts) > 1 else None
