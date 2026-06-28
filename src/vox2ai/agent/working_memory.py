"""Working memory — compact structured state for the planner.

The goal is immutable. It never changes during investigation.
Every observation becomes evidence. The planner reasons over all accumulated evidence.
Hypotheses are tracked and updated as evidence arrives.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class GoalStatus(Enum):
    ACTIVE = "active"
    CONFIRMING = "confirming"
    COMPLETED = "completed"
    BLOCKED = "blocked"


@dataclass
class Evidence:
    """A single piece of evidence collected from a tool or observation."""

    source: str  # tool name or "user"
    summary: str  # compact description
    raw: str = ""  # full output if needed
    reliability: float = 1.0  # 0.0-1.0


@dataclass
class Hypothesis:
    """A hypothesis about the goal, updated as evidence arrives."""

    claim: str
    confidence: float = 0.0  # 0.0-1.0
    supporting: list[str] = field(default_factory=list)  # evidence summaries
    contradicting: list[str] = field(default_factory=list)


@dataclass
class ToolExecution:
    tool: str
    args: dict[str, Any]
    result: str
    success: bool


@dataclass
class WorkingMemory:
    """Structured memory passed to the planner each iteration.

    The goal is the immutable user objective.
    Evidence accumulates and is never discarded.
    Hypotheses are updated, not replaced.
    """

    # Goal — immutable
    goal: str = ""
    goal_status: GoalStatus = GoalStatus.ACTIVE
    completion_criteria: str = ""

    # Evidence — accumulates, never discarded
    evidence: list[Evidence] = field(default_factory=list)

    # Hypotheses — updated, not replaced
    hypotheses: list[Hypothesis] = field(default_factory=list)

    # Known facts — deduplicated
    known_facts: list[str] = field(default_factory=list)

    # Executed tools — bounded
    executed_tools: list[ToolExecution] = field(default_factory=list)

    # Remaining unknowns — what we still need to find out
    remaining_unknowns: list[str] = field(default_factory=list)

    # Pending confirmations
    pending_confirmations: list[str] = field(default_factory=list)

    # Deprecated — kept for compatibility, use evidence instead
    observations: list[str] = field(default_factory=list)
    current_hypothesis: str = ""

    def add_evidence(self, source: str, summary: str, raw: str = "") -> None:
        """Add evidence. Never replaces existing evidence."""
        ev = Evidence(source=source, summary=summary[:500], raw=raw[:2000])
        self.evidence.append(ev)
        # Also add to legacy observations for compatibility
        self.observations.append(f"[{source}] {summary[:200]}")
        if len(self.evidence) > 30:
            self.evidence = self.evidence[-25:]
        if len(self.observations) > 30:
            self.observations = self.observations[-25:]

    def add_observation(self, text: str) -> None:
        """Legacy method — prefer add_evidence."""
        self.observations.append(text)
        if len(self.observations) > 30:
            self.observations = self.observations[-25:]

    def add_tool_execution(self, execution: ToolExecution) -> None:
        self.executed_tools.append(execution)
        if len(self.executed_tools) > 30:
            self.executed_tools = self.executed_tools[-25:]

    def add_fact(self, fact: str) -> None:
        if fact not in self.known_facts:
            self.known_facts.append(fact)

    def update_hypothesis(
        self,
        claim: str,
        confidence: float,
        supporting: list[str] | None = None,
        contradicting: list[str] | None = None,
    ) -> None:
        """Update or add a hypothesis."""
        for h in self.hypotheses:
            if h.claim == claim:
                h.confidence = confidence
                if supporting:
                    h.supporting = supporting
                if contradicting:
                    h.contradicting = contradicting
                return
        self.hypotheses.append(Hypothesis(
            claim=claim,
            confidence=confidence,
            supporting=supporting or [],
            contradicting=contradicting or [],
        ))

    def eliminate_hypothesis(self, claim: str, reason: str) -> None:
        """Mark a hypothesis as eliminated."""
        self.hypotheses = [h for h in self.hypotheses if h.claim != claim]
        self.add_fact(f"Eliminated: {claim} ({reason})")

    def has_used_tool(self, tool_name: str) -> bool:
        """Check if a tool has already been executed."""
        return any(t.tool == tool_name for t in self.executed_tools)

    def get_evidence_summary(self) -> str:
        """Get compact summary of all evidence."""
        if not self.evidence:
            return "No evidence collected yet."
        lines = []
        for ev in self.evidence[-10:]:
            lines.append(f"  [{ev.source}] {ev.summary[:150]}")
        return "\n".join(lines)

    def to_prompt(self) -> str:
        """Serialize to a compact string for inclusion in LLM prompt."""
        parts = [f"GOAL (immutable): {self.goal}"]

        if self.completion_criteria:
            parts.append(f"COMPLETION CRITERIA: {self.completion_criteria}")

        parts.append(f"STATUS: {self.goal_status.value}")

        if self.known_facts:
            parts.append("KNOWN FACTS:")
            for f in self.known_facts[-10:]:
                parts.append(f"  - {f}")

        if self.evidence:
            parts.append("EVIDENCE (all collected):")
            for ev in self.evidence[-10:]:
                parts.append(f"  [{ev.source}] {ev.summary[:200]}")

        if self.hypotheses:
            parts.append("HYPOTHESES:")
            for h in self.hypotheses:
                conf = f"{h.confidence:.0%}"
                parts.append(f"  - {h.claim} (confidence: {conf})")
                if h.supporting:
                    for s in h.supporting[-3:]:
                        parts.append(f"    + {s[:100]}")
                if h.contradicting:
                    for c in h.contradicting[-3:]:
                        parts.append(f"    - {c[:100]}")

        if self.executed_tools:
            parts.append("TOOLS EXECUTED:")
            for te in self.executed_tools[-8:]:
                status = "ok" if te.success else "FAIL"
                parts.append(f"  [{status}] {te.tool}")

        if self.remaining_unknowns:
            parts.append("REMAINING UNKNOWNS:")
            for u in self.remaining_unknowns[-5:]:
                parts.append(f"  - {u}")

        return "\n".join(parts)

    def summary(self) -> str:
        """One-line summary for streaming events."""
        n_tools = len(self.executed_tools)
        n_ev = len(self.evidence)
        return f"{n_tools} tools, {n_ev} evidence items"
