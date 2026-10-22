"""wikipedia — look up a topic via the MediaWiki action API (no key).

One GET to `en.wikipedia.org/w/api.php` with a `search` generator + `extracts`
prop returns the intro plaintext of the top matches in a single call; we keep the
best (rank 1) match's summary and list the rest as related titles. Networked.
"""

from __future__ import annotations

import json

from adapters.common.tools import Tool, tool
from adapters.tools import _http

API = "https://en.wikipedia.org/w/api.php"
_MAX_SUMMARY = 1500


@tool
def wikipedia(bridge):
    async def run(args: dict) -> str:
        query = str(args.get("query", "")).strip()
        if not query:
            raise ValueError("no query provided")
        data = await _http.get_json(
            API,
            params={
                "action": "query",
                "format": "json",
                "formatversion": 2,
                "generator": "search",
                "gsrsearch": query,
                "gsrlimit": 5,
                "prop": "extracts",
                "exintro": 1,
                "explaintext": 1,
                "redirects": 1,
            },
        )
        pages = data.get("query", {}).get("pages", [])
        if not pages:
            return f"No Wikipedia article found for: {query}"
        pages.sort(key=lambda p: p.get("index", 0))
        best = pages[0]
        related = [p["title"] for p in pages[1:]]
        return json.dumps(
            {
                "title": best["title"],
                "summary": best.get("extract", "")[:_MAX_SUMMARY],
                "related": related,
            }
        )

    return Tool(
        "wikipedia",
        "Look up a topic on Wikipedia. Returns the intro summary of the best-matching "
        "article plus a few related article titles, as JSON {title, summary, related}.",
        {
            "type": "object",
            "properties": {"query": {"type": "string", "description": "e.g. 'Alan Turing'"}},
            "required": ["query"],
        },
        run,
    )
