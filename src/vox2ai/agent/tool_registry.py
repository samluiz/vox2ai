"""Tool registry — discovers and manages available tools."""

from __future__ import annotations

import importlib
import logging
import pkgutil

from vox2ai.agent.tools_base import Tool

log = logging.getLogger(__name__)


class ToolRegistry:
    """Discovers tools from vox2ai.tools package and provides them to the planner."""

    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}

    def discover(self) -> None:
        """Auto-discover all Tool subclasses in vox2ai.tools."""
        import vox2ai.tools as tools_pkg

        for _importer, modname, _ispkg in pkgutil.iter_modules(tools_pkg.__path__):
            if modname.startswith("_"):
                continue
            fqmn = f"vox2ai.tools.{modname}"
            try:
                mod = importlib.import_module(fqmn)
            except Exception:
                log.exception("Failed to import tool module %s", fqmn)
                continue
            for attr in dir(mod):
                obj = getattr(mod, attr)
                if (
                    isinstance(obj, type)
                    and issubclass(obj, Tool)
                    and obj is not Tool
                ):
                    try:
                        instance = obj()
                        self._tools[instance.name] = instance
                        log.debug("Registered tool: %s", instance.name)
                    except Exception:
                        log.exception("Failed to instantiate tool %s", attr)

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def available(self) -> list[Tool]:
        return list(self._tools.values())

    def schemas_for_prompt(self) -> str:
        """Return tool descriptions for inclusion in LLM prompt."""
        lines = []
        for t in self._tools.values():
            lines.append(f"- {t.name}: {t.description} (risk: {t.risk_level})")
        return "\n".join(lines)
