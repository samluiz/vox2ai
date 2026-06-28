"""Prompt architecture for Vox2AI autonomous agent."""

from vox2ai.prompts.developer import DEVELOPER_PROMPT
from vox2ai.prompts.planner import PLANNER_SYSTEM_PROMPT
from vox2ai.prompts.system import SYSTEM_PROMPT
from vox2ai.prompts.tool_result import TOOL_RESULT_PROMPT

# ponytail: backward compatibility for tui/runner
ASSISTANT_SYSTEM_PROMPT = SYSTEM_PROMPT
COMMAND_AGENT_SYSTEM_PROMPT = PLANNER_SYSTEM_PROMPT
COMMAND_RESULT_PROMPT = TOOL_RESULT_PROMPT

__all__ = [
    "SYSTEM_PROMPT",
    "DEVELOPER_PROMPT",
    "PLANNER_SYSTEM_PROMPT",
    "TOOL_RESULT_PROMPT",
    # Legacy
    "ASSISTANT_SYSTEM_PROMPT",
    "COMMAND_AGENT_SYSTEM_PROMPT",
    "COMMAND_RESULT_PROMPT",
]
