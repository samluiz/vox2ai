"""Filesystem tools — read, write, list, search."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from vox2ai.agent.tools_base import RiskLevel, Tool, ToolResult


class ReadFileTool(Tool):
    """Read file contents."""

    @property
    def name(self) -> str:
        return "read_file"

    @property
    def description(self) -> str:
        return "Read a file's contents. Returns the text content."

    @property
    def risk_level(self) -> RiskLevel:
        return RiskLevel.READ_ONLY

    def execute(self, path: str = "", **kwargs: Any) -> ToolResult:  # noqa: ARG002
        if not path:
            return ToolResult(success=False, output="", error="No path provided")
        try:
            p = Path(path).expanduser().resolve()
            if not p.exists():
                return ToolResult(success=False, output="", error=f"File not found: {path}")
            content = p.read_text(errors="replace")
            # ponytail: truncate large files
            if len(content) > 50000:
                content = content[:50000] + "\n... (truncated)"
            return ToolResult(success=True, output=content)
        except Exception as e:
            return ToolResult(success=False, output="", error=str(e))


class ListDirectoryTool(Tool):
    """List directory contents."""

    @property
    def name(self) -> str:
        return "list_directory"

    @property
    def description(self) -> str:
        return "List files and directories. Returns names with type indicators."

    @property
    def risk_level(self) -> RiskLevel:
        return RiskLevel.READ_ONLY

    def execute(self, path: str = ".", **kwargs: Any) -> ToolResult:  # noqa: ARG002
        try:
            p = Path(path).expanduser().resolve()
            if not p.is_dir():
                return ToolResult(success=False, output="", error=f"Not a directory: {path}")
            entries = []
            for item in sorted(p.iterdir()):
                prefix = "d" if item.is_dir() else "f"
                entries.append(f"[{prefix}] {item.name}")
            return ToolResult(success=True, output="\n".join(entries[:200]))
        except Exception as e:
            return ToolResult(success=False, output="", error=str(e))


class SearchFilesTool(Tool):
    """Search for files matching a pattern."""

    @property
    def name(self) -> str:
        return "search_files"

    @property
    def description(self) -> str:
        return "Find files matching a glob pattern. Returns matching paths."

    @property
    def risk_level(self) -> RiskLevel:
        return RiskLevel.READ_ONLY

    def execute(self, pattern: str = "", path: str = ".", **kwargs: Any) -> ToolResult:  # noqa: ARG002
        if not pattern:
            return ToolResult(success=False, output="", error="No pattern provided")
        try:
            p = Path(path).expanduser().resolve()
            matches = list(p.glob(pattern))
            paths = [str(m) for m in matches[:100]]
            return ToolResult(success=True, output="\n".join(paths) if paths else "No matches")
        except Exception as e:
            return ToolResult(success=False, output="", error=str(e))


class WriteFileTool(Tool):
    """Write content to a file."""

    @property
    def name(self) -> str:
        return "write_file"

    @property
    def description(self) -> str:
        return "Write content to a file. Creates parent directories if needed."

    @property
    def risk_level(self) -> RiskLevel:
        return RiskLevel.WORKSPACE_WRITE

    def execute(self, path: str = "", content: str = "", **kwargs: Any) -> ToolResult:  # noqa: ARG002
        if not path:
            return ToolResult(success=False, output="", error="No path provided")
        try:
            p = Path(path).expanduser().resolve()
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content)
            return ToolResult(success=True, output=f"Wrote {len(content)} bytes to {p}")
        except Exception as e:
            return ToolResult(success=False, output="", error=str(e))
