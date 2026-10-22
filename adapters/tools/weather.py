"""weather — current conditions for a place via Open-Meteo (no API key).

Two GETs over `_http`: first the geocoding API resolves a place name to a
lat/lon, then the forecast API returns current conditions + the day's high/low.
WMO weather codes are mapped to short descriptions via a module-level table.
Networked through `_http.get_json`.
"""

from __future__ import annotations

import json

from adapters.common.tools import Tool, tool
from adapters.tools import _http

GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"

# WMO weather interpretation codes -> short description; unknown -> "Unknown".
WEATHER_CODES = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Fog",
    48: "Rime fog",
    51: "Light drizzle",
    53: "Drizzle",
    55: "Dense drizzle",
    61: "Slight rain",
    63: "Rain",
    65: "Heavy rain",
    71: "Slight snow",
    73: "Snow",
    75: "Heavy snow",
    80: "Rain showers",
    81: "Rain showers",
    82: "Violent rain showers",
    95: "Thunderstorm",
    96: "Thunderstorm w/ hail",
    99: "Thunderstorm w/ hail",
}


@tool
def weather(bridge):
    async def run(args: dict) -> str:
        location = str(args.get("location", "")).strip()
        if not location:
            raise ValueError("no location provided")

        geo = await _http.get_json(
            GEOCODE_URL,
            params={"name": location, "count": 1, "language": "en", "format": "json"},
        )
        results = geo.get("results") or []
        if not results:
            return f"No location found for: {location}"
        place = results[0]

        fc = await _http.get_json(
            FORECAST_URL,
            params={
                "latitude": place["latitude"],
                "longitude": place["longitude"],
                "current": "temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code",
                "daily": "temperature_2m_max,temperature_2m_min",
                "timezone": "auto",
            },
        )
        current = fc["current"]
        daily = fc["daily"]
        return json.dumps(
            {
                "location": f"{place['name']}, {place['country']}",
                "temperature_c": current["temperature_2m"],
                "conditions": WEATHER_CODES.get(current["weather_code"], "Unknown"),
                "humidity_pct": current["relative_humidity_2m"],
                "wind_speed": current["wind_speed_10m"],
                "high_c": daily["temperature_2m_max"][0],
                "low_c": daily["temperature_2m_min"][0],
            }
        )

    return Tool(
        "weather",
        "Get the current weather for a place (temperature, conditions, humidity, wind, "
        "and the day's high/low) via Open-Meteo. Pass a city or place name.",
        {
            "type": "object",
            "properties": {"location": {"type": "string", "description": "e.g. 'Seoul' or 'Paris, France'"}},
            "required": ["location"],
        },
        run,
    )
