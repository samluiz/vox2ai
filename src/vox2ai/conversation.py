"""In-memory conversation context for the GNOME backend session."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

Role = Literal["user", "assistant"]


@dataclass
class ConversationMemory:
    """Bounded, session-only conversation memory."""

    enabled: bool = False
    max_turns: int = 8
    turns: list[dict[str, str]] = field(default_factory=list)

    @property
    def max_messages(self) -> int:
        return max(1, self.max_turns * 2)

    def set_enabled(self, enabled: bool) -> None:
        self.enabled = enabled
        if not enabled:
            self.clear()

    def set_max_turns(self, max_turns: int) -> None:
        self.max_turns = max(1, max_turns)
        self._trim()

    def append(self, role: Role, content: str) -> None:
        if not self.enabled:
            return
        text = content.strip()
        if not text:
            return
        self.turns.append({"role": role, "content": text})
        self._trim()

    def clear(self) -> None:
        self.turns.clear()

    def prompt_context(self) -> str:
        if not self.enabled or not self.turns:
            return ""
        lines = ["Recent conversation in this app session:"]
        for item in self.turns[-self.max_messages :]:
            role = "User" if item.get("role") == "user" else "Assistant"
            lines.append(f"{role}: {item.get('content', '')}")
        return "\n".join(lines)

    def state(self) -> dict[str, int | bool]:
        return {
            "enabled": self.enabled,
            "turn_count": len(self.turns),
            "max_turns": self.max_turns,
        }

    def _trim(self) -> None:
        if len(self.turns) > self.max_messages:
            self.turns = self.turns[-self.max_messages :]
