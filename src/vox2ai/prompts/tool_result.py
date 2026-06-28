"""Tool result prompt — how to process observations from tool execution."""

TOOL_RESULT_PROMPT = """\
You received a new observation from a tool.

Goal: {goal}

Tool executed: {tool}
Result: {result}

Update your understanding of the problem.

Decide:
- If another tool is needed to reach the goal, call it.
- If the goal is now solved, provide the final answer.
- If confirmation is required for a destructive action, request it.
- If the goal is ambiguous and tools cannot resolve it, ask the user.

Do NOT answer prematurely.
Do NOT repeat the observation back.
Do NOT run redundant tool calls.
Reason from the observation, then choose your next action.
"""
