"""Run shell command tool."""

from __future__ import annotations

import subprocess
from typing import Any

from vox2ai.agent.tools_base import RiskLevel, Tool, ToolResult


class RunCommandTool(Tool):
    """Execute a shell command and return stdout/stderr."""

    @property
    def name(self) -> str:
        return "run_command"

    @property
    def description(self) -> str:
        return "Execute a shell command. Returns stdout, stderr, exit code."

    @property
    def risk_level(self) -> RiskLevel:
        return RiskLevel.WORKSPACE_WRITE

    @property
    def parameters_schema(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "Shell command to execute"},
                "timeout": {"type": "integer", "description": "Timeout in seconds (default 30)"},
            },
            "required": ["command"],
        }

    def execute(self, command: str = "", timeout: int = 30, **kwargs: Any) -> ToolResult:
        if not command.strip():
            return ToolResult(success=False, output="", error="Empty command")
        try:
            result = subprocess.run(
                command,
                shell=True,
                capture_output=True,
                text=True,
                timeout=timeout,
                cwd=kwargs.get("cwd"),
            )
            output = result.stdout.strip()
            stderr = result.stderr.strip()
            exit_code = result.returncode

            parts = []
            if output:
                parts.append(f"stdout:\n{output}")
            if stderr:
                parts.append(f"stderr:\n{stderr}")
            parts.append(f"exit_code: {exit_code}")

            return ToolResult(
                success=exit_code == 0,
                output="\n".join(parts),
                error=stderr if exit_code != 0 else "",
            )
        except subprocess.TimeoutExpired:
            return ToolResult(success=False, output="", error=f"Command timed out after {timeout}s")
        except Exception as e:
            return ToolResult(success=False, output="", error=str(e))
