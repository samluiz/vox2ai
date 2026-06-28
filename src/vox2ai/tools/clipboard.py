"""Clipboard tool."""

from __future__ import annotations

import subprocess
from typing import Any

from vox2ai.agent.tools_base import RiskLevel, Tool, ToolResult


class ClipboardTool(Tool):
    """Read or write the system clipboard."""

    @property
    def name(self) -> str:
        return "clipboard"

    @property
    def description(self) -> str:
        return "Read or write the system clipboard. No args = read, content arg = write."

    @property
    def risk_level(self) -> RiskLevel:
        return RiskLevel.READ_ONLY

    def execute(self, content: str | None = None, **kwargs: Any) -> ToolResult:  # noqa: ARG002
        try:
            if content is not None:
                # Write to clipboard
                proc = subprocess.run(
                    ["wl-copy"],
                    input=content,
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                if proc.returncode != 0:
                    # Fallback to xclip
                    proc = subprocess.run(
                        ["xclip", "-selection", "clipboard"],
                        input=content,
                        capture_output=True,
                        text=True,
                        timeout=5,
                    )
                return ToolResult(success=True, output=f"Copied {len(content)} chars to clipboard")
            else:
                # Read clipboard
                try:
                    result = subprocess.run(["wl-paste"], capture_output=True, text=True, timeout=5)
                except FileNotFoundError:
                    result = subprocess.run(
                        ["xclip", "-selection", "clipboard", "-o"],
                        capture_output=True,
                        text=True,
                        timeout=5,
                    )
                output = result.stdout.strip()
                if len(output) > 5000:
                    output = output[:5000] + "... (truncated)"
                return ToolResult(success=True, output=output or "Clipboard is empty")
        except Exception as e:
            return ToolResult(success=False, output="", error=str(e))
