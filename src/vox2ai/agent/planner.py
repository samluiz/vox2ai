"""Planner — reasons about goals and decides which tools to use."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any

from vox2ai.agent.working_memory import WorkingMemory
from vox2ai.llm import LLMClient
from vox2ai.prompts.developer import DEVELOPER_PROMPT
from vox2ai.prompts.planner import PLANNER_SYSTEM_PROMPT

log = logging.getLogger(__name__)


@dataclass
class PlannerAction:
    action: str  # "tool", "answer", "confirm", "think"
    tool: str = ""
    args: dict[str, Any] | None = None
    answer: str = ""
    confidence: float = 0.0
    reasoning: str = ""
    question: str = ""
    pending_tool: str = ""
    pending_args: dict[str, Any] | None = None
    hypothesis: str = ""
    next_steps: list[str] | None = None


def parse_planner_action(raw: str) -> PlannerAction:
    """Parse LLM response into a PlannerAction."""
    raw = raw.strip()
    # Strip markdown fences
    if raw.startswith("```"):
        first_nl = raw.find("\n")
        if first_nl != -1:
            raw = raw[first_nl:]
        if raw.endswith("```"):
            raw = raw[:-3].strip()
    if raw.startswith("```json"):
        raw = raw[7:]
        if raw.endswith("```"):
            raw = raw[:-3].strip()

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        # Fallback: treat as answer
        return PlannerAction(action="answer", answer=raw, confidence=0.3)

    if not isinstance(data, dict):
        return PlannerAction(action="answer", answer=raw, confidence=0.3)

    action = data.get("action", "answer")

    if action == "tool":
        return PlannerAction(
            action="tool",
            tool=data.get("tool", ""),
            args=data.get("args", {}),
            reasoning=data.get("reasoning", ""),
        )
    elif action == "confirm":
        return PlannerAction(
            action="confirm",
            question=data.get("question", ""),
            pending_tool=data.get("pending_tool", ""),
            pending_args=data.get("pending_args", {}),
        )
    elif action == "think":
        return PlannerAction(
            action="think",
            hypothesis=data.get("hypothesis", ""),
            next_steps=data.get("next_steps", []),
        )
    else:  # answer
        return PlannerAction(
            action="answer",
            answer=data.get("answer", raw),
            confidence=float(data.get("confidence", 0.5)),
        )


class Planner:
    """Plans next actions based on goal and working memory."""

    def __init__(self, llm_client: LLMClient, tool_descriptions: str) -> None:
        self._llm = llm_client
        self._tool_descriptions = tool_descriptions

    async def plan(self, goal: str, memory: WorkingMemory) -> PlannerAction:
        """Ask the LLM what to do next."""
        prompt = self._build_prompt(goal, memory)
        # ponytail: combine system + developer prompts for full context
        system = f"{PLANNER_SYSTEM_PROMPT}\n\n{DEVELOPER_PROMPT}"
        # ponytail: LLMClient.complete is sync, run in executor
        import asyncio
        raw = await asyncio.get_event_loop().run_in_executor(
            None, self._llm.complete, system, prompt
        )
        return parse_planner_action(raw)

    def _build_prompt(self, goal: str, memory: WorkingMemory) -> str:
        parts = [
            "=== AVAILABLE TOOLS ===",
            self._tool_descriptions,
            "",
            "=== WORKING MEMORY ===",
            memory.to_prompt(),
            "",
            f"=== GOAL ===\n{goal}",
            "",
            "What is your next action? Return JSON.",
        ]
        return "\n".join(parts)
