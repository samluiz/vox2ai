import json
from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class AgentDecision:
    type: Literal["answer", "clarification", "command"]
    message: str
    command: str | None
    reason: str | None


def parse_agent_decision(raw: str) -> AgentDecision:
    """Parse the JSON response from the command agent.

    If parsing fails or the JSON is invalid, returns an ``answer`` decision
    containing the raw text so the user still gets a response instead of
    a hard error.
    """
    raw = raw.strip()
    # Strip any markdown code fence if the model wraps it despite instructions
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
        return AgentDecision(type="answer", message=raw, command=None, reason=None)

    if not isinstance(data, dict):
        return AgentDecision(type="answer", message=raw, command=None, reason=None)

    typ = data.get("type", "answer")
    if typ not in ("answer", "clarification", "command"):
        return AgentDecision(
            type="answer",
            message=str(data.get("message", raw)),
            command=None,
            reason=None,
        )

    message = str(data.get("message", ""))
    command = data.get("command")
    reason = data.get("reason")

    if typ == "command" and not command:
        return AgentDecision(
            type="answer",
            message=message or "Command requested but no command was provided.",
            command=None,
            reason=None,
        )

    return AgentDecision(
        type=typ,
        message=message,
        command=str(command) if command else None,
        reason=str(reason) if reason else None,
    )
