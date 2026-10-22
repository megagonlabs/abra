"""claude_agent_sdk — adapter over the Claude Agent SDK ("Claude Code as a library").

The SDK owns the agent loop. We give it:
- the agent's canvas tools as an **in-process MCP server** (so they execute through
  our bridge), exposed as `mcp__abra__<tool>` and pre-approved via allowed_tools;
- optional SDK built-ins (web_search → "WebSearch", …) where the agent asks for them;
- its persona as `system_prompt`, and `model` from the config.
Each inbound session message is one `client.query(...)`; we read the AssistantMessage
text back out and post it via `bridge.say`. A ClaudeSDKClient keeps conversation context.

Runtime needs (the SDK is lazy-imported):
  uv pip install -e ".[claude-sdk]"      # the claude-agent-sdk package
  npm i -g @anthropic-ai/claude-code     # the Claude Code CLI on $PATH (SDK spawns it)
  export ANTHROPIC_API_KEY=...
"""

from __future__ import annotations

from adapters.common.agentdef import agent_type
from adapters.common.prompts import SILENCE, fold_observations
from adapters.common.tools import resolve_tools, run_tool

# ABRA tool-name -> Claude Agent SDK built-in tool name
BUILTINS = {"web_search": "WebSearch", "web_fetch": "WebFetch"}

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


@agent_type("claude_agent_sdk")
def build(bridge, cfg):
    return ClaudeAgentSdkAgent(bridge, cfg)


class ClaudeAgentSdkAgent:
    def __init__(self, bridge, cfg):
        self.bridge = bridge
        self.cfg = cfg
        self._client = None
        self._AssistantMessage = None
        self._TextBlock = None
        # The SDK owns conversation context (no local history), so observed-but-not-
        # answered frames buffer here and ride the NEXT query() as a preamble.
        self._pending_obs: list[str] = []

    def observe(self, text: str, sender: str) -> None:
        """Buffer an observed message; delivered as context on the next respond().
        Semantically identical to the list-based harnesses — an observation is only
        ever consumed at wake-time, which is exactly when the next query() runs."""
        self._pending_obs.append(f"{sender}: {text}")

    @staticmethod
    def _wrap(sdk_tool, t):
        """Wrap a neutral Tool as an SDK in-process MCP tool."""

        @sdk_tool(t.name, t.description, t.schema)
        async def handler(args):
            out, _is_error = await run_tool(t, args)
            return {"content": [{"type": "text", "text": out}]}

        return handler

    def _options(self):
        from claude_agent_sdk import ClaudeAgentOptions, create_sdk_mcp_server
        from claude_agent_sdk import tool as sdk_tool

        tool_items, builtins = _partition_tools(self.cfg.tools)
        tools_map = resolve_tools(self.bridge, tool_items)
        server = create_sdk_mcp_server(
            name="abra", version="0.0.0", tools=[self._wrap(sdk_tool, t) for t in tools_map.values()]
        )
        allowed = [f"mcp__abra__{name}" for name in tools_map] + builtins
        system = DEFAULT_SYSTEM.format(name=self.cfg.name) + (
            f"\n\n{self.cfg.system}" if self.cfg.system else ""
        )
        return ClaudeAgentOptions(
            mcp_servers={"abra": server},
            allowed_tools=allowed,
            system_prompt=system,
            model=self.cfg.model,
        )

    async def _ensure(self):
        if self._client is None:
            from claude_agent_sdk import AssistantMessage, ClaudeSDKClient, TextBlock

            self._AssistantMessage, self._TextBlock = AssistantMessage, TextBlock
            self._client = ClaudeSDKClient(options=self._options())
            await self._client.connect()
        return self._client

    async def respond(self, text: str, sender: str) -> str:
        client = await self._ensure()
        # buffered observations ride the next query as a preamble, folded into one turn
        await client.query(fold_observations(self._pending_obs, text, sender))
        parts = []
        async for msg in client.receive_response():
            if isinstance(msg, self._AssistantMessage):
                for block in msg.content:
                    if isinstance(block, self._TextBlock):
                        parts.append(block.text)
        out = " ".join(parts).strip()
        if out:
            await self.bridge.say(out)
        return out
