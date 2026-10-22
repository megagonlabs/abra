"""CanvasBridge — the harness-agnostic agent side of ABRA.

Gives a pre-existing agent the canvas tool surface + the session stream + a
read-only replica. The bridge owns: the WS outbox, the unspoofable `source`, the
`seq` counter, a per-write `reqId` correlation registry (a tool awaits its own
reqId -> applied/rejected), and the replica (fed by broadcasts through the shared
apply_delta). The LLM/harness is a swappable detail layered on top; this is just
the substrate.

Transport is abstracted (anything with `async send(frame)` that is also async-
iterable of frames) so the bridge is unit-testable against a fake hub, and runs
against the real ws hub via `connect()`.
"""

from __future__ import annotations

import asyncio
import json
import re
from typing import Any
from uuid import uuid4

from adapters.common.apply_delta import apply_delta

# inline coordination-chip syntax the agent writes in chat: {chip:<label>|<canvasId>|<path>}
_CHIP_RE = re.compile(r"\{chip:([^}]*)\}")


def _parse_chips(text: str):
    """Turn `{chip:<label>|<canvasId>|<path>}` tokens into a CANVAS_MESSAGE `refs` map +
    a rewritten text carrying `{ref:<key>}` markers the client renders as hover chips.
    ONE path per chip (a cell chip points at exactly that cell). Returns (text, refs)."""
    refs: dict[str, Any] = {}

    def repl(m: re.Match) -> str:
        parts = [p.strip() for p in m.group(1).split("|")]
        label, canvas_id, path = (parts + ["", "", ""])[:3]
        if not canvas_id or not path:
            return m.group(0)  # malformed → leave the literal text
        key = f"c{len(refs)}"
        refs[key] = {"canvasId": canvas_id, "paths": [path], "label": label or path}
        return f"{{ref:{key}}}"

    return _CHIP_RE.sub(repl, text), refs

REPLICA_TYPES = {
    "SNAPSHOT",
    "CREATE_CANVAS",
    "UPDATE_CANVAS",
    "CLOSE_CANVAS",
    "CANCEL_PENDING",
    "CANVAS_EVENT",
    "CANVAS_MESSAGE",
    "USER_MESSAGE",
}

LOCK_LEASE_S = 30.0  # mirrors LOCK_LEASE_MS; bounds the claim wait
WRITE_TIMEOUT_S = 30.0  # a write awaits its reqId echo this long, then reports rejected:TIMEOUT (vs hanging)

_DISCONNECT = object()  # sentinel pushed onto the stream when the transport drops, so session() ends

# --- client-edge schema (structural) validation ----------------------------
# The generated Pydantic mirror IS the wire contract. We validate an OUTBOUND write
# against it BEFORE sending, so a malformed frame (missing/mistyped field, unknown key,
# a botched action binding) is caught instantly as VALIDATION — no server round-trip.
# This is the STRUCTURAL layer only: per-view content/presentation/value shapes stay
# permissive (Content/Presentation are extra='allow'), and the reducer still runs every
# SEMANTIC check (catalogue/owner/lock/immutable/state). Import is best-effort: if the
# spec module or pydantic is unavailable the pre-check is simply skipped (the server
# remains the authority), so the bridge never hard-depends on it.
try:
    from pydantic import ValidationError as _ValidationError

    from adapters.common import spec as _spec

    _WIRE_MODELS = {
        "CREATE_CANVAS": _spec.CreateCanvas,
        "UPDATE_CANVAS": _spec.UpdateCanvas,
        "CLOSE_CANVAS": _spec.CloseCanvas,
        "CANVAS_EVENT": _spec.CanvasEvent,  # RootModel union (gesture XOR control)
    }
except Exception:  # pragma: no cover — the pre-check is optional, not a hard dependency
    _ValidationError = None
    _WIRE_MODELS = {}


def _schema_error(frame: dict[str, Any]) -> str | None:
    """A concise reason if `frame` violates the wire schema, else None. Structural/type
    only — the client-edge counterpart to the reducer's semantic guards."""
    model = _WIRE_MODELS.get(frame.get("type"))
    if model is None or _ValidationError is None:
        return None  # not a schema-checked write (e.g. LOCK) → let the server handle it
    try:
        model.model_validate(frame)
        return None
    except _ValidationError as e:
        errs = e.errors()
        if not errs:
            return "invalid frame"
        first = errs[0]
        # drop the union arm names (CanvasEvent1/2) from the path so the reason reads cleanly
        loc = ".".join(
            str(p) for p in first.get("loc", ()) if p not in ("CanvasEvent1", "CanvasEvent2")
        )
        more = f" (+{len(errs) - 1} more)" if len(errs) > 1 else ""
        return f"{loc or 'frame'}: {first.get('msg', 'invalid')}{more}"


