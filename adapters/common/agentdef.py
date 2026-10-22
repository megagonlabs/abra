"""Agent definition + type registry.

An *agent type* is a builder `(bridge, AgentConfig) -> Agent`. Each harness/SDK
registers one with `@agent_type("name")`. `build_agent` lazily imports the right
adapter module (so you only need the deps for the types you actually run). The
launch mechanism (single-agent CLI vs a roster/host) sits on top of this and is
deliberately not decided here.
"""

from __future__ import annotations

import importlib
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass
class AgentConfig:
    type: str
    name: str
    system: str = ""  # persona / role text
    blurb: str = ""  # optional one-line capability intro, surfaced in the join greeting
    model: str | None = None
    tools: list[Any] | None = None  # canvas-tool names (str) and/or attached Tool objects; None = all canvas
    params: dict = field(default_factory=dict)  # harness-specific knobs (temperature, etc.)


class Agent(Protocol):
    async def respond(self, text: str, sender: str) -> None: ...
    # Fold an observed frame into context WITHOUT running the model — the agent hears
    # everything on the session; `respond` fires only on a wake trigger (see loop.py).
    def observe(self, text: str, sender: str) -> None: ...


AGENT_TYPES: dict[str, Callable] = {}


def agent_type(name: str):
    """Register a builder for an agent type."""

    def deco(build):
        AGENT_TYPES[name] = build
        return build

    return deco


# Where each type's adapter lives — imported on demand so unused SDK deps aren't required.
_MODULES = {
    "custom": "adapters.agents.custom",
    "custom-anthropic": "adapters.agents.custom",
    "langgraph": "adapters.agents.langgraph",
    "openai_agents_sdk": "adapters.agents.openai_agents_sdk",
    "claude_agent_sdk": "adapters.agents.claude_agent_sdk",
}


def build_agent(bridge, cfg: AgentConfig) -> Agent:
    if cfg.type not in AGENT_TYPES:
        module = _MODULES.get(cfg.type)
        if module is None:
            raise ValueError(f"unknown agent type: {cfg.type!r} (known: {sorted(_MODULES)})")
        importlib.import_module(module)  # registers via @agent_type
    return AGENT_TYPES[cfg.type](bridge, cfg)
