"""openai_agents_sdk — adapter over the OpenAI Agents SDK (the `agents` package).

The SDK owns the agent loop (`Runner.run`). We give it:
- the agent's canvas tools as SDK `FunctionTool`s whose `on_invoke_tool` runs the
  neutral `Tool` through our bridge (strict schema off — our tools use optional fields);
- optional SDK hosted built-ins (web_search → WebSearchTool, …) where the agent asks;
- its persona as `instructions`, and `model` from the config (an OpenAI model).
Each inbound message is one `Runner.run(agent, input)`; we keep context by feeding
`result.to_input_list()` back as the next input. The runner is injectable so the
history/output plumbing can run without an OPENAI_API_KEY.

Runtime needs (lazy-imported):
  uv pip install -e ".[openai]"
  export OPENAI_API_KEY=...
"""

from __future__ import annotations

import json

from adapters.common.agentdef import agent_type
from adapters.common.prompts import SILENCE, fold_observations
from adapters.common.tools import resolve_tools, run_tool

# ABRA tool-name -> OpenAI Agents SDK hosted-tool class name
BUILTINS = {"web_search": "WebSearchTool"}

DEFAULT_SYSTEM = (
    "You are {name}, one participant in a shared multi-agent session with a human and "
    "possibly other agents. Converse naturally and concisely; use your tools (e.g. the "
    "canvas tools) only when they genuinely help. "
    + SILENCE
    + " To address another agent so they respond, mention them as @theirname. "
    "Reply with your message only."
)


def _partition_tools(items):
    """Split an agent's tool list into (canvas/custom items, SDK-builtin tool names)."""
    if items is None:
        return None, []
    builtins = [BUILTINS[n] for n in items if isinstance(n, str) and n in BUILTINS]
    rest = [n for n in items if not (isinstance(n, str) and n in BUILTINS)]
    return rest, builtins


@agent_type("openai_agents_sdk")
def build(bridge, cfg):
    return OpenAIAgentsSdkAgent(bridge, cfg)


class OpenAIAgentsSdkAgent:
    def __init__(self, bridge, cfg, *, run=None):
        self.bridge = bridge
        self.cfg = cfg
        self._run = run  # injectable: async (input_list) -> result; defaults to Runner.run(agent, ...)
        self._agent = None
        self.history: list = []  # SDK input items — running conversation context
        self._obs: list[str] = []  # observed-but-unanswered lines, folded into the next respond()

    def _wrap(self, FunctionTool, t):
        """Wrap a neutral Tool as an SDK FunctionTool."""

        async def on_invoke(_ctx, args_json):
            args = json.loads(args_json) if args_json else {}
            out, _is_error = await run_tool(t, args)
            return out

        return FunctionTool(
            name=t.name,
            description=t.description,
            params_json_schema=t.schema,
            on_invoke_tool=on_invoke,
            strict_json_schema=False,  # our schemas use optional fields
        )

    def _function_tools(self):
        from agents import FunctionTool

        tool_items, _builtins = _partition_tools(self.cfg.tools)
        tools_map = resolve_tools(self.bridge, tool_items)
        return [self._wrap(FunctionTool, t) for t in tools_map.values()]

    def _ensure_agent(self):
        if self._agent is None:
            import agents as sdk
            from agents import Agent

            _tool_items, builtin_names = _partition_tools(self.cfg.tools)
            tools = self._function_tools() + [getattr(sdk, n)() for n in builtin_names]
            instructions = DEFAULT_SYSTEM.format(name=self.cfg.name) + (
                f"\n\n{self.cfg.system}" if self.cfg.system else ""
            )
            self._agent = Agent(
                name=self.cfg.name, instructions=instructions, model=self.cfg.model, tools=tools
            )
        return self._agent

    async def _invoke(self, input_list):
        if self._run is not None:
            return await self._run(input_list)
        from agents import Runner

        return await Runner.run(self._ensure_agent(), input_list)

    def observe(self, text: str, sender: str) -> None:
        """Buffer an observed message (no run); folded into the next respond()."""
        self._obs.append(f"{sender}: {text}")

    async def respond(self, text: str, sender: str) -> str:
        self.history.append({"role": "user", "content": fold_observations(self._obs, text, sender)})
        result = await self._invoke(self.history)
        self.history = result.to_input_list()  # keep the full thread for context
        out = (result.final_output or "").strip()
        if out:
            await self.bridge.say(out)
        return out
