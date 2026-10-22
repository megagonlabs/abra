"""datetime — the current date and time (the model has no clock).

Registers under the name `datetime` (the capability), in `clock.py` to avoid any
confusion with the stdlib module it wraps. Optional IANA timezone via `zoneinfo`;
defaults to UTC. Pure + offline; no bridge use.
"""

from __future__ import annotations

from datetime import datetime as _dt
from datetime import timezone as _utc
from zoneinfo import ZoneInfo

from adapters.common.tools import Tool, tool


@tool
def datetime(bridge):
    async def run(args: dict) -> str:
        name = args.get("timezone")
        tz = ZoneInfo(name) if name else _utc.utc  # bad tz name -> ZoneInfoNotFoundError -> error:...
        now = _dt.now(tz)
        return f"{now.isoformat(timespec='seconds')} ({now.strftime('%A')}, {name or 'UTC'})"

    return Tool(
        "datetime",
        "Get the current date and time as ISO 8601. Optional IANA timezone "
        "(e.g. 'Asia/Seoul', 'America/New_York'); defaults to UTC.",
        {
            "type": "object",
            "properties": {"timezone": {"type": "string", "description": "IANA tz name; omit for UTC"}},
        },
        run,
    )
