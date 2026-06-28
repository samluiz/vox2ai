"""System tools — journalctl, systemctl, processes."""

from __future__ import annotations

import subprocess
from typing import Any

from vox2ai.agent.tools_base import RiskLevel, Tool, ToolResult


class JournalctlTool(Tool):
    """Query systemd journal logs."""

    @property
    def name(self) -> str:
        return "journalctl"

    @property
    def description(self) -> str:
        return "Query system logs via journalctl. Use for debugging system issues."

    @property
    def risk_level(self) -> RiskLevel:
        return RiskLevel.READ_ONLY

    def execute(self, args: str = "-b --no-pager -n 50", **kwargs: Any) -> ToolResult:  # noqa: ARG002
        try:
            result = subprocess.run(
                f"journalctl {args}",
                shell=True,
                capture_output=True,
                text=True,
                timeout=10,
            )
            output = result.stdout.strip()
            if len(output) > 10000:
                output = output[-10000:]
            return ToolResult(success=True, output=output or "No logs found")
        except Exception as e:
            return ToolResult(success=False, output="", error=str(e))


class SystemctlTool(Tool):
    """Query or control systemd services."""

    @property
    def name(self) -> str:
        return "systemctl"

    @property
    def description(self) -> str:
        return "Check service status or manage systemd services."

    @property
    def risk_level(self) -> RiskLevel:
        return RiskLevel.READ_ONLY

    def execute(self, args: str = "--user status", **kwargs: Any) -> ToolResult:  # noqa: ARG002
        try:
            result = subprocess.run(
                f"systemctl {args}",
                shell=True,
                capture_output=True,
                text=True,
                timeout=10,
            )
            output = result.stdout.strip()
            if len(output) > 5000:
                output = output[:5000]
            return ToolResult(success=result.returncode == 0, output=output or "No output")
        except Exception as e:
            return ToolResult(success=False, output="", error=str(e))


class ProcessesTool(Tool):
    """List running processes."""

    @property
    def name(self) -> str:
        return "processes"

    @property
    def description(self) -> str:
        return "List running processes. Useful for finding what's using resources."

    @property
    def risk_level(self) -> RiskLevel:
        return RiskLevel.READ_ONLY

    def execute(self, filter: str = "", **kwargs: Any) -> ToolResult:  # noqa: ARG002
        try:
            cmd = "ps aux --sort=-%mem | head -20"
            if filter:
                cmd = f"ps aux | grep -i '{filter}' | grep -v grep"
            result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=5)
            return ToolResult(success=True, output=result.stdout.strip() or "No matching processes")
        except Exception as e:
            return ToolResult(success=False, output="", error=str(e))
