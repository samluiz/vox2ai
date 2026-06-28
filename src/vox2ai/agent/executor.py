"""Executor — runs tools and records evidence."""

from __future__ import annotations

import logging
from typing import Any

from vox2ai.agent.tools_base import ToolResult
from vox2ai.agent.working_memory import ToolExecution, WorkingMemory

log = logging.getLogger(__name__)


class Executor:
    """Executes tools and records results in working memory."""

    def __init__(self, memory: WorkingMemory) -> None:
        self._memory = memory

    async def execute_tool(
        self, tool_name: str, args: dict[str, Any], tools: dict[str, Any]
    ) -> ToolResult:
        """Execute a tool and record the result in working memory."""
        tool = tools.get(tool_name)
        if tool is None:
            result = ToolResult(success=False, output="", error=f"Unknown tool: {tool_name}")
        else:
            try:
                result = tool.execute(**args)
            except Exception as e:
                log.exception("Tool %s failed", tool_name)
                result = ToolResult(success=False, output="", error=str(e))

        # Record execution
        execution = ToolExecution(
            tool=tool_name,
            args=args,
            result=result.output if result.success else result.error,
            success=result.success,
        )
        self._memory.add_tool_execution(execution)

        return result
