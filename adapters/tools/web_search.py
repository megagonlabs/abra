"""web_search — web results via the Google Custom Search JSON API.

GETs `customsearch/v1` with the `GOOGLE_API_KEY` + `GOOGLE_CSE_ID` env config
(both required) and returns the top hits as JSON (title/link/snippet). Networked
via the stdlib `_http` helper.
"""

from __future__ import annotations

import json
import os

from adapters.common.tools import Tool, tool
from adapters.tools import _http

_ENDPOINT = "https://www.googleapis.com/customsearch/v1"


@tool
def web_search(bridge):
    async def run(args: dict) -> str:
        key = os.environ.get("GOOGLE_API_KEY")
        cx = os.environ.get("GOOGLE_CSE_ID")
        if not key or not cx:
            raise RuntimeError("GOOGLE_API_KEY and GOOGLE_CSE_ID must be set")

        q = str(args.get("query", "")).strip()
        if not q:
            raise ValueError("no query provided")
        num = max(1, min(10, int(args.get("num", 5))))

        data = await _http.get_json(_ENDPOINT, params={"key": key, "cx": cx, "q": q, "num": num})
        items = data.get("items") or []
        results = [
            {"title": it.get("title"), "link": it.get("link"), "snippet": it.get("snippet")} for it in items
        ]
        total = (data.get("searchInformation") or {}).get("totalResults", 0)
        return json.dumps({"query": q, "totalResults": total, "results": results}, ensure_ascii=False)

    return Tool(
        "web_search",
        "Search the web via Google Custom Search. Returns the top results as JSON "
        "(title, link, snippet). Requires GOOGLE_API_KEY and GOOGLE_CSE_ID.",
        {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "the search query"},
                "num": {"type": "integer", "description": "how many results (1..10, default 5)"},
            },
            "required": ["query"],
        },
        run,
    )
