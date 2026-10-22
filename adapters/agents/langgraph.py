"""langgraph — adapter over LangGraph 1.x.

We build the agent graph *ourselves* on the stable primitives (`StateGraph` +
`model.bind_tools`), NOT `create_react_agent`/`create_agent` — so the wiring is
explicit and an autonomous LangGraph app drops in behind the same seam. The graph
is two nodes:

    agent  --(tool calls?)--> tools --> agent      ... loop
           --(none)---------> END

The `tools` node runs the requested calls through our neutral `Tool`s (the agent's
own, bound to the bridge) — we don't convert to LangChain tool objects, we just
match by name and `run_tool`. The model is Claude via langchain-anthropic by
default (cfg.model); swap the chat model for another provider as a sibling. The
model is injectable so the graph wiring can run without an API key.

Runtime needs (lazy-imported):
  uv pip install -e ".[langgraph]"
  export ANTHROPIC_API_KEY=...
"""

from __future__ import annotations

from adapters.common.agentdef import agent_type
from adapters.common.prompts import SILENCE, fold_observations
from adapters.common.tools import resolve_tools, run_tool

DEFAULT_MODEL = "claude-opus-4-8"
MAX_TOKENS = 4096

SYSTEM_TEMPLATE = (
    "You are {name}, one participant in a shared multi-agent session with a human and "
    "possibly other agents. Converse naturally and concisely. You may use your tools "
    "(e.g. to create/read canvases the human sees) when they genuinely help; otherwise "
    "just chat. "
    + SILENCE
    + " To address another agent so they respond, mention them as @theirname. "
    "Reply with your message only — do not narrate your reasoning or tool plans."
)


@agent_type("langgraph")
def build(bridge, cfg):
    return LangGraphAgent(bridge, cfg)


def _text_of(msg) -> str:
    """Pull plain text out of an AIMessage whose content may be a str or block list."""
    content = getattr(msg, "content", "")
    if isinstance(content, str):
        return content.strip()
    parts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
    return " ".join(parts).strip()


class LangGraphAgent:
    def __init__(self, bridge, cfg, *, model=None):
        self.bridge = bridge
        self.cfg = cfg
        self.tools = resolve_tools(bridge, cfg.tools)  # name -> Tool (the agent's own)
        self.system = SYSTEM_TEMPLATE.format(name=cfg.name) + (f"\n\n{cfg.system}" if cfg.system else "")
        # Tool schemas the model is bound to (OpenAI function shape; LangChain normalizes per provider).
        self._tool_defs = [
            {"type": "function", "function": {"name": t.name, "description": t.description, "parameters": t.schema}}
            for t in self.tools.values()
        ]
        self._model = model  # injectable; lazily defaulted to ChatAnthropic
        self._llm = None  # model bound to the tools
        self._graph = None
        self.history: list = []  # LangChain messages — running conversation context
        self._obs: list[str] = []  # observed-but-unanswered lines, folded into the next respond()

    def _chat_model(self):
        if self._model is None:
            from langchain_anthropic import ChatAnthropic

            self._model = ChatAnthropic(model=self.cfg.model or DEFAULT_MODEL, max_tokens=MAX_TOKENS)
        return self._model

    async def _agent_node(self, state):
        reply = await self._llm.ainvoke(state["messages"])
        return {"messages": [reply]}

    async def _tools_node(self, state):
        from langchain_core.messages import ToolMessage

        out = []
        for call in state["messages"][-1].tool_calls:
            tool = self.tools.get(call["name"])
            if tool is None:
                text, is_error = f"unknown tool: {call['name']}", True
            else:
                text, is_error = await run_tool(tool, call.get("args") or {})
            out.append(ToolMessage(content=text, tool_call_id=call["id"], status="error" if is_error else "success"))
        return {"messages": out}

    @staticmethod
    def _route(state):
        return "tools" if getattr(state["messages"][-1], "tool_calls", None) else "__end__"

    def _ensure(self):
        if self._graph is None:
            from langgraph.graph import END, START, MessagesState, StateGraph

            model = self._chat_model()
            self._llm = model.bind_tools(self._tool_defs) if self._tool_defs else model
            g = StateGraph(MessagesState)
            g.add_node("agent", self._agent_node)
            g.add_node("tools", self._tools_node)
            g.add_edge(START, "agent")
            g.add_conditional_edges("agent", self._route, {"tools": "tools", "__end__": END})
            g.add_edge("tools", "agent")
            self._graph = g.compile()
        return self._graph

    def observe(self, text: str, sender: str) -> None:
        """Buffer an observed message (no graph run); folded into the next respond()."""
        self._obs.append(f"{sender}: {text}")

    async def respond(self, text: str, sender: str) -> str:
        from langchain_core.messages import HumanMessage, SystemMessage

        graph = self._ensure()
        if not self.history:
            self.history.append(SystemMessage(content=self.system))
        self.history.append(HumanMessage(content=fold_observations(self._obs, text, sender)))
        result = await graph.ainvoke({"messages": self.history})
        self.history = result["messages"]  # keep the full thread for context
        out = _text_of(self.history[-1])
        if out:
            await self.bridge.say(out)
        return out
