"""image_search — REAL image URLs via the Google Custom Search JSON API.

The same `customsearch/v1` endpoint + `GOOGLE_API_KEY` / `GOOGLE_CSE_ID` env config as
`web_search`, but with `searchType=image` — so it returns actual, existing image URLs
(with thumbnails + dimensions) instead of the agent guessing/hallucinating a URL. Use the
returned `link` (full image) or `thumbnail` in a `display` view's content.

Note: the Programmable Search Engine (CSE) must have **Image search ON** in its settings.
Pair with a view-side `onError` fallback for the occasional host that blocks hot-linking.
"""

from __future__ import annotations

import json
import os

from adapters.common.tools import Tool, tool
from adapters.tools import _http

_ENDPOINT = "https://www.googleapis.com/customsearch/v1"


@tool
def image_search(bridge):
    async def run(args: dict) -> str:
        key = os.environ.get("GOOGLE_API_KEY")
        cx = os.environ.get("GOOGLE_CSE_ID")
        if not key or not cx:
            raise RuntimeError("GOOGLE_API_KEY and GOOGLE_CSE_ID must be set")

        q = str(args.get("query", "")).strip()
        if not q:
            raise ValueError("no query provided")
        num = max(1, min(10, int(args.get("num", 5))))

        params = {
            "key": key,
            "cx": cx,
            "q": q,
            "num": num,
            "searchType": "image",  # <- the only difference from web_search
            "safe": "active",
        }
        # optional size hint: icon | small | medium | large | xlarge | xxlarge | huge
        size = args.get("size")
        if size:
            params["imgSize"] = str(size)

        data = await _http.get_json(_ENDPOINT, params=params)
        items = data.get("items") or []
        results = []
        for it in items:
            img = it.get("image") or {}
            results.append(
                {
                    "title": it.get("title"),
                    "link": it.get("link"),  # the actual image URL (real, loadable)
                    "thumbnail": img.get("thumbnailLink"),
                    "mime": it.get("mime"),
                    "width": img.get("width"),
                    "height": img.get("height"),
                    "context": img.get("contextLink"),  # the page it appears on
                }
            )
        return json.dumps({"query": q, "results": results}, ensure_ascii=False)

    return Tool(
        "image_search",
        "Find REAL, loadable image URLs via Google Custom Search (searchType=image). "
        "Returns JSON results with `link` (the actual image URL), `thumbnail`, `mime`, and "
        "dimensions. Use `link` in a `display` canvas instead of guessing an image URL. "
        "Requires GOOGLE_API_KEY and GOOGLE_CSE_ID (CSE must have Image search enabled).",
        {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "what to find an image of"},
                "num": {"type": "integer", "description": "how many results (1..10, default 5)"},
                "size": {
                    "type": "string",
                    "description": "optional size: icon|small|medium|large|xlarge|xxlarge|huge",
                },
            },
            "required": ["query"],
        },
        run,
    )
