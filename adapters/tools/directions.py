"""directions — a route between two place names as GeoJSON (no API key).

Two stages over `_http`: Nominatim geocodes each endpoint name to a lon/lat,
then the public OSRM demo routes between them and returns the road geometry plus
a turn-by-turn step list. The output is spec-compliant GeoJSON — a
FeatureCollection of the origin Point, the destination Point and the route
LineString, all in [longitude, latitude] order, with a top-level bbox.

Note: the public OSRM demo server (router.project-osrm.org) is effectively
car-only — the `profile` arg ("driving"/"walking"/"cycling") is passed through
as the OSRM path segment, but walking/cycling routing needs a self-hosted OSRM
or a service such as OpenRouteService. Networked through `_http.get_json`.
"""

from __future__ import annotations

import json

from adapters.common.tools import Tool, tool
from adapters.tools import _http

GEOCODE_URL = "https://nominatim.openstreetmap.org/search"
OSRM_URL = "https://router.project-osrm.org/route/v1"


async def _geocode(place: str, role: str) -> tuple[float, float] | str:
    """Resolve a place name to (lon, lat) via Nominatim, or a friendly miss
    string `Could not geocode {role}: {place}` when there are no results."""
    results = await _http.get_json(
        GEOCODE_URL, params={"q": place, "format": "jsonv2", "limit": 1}
    )
    if not results:
        return f"Could not geocode {role}: {place}"
    r = results[0]
    return float(r["lon"]), float(r["lat"])


@tool
def directions(bridge):
    async def run(args: dict) -> str:
        origin = str(args.get("origin", "")).strip()
        destination = str(args.get("destination", "")).strip()
        if not origin:
            raise ValueError("no origin provided")
        if not destination:
            raise ValueError("no destination provided")
        profile = str(args.get("profile") or "driving")

        o = await _geocode(origin, "origin")
        if isinstance(o, str):
            return o
        d = await _geocode(destination, "destination")
        if isinstance(d, str):
            return d
        olon, olat = o
        dlon, dlat = d

        route_data = await _http.get_json(
            f"{OSRM_URL}/{profile}/{olon},{olat};{dlon},{dlat}",
            params={
                "overview": "simplified",
                "geometries": "geojson",
                "steps": "true",
                "alternatives": "false",
            },
        )
        routes = route_data.get("routes") or []
        if route_data.get("code") != "Ok" or not routes:
            return f"No route found between {origin} and {destination}"
        route = routes[0]

        coords = route["geometry"]["coordinates"]
        lons = [c[0] for c in coords]
        lats = [c[1] for c in coords]
        bbox = [min(lons), min(lats), max(lons), max(lats)]

        distance = route["distance"]
        duration = route["duration"]
        steps = [
            {
                "name": s.get("name"),
                "distance": s.get("distance"),
                "duration": s.get("duration"),
                "type": s.get("maneuver", {}).get("type"),
                "modifier": s.get("maneuver", {}).get("modifier"),
            }
            for s in route["legs"][0]["steps"]
        ]

        return json.dumps(
            {
                "type": "FeatureCollection",
                "bbox": bbox,
                "features": [
                    {
                        "type": "Feature",
                        "geometry": {"type": "Point", "coordinates": [olon, olat]},
                        "properties": {"role": "origin", "name": origin},
                    },
                    {
                        "type": "Feature",
                        "geometry": {"type": "Point", "coordinates": [dlon, dlat]},
                        "properties": {"role": "destination", "name": destination},
                    },
                    {
                        "type": "Feature",
                        "geometry": route["geometry"],
                        "properties": {
                            "role": "route",
                            "distance_m": distance,
                            "duration_s": duration,
                            "distance_km": round(distance / 1000, 2),
                            "duration_min": round(duration / 60, 1),
                            "profile": profile,
                            "steps": steps,
                        },
                    },
                ],
            }
        )

    return Tool(
        "directions",
        "Get a route between two place names as GeoJSON (a FeatureCollection with "
        "the origin/destination Points and the route LineString, plus distance and "
        "duration) via Nominatim + OSRM. Pass two place names; profile is one of "
        "driving, walking, cycling (the public OSRM demo is effectively car-only).",
        {
            "type": "object",
            "properties": {
                "origin": {"type": "string", "description": "start place name, e.g. 'Seoul Station'"},
                "destination": {"type": "string", "description": "end place name, e.g. 'Gangnam Station'"},
                "profile": {
                    "type": "string",
                    "enum": ["driving", "walking", "cycling"],
                    "description": "travel mode (default 'driving')",
                },
            },
            "required": ["origin", "destination"],
        },
        run,
    )
