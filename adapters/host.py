"""Host — the multi-session agent supervisor.

Connects to the hub on the control channel and, for each session a user opens, spawns
the active roster cast: one asyncio task per agent, each its own bridge + WS — N
independent single-agent loops, no orchestration. One process runs the whole cast
across every session.

On top of the auto-spawned cast it serves **per-session participant config** (v2,
shell-level — outside the abra-spec contract): the UI can `ADD_AGENT`/`REMOVE_AGENT`
from the library (relayed by the hub), and the host reports each agent's raw status
(`AGENT_STATUS`) up the control connection for the hub to combine with presence.

    .venv/bin/python -m adapters.host                 # default roster (adapters/roster.toml)
    .venv/bin/python -m adapters.host --roster my.toml --url ws://127.0.0.1:8787

The launch seam (`connect`/`build_agent`/`run_agent`) is injectable so the
spawn/add/remove logic is testable without a live hub.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json

import websockets

from adapters.common.agentdef import build_agent as _build_agent
from adapters.common.bridge import connect as _connect
from adapters.common.loop import run_agent as _run_agent
from adapters.roster import load_catalog, load_roster


class Host:
    def __init__(
        self,
        url,
        roster,
        catalog=None,
        *,
        connect_token="dev",
        connect=_connect,
        build_agent=_build_agent,
        run_agent=_run_agent,
    ):
        self.url = url
        self.roster = roster  # the ACTIVE cast (list[AgentConfig]) every session auto-spawns
        # the LIBRARY (name -> AgentConfig) add_agent draws from; defaults to the active cast
        self.catalog = catalog or {c.name.lower(): c for c in roster}
        self.connect_token = connect_token
        self._connect = connect
        self._build_agent = build_agent
        self._run_agent = run_agent
        self.sessions: dict[str, dict[str, tuple]] = {}  # sessionId -> {name.lower(): (bridge, task)}
        self._control = None  # the control ws, once connected (for reporting status up)
        self.ready = asyncio.Event()  # set once the control channel JOIN is sent

    # --- reporting up the control channel ----------------------------------
    async def _report(self, frame: dict) -> None:
        if self._control is not None:
            with contextlib.suppress(Exception):
                await self._control.send(json.dumps(frame))

    def _status_cb(self, sid: str, name: str):
        async def report(**delta):  # phase=… / busy=… / lastError=…
            await self._report({"type": "AGENT_STATUS", "sessionId": sid, "name": name, **delta})

        return report

    # --- spawn / stop one agent --------------------------------------------
    async def _spawn_one(self, sid, cfg):
        await self._report({"type": "AGENT_STATUS", "sessionId": sid, "name": cfg.name, "phase": "starting"})
        bridge = await self._connect(self.url, f"agent:{cfg.name.lower()}", sid, connect_token=self.connect_token)
        try:
            agent = self._build_agent(bridge, cfg)
            task = asyncio.create_task(
                self._run_agent(bridge, agent, cfg.name, cfg.blurb, on_status=self._status_cb(sid, cfg.name))
            )
        except BaseException:
            await self._close_bridge(bridge)  # don't leak the connection if build/launch fails
            raise
        return (bridge, task)

    async def _close_bridge(self, bridge) -> None:
        await bridge.stop()
        with contextlib.suppress(Exception):
            await bridge._ws.close()

    async def _stop_one(self, entry) -> None:
        bridge, task = entry
        task.cancel()
        with contextlib.suppress(Exception, asyncio.CancelledError):
            await task  # CancelledError is a BaseException — suppress it explicitly
        await self._close_bridge(bridge)

    # --- session lifecycle (the auto-spawned cast) ----------------------------
    async def spawn_session(self, sid):
        if sid in self.sessions:
            return  # idempotent — a duplicate OPENED (e.g. a slow reload) is a no-op
        self.sessions[sid] = {}  # claim the session before any await so a duplicate is a no-op
        results = await asyncio.gather(
            *(self._spawn_one(sid, cfg) for cfg in self.roster), return_exceptions=True
        )
        session = {}
        for cfg, res in zip(self.roster, results):
            if isinstance(res, BaseException):  # one agent failing must not sink the session
                print(f"[host] session {sid!r}: {cfg.name} failed to spawn ({res!r})")
                await self._report(
                    {"type": "AGENT_STATUS", "sessionId": sid, "name": cfg.name, "phase": "crashed", "lastError": str(res)}
                )
            else:
                session[cfg.name.lower()] = res
        self.sessions[sid] = session
        print(f"[host] session {sid!r}: spawned {sorted(session)}")

    async def teardown_session(self, sid):
        session = self.sessions.pop(sid, {})
        for entry in session.values():
            entry[1].cancel()
        await asyncio.gather(*(self._stop_one(e) for e in session.values()), return_exceptions=True)
        if session:
            print(f"[host] session {sid!r}: torn down")

    # --- per-session participant config (v2) ----------------------------------
    async def add_agent(self, sid, name):
        session = self.sessions.get(sid)
        if session is None or not name:
            return  # session not open / no name
        key = name.lower()
        if key in session:
            return  # already present — idempotent
        cfg = self.catalog.get(key)
        if cfg is None:
            await self._report(
                {"type": "AGENT_STATUS", "sessionId": sid, "name": name, "phase": "crashed", "lastError": "unknown agent"}
            )
            return
        try:
            session[key] = await self._spawn_one(sid, cfg)
        except BaseException as e:  # a failed add must not crash the host loop
            await self._report(
                {"type": "AGENT_STATUS", "sessionId": sid, "name": cfg.name, "phase": "crashed", "lastError": str(e)}
            )
            return
        print(f"[host] session {sid!r}: added {cfg.name}")

    async def remove_agent(self, sid, name):
        session = self.sessions.get(sid)
        if session is None or not name:
            return
        entry = session.pop(name.lower(), None)
        if entry is None:
            return
        # report 'removed' BEFORE the WS closes, so the hub distinguishes it from a crash
        await self._report({"type": "AGENT_STATUS", "sessionId": sid, "name": name, "phase": "removed"})
        await self._stop_one(entry)
        print(f"[host] session {sid!r}: removed {name}")

    # --- control loop ------------------------------------------------------
    def _library_frame(self) -> dict:
        return {
            "type": "LIBRARY",
            "agents": [{"name": c.name, "type": c.type, "blurb": c.blurb} for c in self.catalog.values()],
        }

    async def run(self):
        async with websockets.connect(self.url) as ws:
            self._control = ws
            await ws.send(
                json.dumps({"type": "JOIN", "role": "control", "source": "host", "connectToken": self.connect_token})
            )
            await ws.send(json.dumps(self._library_frame()))  # tell the hub what's addable
            self.ready.set()
            print(f"[host] control channel up on {self.url}; library: {sorted(self.catalog)}")
            try:
                async for raw in ws:
                    frame = json.loads(raw)
                    t, sid = frame.get("type"), frame.get("sessionId")
                    if t == "SESSION_OPENED":
                        await self.spawn_session(sid)
                    elif t == "SESSION_EMPTY":
                        await self.teardown_session(sid)
                    elif t == "ADD_AGENT":
                        await self.add_agent(sid, frame.get("name"))
                    elif t == "REMOVE_AGENT":
                        await self.remove_agent(sid, frame.get("name"))
            finally:
                self._control = None
                for sid in list(self.sessions):
                    await self.teardown_session(sid)


async def main() -> None:
    ap = argparse.ArgumentParser(description="Run the ABRA multi-session agent host.")
    ap.add_argument("--url", default="ws://127.0.0.1:8787")
    ap.add_argument("--roster", default=None, help="roster TOML path (default: adapters/roster.toml)")
    args = ap.parse_args()
    roster = load_roster(args.roster) if args.roster else load_roster()
    catalog = load_catalog(args.roster) if args.roster else load_catalog()
    host = Host(args.url, roster, catalog)
    while True:  # survive a hub that isn't up yet / restarts
        try:
            await host.run()
        except (OSError, websockets.exceptions.WebSocketException) as e:
            # OSError covers connect-time refusals; WebSocketException covers a mid-run
            # drop — incl. ConnectionClosed from an *abrupt* hub crash (TCP RST), which
            # ConnectionError would NOT catch and would kill the host instead of retrying.
            print(f"[host] control channel down ({e}); retrying in 2s")
            host.ready = asyncio.Event()
            await asyncio.sleep(2)


if __name__ == "__main__":
    asyncio.run(main())
