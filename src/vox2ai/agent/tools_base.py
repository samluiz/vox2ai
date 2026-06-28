"""Base tool interface."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import StrEnum
from typing import Any


class RiskLevel(StrEnum):
    READ_ONLY = "read_only"
    WORKSPACE_WRITE = "workspace_write"
    SYSTEM_WRITE = "system_write"


@dataclass
class ToolResult:
    success: bool
    output: str
    error: str = ""
    metadata: dict[str, Any] | None = None


class Tool(ABC):
    """Base class for all agent tools."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Unique tool name used in tool calls."""

    @property
    @abstractmethod
    def description(self) -> str:
        """Human-readable description for the planner."""

    @property
    @abstractmethod
    def risk_level(self) -> RiskLevel:
        """Risk level — determines if confirmation is required."""

    @property
    def parameters_schema(self) -> dict[str, Any]:
        """JSON Schema for tool parameters. Override if tool takes args."""
        return {}

    @abstractmethod
    def execute(self, **kwargs: Any) -> ToolResult:
        """Execute the tool with given arguments."""

    def needs_confirmation(self) -> bool:
        """Whether this tool requires user confirmation before execution."""
        return self.risk_level == RiskLevel.SYSTEM_WRITE