class ToolError(Exception):
    """A canvas tool resolved `rejected: <code>` (the closed ERROR.code set). `message`
    is the reducer's human-readable reason for THIS rejection (e.g. 'exclusive mode:
    owner only', or a validator's specific complaint) — the code is the coarse branch,
    the message is the fine-grained why. Surfaced to the model by run_tool."""

    def __init__(self, code: str, message: str | None = None, reason: str | None = None):
        super().__init__(f"{code}: {message}" if message else code)
        self.code = code
        self.message = message
        self.reason = reason  # machine-readable VALIDATION sub-tag (value.shape / value.ref / …)


class CanvasBridge:
    def __init__(self, transport, source, session_id, *, connect_token="dev", mint_req_id=None):
        self.transport = transport
        self.source = source
        self.session_id = session_id
        self.connect_token = connect_token
        self.replica: dict[str, Any] = {"rev": 0, "canvases": {}, "messages": []}
        self._reqs: dict[str, asyncio.Future] = {}
        self._seq = 0
        self._mint_req_id = mint_req_id or (lambda: f"{source}:{uuid4()}")
        self._stream: asyncio.Queue = asyncio.Queue()
        self._snapshot = asyncio.Event()
        self._recv_task: asyncio.Task | None = None
        self._lock_events: dict[str, asyncio.Event] = {}  # canvasId -> "lock changed" signal
        self._closed = False
        self.write_timeout = WRITE_TIMEOUT_S
        # (canvasId, pendingId) the current owner-pending wake-turn is resolving — set by
        # the loop; lets a resolving content write auto-close its pending (see update_canvas).
        self._resolving: tuple[str, str] | None = None

    # --- lifecycle ----------------------------------------------------------
    async def start(self) -> None:
        self._recv_task = asyncio.create_task(self._recv_loop())
        await self.transport.send(
            {
                "type": "JOIN",
                "sessionId": self.session_id,
                "connectToken": self.connect_token,
                "source": self.source,
            }
        )
        await self._snapshot.wait()

    async def stop(self) -> None:
        if self._recv_task:
            self._recv_task.cancel()

    async def _recv_loop(self) -> None:
        try:
            async for frame in self.transport:
                try:
                    self._on_frame(frame)
                except Exception:
                    continue  # a malformed frame must not kill the recv loop
        finally:
            self._fail_pending()  # transport ended/dropped -> don't leave tools hanging

    def _fail_pending(self) -> None:
        """On disconnect: fail every outstanding write and unblock session()."""
        self._closed = True
        for fut in self._reqs.values():
            if not fut.done():
                fut.set_result(("rejected", "DISCONNECTED", "transport dropped mid-write", None))
        self._reqs.clear()
        self._stream.put_nowait(_DISCONNECT)

    def _on_frame(self, frame: dict[str, Any]) -> None:
        t = frame.get("type")
        if t in REPLICA_TYPES:
            self.replica = apply_delta(self.replica, frame)
        if t == "SNAPSHOT":
            self._snapshot.set()
        if t == "UPDATE_CANVAS" and "lock" in frame:  # a lock-state broadcast
            self._lock_event(frame.get("canvasId")).set()
        rid = frame.get("reqId")
        if rid and rid in self._reqs:
            fut = self._reqs.pop(rid)
            if not fut.done():
                if t == "ERROR":
                    fut.set_result(
                        ("rejected", frame.get("code"), frame.get("message"), frame.get("reason"))
                    )
                else:
                    fut.set_result(("applied", frame, None, None))
        self._stream.put_nowait(frame)

    def _next_seq(self) -> int:
        self._seq += 1
        return self._seq

    async def _write(self, frame: dict[str, Any]):
        """Stamp source/seq/reqId, send, and await this write's own reqId echo. A lost
        echo times out (rejected:TIMEOUT) and a dropped transport rejects (DISCONNECTED)
        instead of hanging the tool call forever. Returns a 3-tuple
        (status, payload, message): on 'applied' payload is the echoed frame (message
        None); on 'rejected' payload is the ERROR.code, message its human reason, and reason
        the machine-readable VALIDATION sub-tag (or None)."""
        if self._closed:
            return ("rejected", "DISCONNECTED", "bridge is closed", None)
        rid = self._mint_req_id()
        # Client-edge STRUCTURAL pre-check before the frame ever leaves. seq is a placeholder
        # here (validated as ge=0); the REAL seq is assigned only if we actually send, so a
        # rejected write never burns a seq (no gap in the outbound stream).
        schema_msg = _schema_error({**frame, "source": self.source, "seq": 0, "reqId": rid})
        if schema_msg is not None:
            return ("rejected", "VALIDATION", schema_msg, "schema")
        stamped = {**frame, "source": self.source, "seq": self._next_seq(), "reqId": rid}
        fut = asyncio.get_running_loop().create_future()
        self._reqs[rid] = fut
        await self.transport.send(stamped)
        try:
            return await asyncio.wait_for(fut, self.write_timeout)
        except TimeoutError:
            self._reqs.pop(rid, None)
            return ("rejected", "TIMEOUT", f"no reqId echo within {self.write_timeout:.0f}s", None)

    # --- the five tools -----------------------------------------------------
    async def create_canvas(self, view: str, content: dict, **opts) -> str:
        ok, payload, message, reason = await self._write(
            {"type": "CREATE_CANVAS", "view": view, "content": content, **opts}
        )
        if ok == "applied":
            return payload["canvasId"]
        raise ToolError(payload, message, reason)

    def set_resolving(self, canvas_id: str | None, pending_id: str | None) -> None:
        """The owner-pending loop marks which pending the current turn resolves, so a
        resolving content write auto-attaches `resolves` (the agent needn't echo the id)."""
        self._resolving = (canvas_id, pending_id) if pending_id else None

    async def update_canvas(self, canvas_id: str, **fields) -> dict:
        # Inside an owner-pending wake-turn (scoped to ONE pending), a content write that
        # omits `resolves` IS resolving that pending — close it in the same write instead of
        # orphaning it. Apply-only (content required; a content-less DECLINE stays explicit),
        # explicit `resolves` always wins, and once per turn (cleared on first use so a 2nd
        # content write can't re-attach a now-closed pending).
        if "resolves" not in fields and fields.get("content") is not None and self._resolving:
            rcanvas, rpending = self._resolving
            if rcanvas == canvas_id:
                fields["resolves"] = rpending
                self._resolving = None
        # In collaborative mode the bridge auto-manages the lock around an
        # authoring write (claim -> write -> release); the LLM never sees it.
        # Only `content`/`resolves` are lock-gated; `config.presentation` is LWW (no lock).
        authoring = any(k in fields for k in ("content", "resolves"))
        locked = await self._ensure_lock(canvas_id) if authoring else False
        try:
            ok, payload, message, reason = await self._write(
                {"type": "UPDATE_CANVAS", "canvasId": canvas_id, **fields}
            )
        finally:
            if locked:
                await self._send_lock(canvas_id, "release")
        if ok == "applied":
            return payload
        raise ToolError(payload, message, reason)

    # --- collaborative lock (auto-managed) ----------------------------------
    def _lock_event(self, canvas_id: str) -> asyncio.Event:
        ev = self._lock_events.get(canvas_id)
        if ev is None:
            ev = asyncio.Event()
            self._lock_events[canvas_id] = ev
        return ev

    async def _send_lock(self, canvas_id: str, op: str) -> None:
        await self.transport.send(
            {"type": "LOCK", "canvasId": canvas_id, "op": op, "source": self.source, "seq": self._next_seq()}
        )

    async def _ensure_lock(self, canvas_id: str) -> bool:
        """Claim-or-retry the whole-canvas lock if the canvas is collaborative.
        Returns True if a lock is held by us (caller must release), False if no
        lock is needed. The broadcast state IS the reply — we await a `lock`
        broadcast whose holder is us, not a reqId. Raises ToolError on contention."""
        canvas = (self.replica["canvases"] or {}).get(canvas_id) or {}
        if canvas.get("mode") != "collaborative":
            return False
        loop = asyncio.get_running_loop()
        deadline = loop.time() + LOCK_LEASE_S
        while loop.time() < deadline:
            held = (self.replica["canvases"].get(canvas_id) or {}).get("lock")
            if held and held.get("holder") == self.source:
                return True
            ev = self._lock_event(canvas_id)
            ev.clear()
            await self._send_lock(canvas_id, "claim")
            try:  # a held lock yields no broadcast -> retry on the next release/expiry
                await asyncio.wait_for(ev.wait(), timeout=LOCK_LEASE_S / 2)
            except TimeoutError:
                pass
        # Possible refinement: on persistent contention, surface a non-terminal
        # "canvas is being edited — look and decide" hint (not the raw NOT_LOCK_HOLDER)
        # and shorten the wait window. The actual retry is the agent re-deciding from the
        # observed change, so there's no re-submit. Reachable only once a collaborative
        # canvas has two concurrent agent authors.
        raise ToolError("NOT_LOCK_HOLDER", "canvas is being edited by another agent")

    async def close_canvas(self, canvas_id: str) -> dict:
        ok, payload, message, reason = await self._write({"type": "CLOSE_CANVAS", "canvasId": canvas_id})
        if ok == "applied":
            return payload
        raise ToolError(payload, message, reason)

    async def fire_action(self, canvas_id: str, action: str, *, value=None, path=None) -> dict:
        frame: dict[str, Any] = {"type": "CANVAS_EVENT", "canvasId": canvas_id, "action": action, "timestamp": 0}
        if value is not None:
            frame["value"] = value
        if path is not None:
            frame["path"] = path
        ok, payload, message, reason = await self._write(frame)
        if ok == "applied":
            return payload
        raise ToolError(payload, message, reason)

    async def say(self, text: str, refs: dict | None = None) -> None:
        """Post plain chat text to the session (CANVAS_MESSAGE). Fire-and-forget —
        messaging is not a tool and carries no reqId correlation. If `refs` isn't given,
        parse inline `{chip:<label>|<canvasId>|<path>}` tokens the agent wrote into the
        message's `refs` map (each a hover-to-highlight coordination chip)."""
        if refs is None:
            text, refs = _parse_chips(text)
        frame: dict[str, Any] = {"type": "CANVAS_MESSAGE", "text": text}
        if refs:
            frame["refs"] = refs
        await self.transport.send({**frame, "source": self.source, "seq": self._next_seq()})

    def read_canvas(self, canvas_id: str | None = None, scope: str = "index"):
        """Synchronous replica read. No id / scope='index' -> session index;
        id -> 'interface' (bindings/controls) or 'full' (+ content)."""
        canvases = self.replica["canvases"]
        if canvas_id is None or scope == "index":
            return [
                {
                    "canvasId": c.get("canvasId"),
                    "view": c.get("view"),
                    "title": c.get("title"),
                    "owner": c.get("owner"),
                    "display": c.get("display"),
                }
                for c in canvases.values()
            ]
        cv = canvases.get(canvas_id)
        if cv is None:
            return None
        if scope == "interface":
            cfg = cv.get("config") or {}
            return {
                "view": cv.get("view"),
                "actions": cfg.get("actions"),
                "controls": cfg.get("controls"),
            }
        return cv  # full

    # --- inbound stream -----------------------------------------------------
    def cares(self, frame: dict[str, Any]) -> bool:
        """Default self-selection: pass everything except this agent's own frames."""
        return frame.get("source") != self.source

    def observe(self, frame: dict[str, Any]) -> dict[str, Any]:
        """Package a stream frame into an observation: the event + the replica slice."""
        cid = frame.get("canvasId")
        return {"event": frame, "canvas": self.replica["canvases"].get(cid) if cid else None}

    async def session(self):
        """Async iterator over session frames the agent cares about; ends if the
        transport drops (the _DISCONNECT sentinel) instead of blocking forever."""
        while True:
            frame = await self._stream.get()
            if frame is _DISCONNECT:
                return
            if self.cares(frame):
                yield frame


class WsTransport:
    """websockets adapter: JSON on the wire, async-iterable of frames."""

    def __init__(self, ws):
        self._ws = ws

    async def send(self, frame: dict[str, Any]) -> None:
        await self._ws.send(json.dumps(frame))

    def __aiter__(self):
        return self._iter()

    async def _iter(self):
        async for raw in self._ws:
            yield json.loads(raw)


async def connect(url: str, source: str, session_id: str, **kw) -> CanvasBridge:
    """Connect to a hub over ws and return a started bridge. Caller awaits bridge.stop()."""
    import websockets

    ws = await websockets.connect(url)
    bridge = CanvasBridge(WsTransport(ws), source, session_id, **kw)
    bridge._ws = ws  # keep a handle for close
    await bridge.start()
    return bridge
