"""geocode — resolve a place name to coordinates via OpenStreetMap Nominatim (no API key).

One GET over `_http` against Nominatim's `/search` (jsonv2). The response is a
list of matches; each is turned into a GeoJSON Point Feature (coordinates in
[longitude, latitude] order, per the GeoJSON spec) and the lot is wrapped in a
FeatureCollection. Networked through `_http.get_json`.
"""

from __future__ import annotations

import json

from adapters.common.tools import Tool, tool
from adapters.tools import _http

SEARCH_URL = "https://nominatim.openstreetmap.org/search"


@tool
def geocode(bridge):
    async def run(args: dict) -> str:
        query = str(args.get("query", "")).strip()
        if not query:
            raise ValueError("no query provided")
        limit = args.get("limit", 5)
        try:
            limit = int(limit)
        except (TypeError, ValueError):
            limit = 5
        limit = max(1, min(10, limit))  # clamp 1..10

        results = await _http.get_json(
            SEARCH_URL,
            params={"q": query, "format": "jsonv2", "limit": limit, "addressdetails": 1},
        )
        if not results:
            return f"No location found for: {query}"

        features = []
        for r in results:
            feature = {
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    "coordinates": [float(r["lon"]), float(r["lat"])],  # GeoJSON: lon first
                },
                "properties": {
                    "display_name": r.get("display_name"),
                    "name": r.get("name"),
                    "category": r.get("category"),
                    "type": r.get("type"),
                    "importance": r.get("importance"),
                },
            }
            bbox = r.get("boundingbox")
            if bbox:  # Nominatim: [south, north, west, east] -> GeoJSON bbox [minLon, minLat, maxLon, maxLat]
                south, north, west, east = (float(b) for b in bbox)
                feature["bbox"] = [west, south, east, north]
            features.append(feature)

        return json.dumps({"type": "FeatureCollection", "features": features})

    return Tool(
        "geocode",
        "Resolve a place name to coordinates via OpenStreetMap Nominatim. Returns a "
        "GeoJSON FeatureCollection of Point features (coordinates [longitude, latitude]), "
        "one per match. Pass a place name; optionally cap results with limit (1..10).",
        {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "e.g. 'Seoul' or 'Eiffel Tower'"},
                "limit": {"type": "integer", "description": "max results, 1..10 (default 5)"},
            },
            "required": ["query"],
        },
        run,
    )
