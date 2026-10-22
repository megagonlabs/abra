"""A template custom tool — copy this shape for web/wiki search etc.

A custom tool is a `@tool`-registered factory `(bridge) -> Tool`. The name it
registers under is the function name; reference it from a roster's `tools = [...]`.
`text_stats` needs no network/key, so it's a safe, runnable example. (It's not in
the default cast — enlist it on an agent to try it.)
"""

from __future__ import annotations

from adapters.common.tools import Tool, tool


@tool
def text_stats(bridge):
    async def run(args: dict) -> str:
        text = str(args.get("text", ""))
        return f"{len(text.split())} words, {len(text)} characters"

    return Tool(
        "text_stats",
        "Count the words and characters in a piece of text.",
        {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
        },
        run,
    )
