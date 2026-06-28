"""Git tools."""

from __future__ import annotations

import subprocess
from typing import Any

from vox2ai.agent.tools_base import RiskLevel, Tool, ToolResult


def _git(args: str, cwd: str | None = None) -> tuple[str, str, int]:
    result = subprocess.run(
        f"git {args}",
        shell=True,
        capture_output=True,
        text=True,
        timeout=15,
        cwd=cwd,
    )
    return result.stdout.strip(), result.stderr.strip(), result.returncode


class GitStatusTool(Tool):
    """Show git working tree status."""

    @property
    def name(self) -> str:
        return "git_status"

    @property
    def description(self) -> str:
        return "Show git status (modified, staged, untracked files)."

    @property
    def risk_level(self) -> RiskLevel:
        return RiskLevel.READ_ONLY

    def execute(self, path: str = ".", **kwargs: Any) -> ToolResult:  # noqa: ARG002
        out, err, code = _git("status --short", cwd=path)
        if code != 0:
            return ToolResult(success=False, output="", error=err or "git status failed")
        return ToolResult(success=True, output=out or "Clean working tree")


class GitLogTool(Tool):
    """Show recent git log."""

    @property
    def name(self) -> str:
        return "git_log"

    @property
    def description(self) -> str:
        return "Show recent git commits (last 10)."

    @property
    def risk_level(self) -> RiskLevel:
        return RiskLevel.READ_ONLY

    def execute(self, path: str = ".", count: int = 10, **kwargs: Any) -> ToolResult:  # noqa: ARG002
        out, err, code = _git(f"log --oneline -{count}", cwd=path)
        if code != 0:
            return ToolResult(success=False, output="", error=err or "git log failed")
        return ToolResult(success=True, output=out or "No commits")


class GitDiffTool(Tool):
    """Show git diff."""

    @property
    def name(self) -> str:
        return "git_diff"

    @property
    def description(self) -> str:
        return "Show unstaged changes (git diff)."

    @property
    def risk_level(self) -> RiskLevel:
        return RiskLevel.READ_ONLY

    def execute(self, path: str = ".", **kwargs: Any) -> ToolResult:  # noqa: ARG002
        out, err, code = _git("diff", cwd=path)
        if code != 0:
            return ToolResult(success=False, output="", error=err or "git diff failed")
        if not out:
            return ToolResult(success=True, output="No unstaged changes")
        if len(out) > 10000:
            out = out[:10000] + "\n... (truncated)"
        return ToolResult(success=True, output=out)
