"""Tiny stdlib HTTP helpers for the example tools — deliberately NO third-party dep.

GET-only JSON/text over `urllib`, run off the event loop via `asyncio.to_thread`
(urllib is blocking). The networked tools (web_search/fetch_url/wikipedia/weather/
scholar_search) call these. Keep this minimal — it is not a general HTTP client.

Guard: URLs (including every redirect hop) must be public http(s). `urllib` would
otherwise happily serve `file://` (local file read) and loopback/private targets (the
hub itself, local services, cloud metadata), and the URL is LLM-chosen, so it can be
steered by whatever the agent read last. The check resolves the host once, up front;
a DNS answer that changes between check and connect (rebinding) is out of scope here.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import socket
import urllib.parse
import urllib.request
from typing import Any

# A few public APIs (Wikipedia, OpenAlex) reject blank/agent-less User-Agents.
USER_AGENT = "abra-tools/0.0 (+https://github.com/megagonlabs/abra; agent-bound-ui demo)"
DEFAULT_TIMEOUT = 15.0
ALLOWED_SCHEMES = {"http", "https"}
MAX_BODY_BYTES = 2 * 1024 * 1024  # a tool result never needs more than this
MAX_REDIRECTS = 5


def check_url(url: str) -> None:
    """Raise ValueError unless `url` is http(s) to a host that resolves only to public addresses."""
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ALLOWED_SCHEMES:
        raise ValueError(f"fetch refused: scheme {parts.scheme!r} is not allowed (http/https only)")
    host = parts.hostname
    if not host:
        raise ValueError("fetch refused: no host in url")
    port = parts.port or (443 if parts.scheme == "https" else 80)
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except (socket.gaierror, UnicodeError) as e:
        raise ValueError(f"fetch refused: cannot resolve {host!r}") from e
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%", 1)[0])
        if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
            ip = ip.ipv4_mapped
        if not ip.is_global:
            raise ValueError(f"fetch refused: {host!r} resolves to a non-public address ({ip})")


class _CheckedRedirects(urllib.request.HTTPRedirectHandler):
    """Re-run `check_url` on every redirect target (a public URL may 302 to a private one)."""

    max_redirections = MAX_REDIRECTS

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        check_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_OPENER = urllib.request.build_opener(_CheckedRedirects())


def _build_url(url: str, params: dict | None) -> str:
    if not params:
        return url
    q = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    return f"{url}?{q}" if q else url


def _blocking_get(url: str, params: dict | None, headers: dict | None, timeout: float) -> str:
    full = _build_url(url, params)
    check_url(full)
    req = urllib.request.Request(full, headers={"User-Agent": USER_AGENT, **(headers or {})})  # noqa: S310
    with _OPENER.open(req, timeout=timeout) as r:  # noqa: S310 — scheme/host checked above
        body = r.read(MAX_BODY_BYTES + 1)
    return body[:MAX_BODY_BYTES].decode("utf-8", "replace")


async def get_text(
    url: str, params: dict | None = None, headers: dict | None = None, timeout: float = DEFAULT_TIMEOUT
) -> str:
    """GET `url` (+ querystring `params`) and return the response body as text."""
    return await asyncio.to_thread(_blocking_get, url, params, headers, timeout)


async def get_json(
    url: str, params: dict | None = None, headers: dict | None = None, timeout: float = DEFAULT_TIMEOUT
) -> Any:
    """GET `url` and parse the response body as JSON."""
    return json.loads(await get_text(url, params, headers, timeout))
