"""scholar_search — find scholarly works/authors via OpenAlex (no API key).

GETs `https://api.openalex.org/{works,authors}` and projects each result down to
the *relations* an agent needs to build a citation/coauthor graph — for works the
author list and reference/cited-by counts, for authors their works/citation totals
and last-known institution. Sets `mailto` (the polite pool) only when
`OPENALEX_MAILTO` is in the environment. Networked through `_http`.
"""

from __future__ import annotations

import json
import os

from adapters.common.tools import Tool, tool
from adapters.tools import _http


def _work(r: dict) -> dict:
    return {
        "id": r.get("id"),
        "title": r.get("title") or r.get("display_name"),
        "year": r.get("publication_year"),
        "cited_by_count": r.get("cited_by_count"),
        "authors": [a["author"]["display_name"] for a in r.get("authorships", [])],
        "reference_count": len(r.get("referenced_works", [])),
    }


def _author(r: dict) -> dict:
    return {
        "id": r.get("id"),
        "name": r.get("display_name"),
        "works_count": r.get("works_count"),
        "cited_by_count": r.get("cited_by_count"),
        "institution": (r.get("last_known_institutions") or [{}])[0].get("display_name"),
    }


@tool
def scholar_search(bridge):
    async def run(args: dict) -> str:
        query = str(args.get("query", "")).strip()
        if not query:
            raise ValueError("no query provided")
        entity = args.get("entity", "works")
        if entity not in ("works", "authors"):
            raise ValueError("entity must be 'works' or 'authors'")
        limit = max(1, min(25, int(args.get("limit", 5))))
        params = {"search": query, "per_page": limit}
        mailto = os.environ.get("OPENALEX_MAILTO")
        if mailto:
            params["mailto"] = mailto
        data = await _http.get_json(f"https://api.openalex.org/{entity}", params=params)
        results = data.get("results") or []
        if not results:
            return f"No OpenAlex {entity} found for: {query}"
        project = _author if entity == "authors" else _work
        return json.dumps({"entity": entity, "query": query, "results": [project(r) for r in results]})

    return Tool(
        "scholar_search",
        "Search scholarly works or authors via OpenAlex (no key). Surfaces relations — "
        "for works the author list and citation/reference counts, for authors their "
        "works/citation totals and institution — to build a citation/coauthor graph.",
        {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "search terms"},
                "entity": {
                    "type": "string",
                    "enum": ["works", "authors"],
                    "description": "what to search (default 'works')",
                },
                "limit": {"type": "integer", "description": "max results, 1..25 (default 5)"},
            },
            "required": ["query"],
        },
        run,
    )
