"""fetch_url — fetch a web page and return its readable text.

GETs the URL over `_http.get_text` and strips the HTML to plain text with the
stdlib `html.parser.HTMLParser` — the contents of <script>/<style> are dropped and
runs of whitespace collapsed. No third-party parser; networked (the only failure
surface is the HTTP fetch).
"""

from __future__ import annotations

from html.parser import HTMLParser

from adapters.common.tools import Tool, tool
from adapters.tools import _http

_SKIP = {"script", "style"}


class _TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self._skip_depth = 0
        self._parts: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag in _SKIP:
            self._skip_depth += 1

    def handle_endtag(self, tag):
        if tag in _SKIP and self._skip_depth:
            self._skip_depth -= 1

    def handle_data(self, data):
        if not self._skip_depth:
            self._parts.append(data)


def html_to_text(html: str) -> str:
    """Strip `html` to plain text: drop <script>/<style> bodies, collapse runs of
    whitespace to single spaces, and trim."""
    p = _TextExtractor()
    p.feed(html)
    return " ".join("".join(p._parts).split())


@tool
def fetch_url(bridge):
    async def run(args: dict) -> str:
        url = str(args.get("url", "")).strip()
        if not url:
            raise ValueError("no url provided")
        max_chars = int(args.get("max_chars", 4000))
        text = html_to_text(await _http.get_text(url))
        if not text:
            return "[no readable content]"
        if len(text) > max_chars:
            return text[:max_chars] + "…[truncated]"
        return text

    return Tool(
        "fetch_url",
        "Fetch a web page by URL and return its readable text (HTML stripped). "
        "Truncates to max_chars (default 4000).",
        {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "the page URL to fetch"},
                "max_chars": {"type": "integer", "description": "max characters to return (default 4000)"},
            },
            "required": ["url"],
        },
        run,
    )
