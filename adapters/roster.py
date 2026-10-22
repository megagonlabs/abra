"""Roster — the agent library + the active cast, loaded from TOML.

Define agents under `[agents.<key>]` (type · model · prompt · tools · provider);
list which to run in `active`. Defining an agent does NOT enlist it — only the
names in `active` are spawned, so you can keep a library and run a subset.

Type and tool names are validated against the registries at load time, so a typo
dies here with a clear message instead of mid-demo.
"""

from __future__ import annotations

import tomllib
from pathlib import Path

import adapters.tools  # noqa: F401  — import so @tool factories register before validation
from adapters.common.agentdef import _MODULES, AgentConfig
from adapters.common.tools import TOOL_REGISTRY, canvas_tools

CANVAS_NAMES = set(canvas_tools(None))  # the 5 substrate tools, always available
KNOWN_BUILTINS = {"web_search", "web_fetch"}  # framework hosted built-ins (claude/openai SDKs)

ROSTER_PATH = Path(__file__).parent / "roster.toml"


def _validate(key: str, cfg: AgentConfig) -> None:
    if cfg.type not in _MODULES:
        raise ValueError(f"agent {key!r}: unknown type {cfg.type!r} (known: {sorted(_MODULES)})")
    for t in cfg.tools or []:
        if t not in TOOL_REGISTRY and t not in CANVAS_NAMES and t not in KNOWN_BUILTINS:
            raise ValueError(
                f"agent {key!r}: unknown tool {t!r} — register it with @tool, or it's not a known built-in"
            )


def _build_cfg(key: str, spec: dict) -> AgentConfig:
    cfg = AgentConfig(
        type=spec["type"],
        name=spec.get("name", key.capitalize()),
        system=spec.get("prompt", ""),
        blurb=spec.get("blurb", ""),
        model=spec.get("model"),
        tools=spec.get("tools"),
        params={"provider": spec["provider"]} if "provider" in spec else {},
    )
    _validate(key, cfg)
    return cfg


def parse_roster(data: dict) -> list[AgentConfig]:
    """The ACTIVE cast (every session auto-spawns this), in `active` order."""
    agents = data.get("agents", {})
    active = data.get("active", list(agents))
    cast: list[AgentConfig] = []
    for key in active:
        spec = agents.get(key)
        if spec is None:
            raise ValueError(f"active agent {key!r} is not defined under [agents.{key}]")
        cast.append(_build_cfg(key, spec))
    return cast


def parse_catalog(data: dict) -> dict[str, AgentConfig]:
    """The full LIBRARY — every defined agent, keyed by name (lowercased, the
    `agent:<name>` identity). Superset of the active cast; what add_agent draws from."""
    return {(c := _build_cfg(key, spec)).name.lower(): c for key, spec in data.get("agents", {}).items()}


def load_roster(path: str | Path = ROSTER_PATH) -> list[AgentConfig]:
    return parse_roster(tomllib.loads(Path(path).read_text()))


def load_catalog(path: str | Path = ROSTER_PATH) -> dict[str, AgentConfig]:
    return parse_catalog(tomllib.loads(Path(path).read_text()))
