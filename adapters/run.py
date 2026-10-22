"""Run ONE agent of any registered type, connected to a session.

The simple per-agent launcher (status quo, type-selectable). A roster file / host
that manages many agents from the UI is a separate, not-yet-decided concern that
would sit on top of build_agent + run_agent.

    .venv/bin/python -m adapters.run --type custom-anthropic --name Bob
    .venv/bin/python -m adapters.run --name Alice --model claude-haiku-4-5 --tools read_canvas,create_canvas
"""

from __future__ import annotations

import argparse
import asyncio

from adapters.common.agentdef import AgentConfig, build_agent
from adapters.common.bridge import connect
from adapters.common.loop import run_agent


async def main() -> None:
    ap = argparse.ArgumentParser(description="Run one ABRA agent participant.")
    ap.add_argument("--type", default="custom-anthropic", help="registered agent type")
    ap.add_argument("--name", default="Agent")
    ap.add_argument("--role", default="", help="persona / role text appended to the system prompt")
    ap.add_argument("--blurb", default="", help="one-line capability intro for the join greeting")
    ap.add_argument("--model", default=None)
    ap.add_argument(
        "--provider", default=None, help="for --type custom: anthropic|openai|fireworks"
    )
    ap.add_argument(
        "--tools", default=None, help="comma-separated CUSTOM tool names to add (canvas tools are always included)"
    )
    ap.add_argument("--url", default="ws://127.0.0.1:8787")
    ap.add_argument("--session", default="demo")
    ap.add_argument("--source", default=None, help="agent:<id> (default agent:<name-lowercased>)")
    args = ap.parse_args()

    cfg = AgentConfig(
        type=args.type,
        name=args.name,
        system=args.role,
        blurb=args.blurb,
        model=args.model,
        tools=args.tools.split(",") if args.tools else None,
        params={"provider": args.provider} if args.provider else {},
    )
    source = args.source or f"agent:{args.name.lower()}"
    bridge = await connect(args.url, source, args.session)
    agent = build_agent(bridge, cfg)
    print(f"{args.name} ({source}, type={cfg.type}) joined '{args.session}' on {args.url}")
    try:
        await run_agent(bridge, agent, args.name, args.blurb)
    finally:
        await bridge.stop()
        await bridge._ws.close()


if __name__ == "__main__":
    asyncio.run(main())
