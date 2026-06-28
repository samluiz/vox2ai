"""Agent loop — bounded reasoning loop that iterates until goal is solved.

The goal is immutable. Every observation becomes evidence.
The planner reasons over all accumulated evidence.
Hypotheses are updated as evidence arrives.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

from vox2ai.agent.executor import Executor
from vox2ai.agent.planner import Planner
from vox2ai.agent.sanitizer import sanitize_answer
from vox2ai.agent.tool_registry import ToolRegistry
from vox2ai.agent.working_memory import GoalStatus, WorkingMemory
from vox2ai.llm import LLMClient

log = logging.getLogger(__name__)

# ponytail: max iterations — enough for complex tasks, bounded for safety
DEFAULT_MAX_ITERATIONS = 12

# Human-readable progress messages for tool execution
_TOOL_PROGRESS: dict[str, str] = {
    "run_command": "Running command…",
    "read_file": "Reading file…",
    "list_directory": "Listing directory…",
    "search_files": "Searching files…",
    "write_file": "Writing file…",
    "git_status": "Checking git status…",
    "git_log": "Checking git history…",
    "git_diff": "Checking git diff…",
    "journalctl": "Checking system logs…",
    "systemctl": "Checking service status…",
    "processes": "Checking running processes…",
    "clipboard": "Reading clipboard…",
}


class AgentLoop:
    """Bounded reasoning loop. Plans, executes, observes, repeats.

    The goal is immutable — it never changes during investigation.
    Every observation becomes evidence.
    The loop continues until the goal is solved or limits are reached.
    """

    def __init__(
        self,
        llm_client: LLMClient,
        tool_registry: ToolRegistry,
        max_iterations: int = DEFAULT_MAX_ITERATIONS,
        on_thinking: Callable[[str], None] | None = None,
        on_tool_start: Callable[[str, dict[str, Any]], None] | None = None,
        on_tool_finish: Callable[[str, bool, str], None] | None = None,
        on_answer: Callable[[str, float], None] | None = None,
        on_confirm: Callable[[str, str, dict[str, Any]], None] | None = None,
        on_progress: Callable[[str], None] | None = None,
    ) -> None:
        self._llm = llm_client
        self._registry = tool_registry
        self._max_iterations = max_iterations
        self._on_thinking = on_thinking
        self._on_tool_start = on_tool_start
        self._on_tool_finish = on_tool_finish
        self._on_answer = on_answer
        self._on_confirm = on_confirm
        self._on_progress = on_progress
        self._cancelled = False

    def cancel(self) -> None:
        self._cancelled = True

    async def run(self, goal: str, context: str = "") -> str:
        """Run the agent loop until goal is solved or limits reached.

        The goal is immutable — it never changes during investigation.
        Every observation becomes evidence.
        """
        memory = WorkingMemory(goal=goal)
        if context:
            memory.add_fact(context)

        tool_map = {t.name: t for t in self._registry.available()}
        planner = Planner(self._llm, self._registry.schemas_for_prompt())
        executor = Executor(memory)

        for _iteration in range(self._max_iterations):
            if self._cancelled:
                memory.goal_status = GoalStatus.BLOCKED
                return "Cancelled."

            # Plan
            self._emit_thinking("Investigating…")
            action = await planner.plan(goal, memory)

            if action.action == "answer":
                memory.goal_status = GoalStatus.COMPLETED
                clean = sanitize_answer(action.answer)
                self._emit_answer(clean, action.confidence)
                return clean

            elif action.action == "tool":
                tool_name = action.tool
                args = action.args or {}
                tool = tool_map.get(tool_name)

                if tool is None:
                    memory.add_evidence("system", f"Unknown tool requested: {tool_name}")
                    continue

                # Check if confirmation needed
                if tool.needs_confirmation():
                    memory.goal_status = GoalStatus.CONFIRMING
                    self._emit_confirm(
                        f"About to run: {tool_name}({args})",
                        tool_name,
                        args,
                    )
                    memory.add_evidence("system", f"Skipped SYSTEM_WRITE tool: {tool_name}")
                    continue

                # Emit progress
                progress = _TOOL_PROGRESS.get(tool_name, f"Running {tool_name}…")
                self._emit_progress(progress)

                # Execute
                self._emit_tool_start(tool_name, args)
                result = await executor.execute_tool(tool_name, args, tool_map)

                # Add evidence
                if result.success:
                    memory.add_evidence(tool_name, result.output[:500], result.output)
                else:
                    memory.add_evidence(tool_name, f"FAILED: {result.error[:200]}")

                self._emit_tool_finish(tool_name, result.success, result.output[:200])

            elif action.action == "confirm":
                memory.goal_status = GoalStatus.CONFIRMING
                self._emit_confirm(action.question, action.pending_tool, action.pending_args or {})
                return f"I need confirmation: {action.question}"

            elif action.action == "think":
                if action.hypothesis:
                    memory.update_hypothesis(action.hypothesis, confidence=0.5)
                if action.next_steps:
                    memory.remaining_unknowns = action.next_steps

            else:
                memory.add_evidence("system", f"Unknown action type: {action.action}")

        memory.goal_status = GoalStatus.BLOCKED
        return "Reached iteration limit without completing the goal."

    def _emit_thinking(self, text: str) -> None:
        if self._on_thinking:
            self._on_thinking(text)

    def _emit_tool_start(self, tool: str, args: dict[str, Any]) -> None:
        if self._on_tool_start:
            self._on_tool_start(tool, args)

    def _emit_tool_finish(self, tool: str, success: bool, output: str) -> None:
        if self._on_tool_finish:
            self._on_tool_finish(tool, success, output)

    def _emit_answer(self, answer: str, confidence: float) -> None:
        if self._on_answer:
            self._on_answer(answer, confidence)

    def _emit_confirm(self, question: str, tool: str, args: dict[str, Any]) -> None:
        if self._on_confirm:
            self._on_confirm(question, tool, args)

    def _emit_progress(self, text: str) -> None:
        if self._on_progress:
            self._on_progress(text)
