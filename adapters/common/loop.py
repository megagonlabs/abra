"""The shared participant loop — harness-agnostic.

Self-selection (who *responds* to a broadcast chat message) is the agent's own
concern, layered — all evaluated LOCALLY by each agent from the stream it already
observes, with NO central selector (the model's "agents self-select by role").
A "thread" is bounded by human turns; the layers, grounded in a survey of how
multi-agent systems handle this (conversation-analysis turn-taking + Inner
Thoughts / DyLAN + the AutoGen/Slack mention idiom):

  1. human message            → always a candidate (the human is never gated)
  2. an @mention (any sender) → only the @-named agent(s); others stand down
  3a. unaddressed peer message → only an *engaged* agent (one already pulled into
      this thread via an @mention) may continue — without re-@
  3b. (the agent itself) returns an EMPTY reply when it has nothing new to add →
      silence; the prompt drives this, the loop just doesn't broadcast empties
  4. hop-cap: after CAP agent turns with no human input, peers go quiet (a
      runaway guard; the human resets the thread). `/`-commands are never for
      agents; an agent never reacts to its own message (the bridge filters it).
"""

from __future__ import annotations

import re

_MENTION = re.compile(r"@([a-z0-9_]+)", re.IGNORECASE)  # full-token (avoids @scouting matching scout)
DEFAULT_HOP_CAP = 5  # max agent turns in a thread before peers go quiet (human resets)


def _mentions(text: str | None) -> set[str]:
    return {m.lower() for m in _MENTION.findall(text or "")}


def _is_human(source: str | None) -> bool:
    return source == "user" or (source or "").startswith("user:")


class Conversation:
    """Per-agent, per-session self-selection state, derived from the observed stream.
    `candidacy` answers 'should I consider replying?' (layers 1/2/3a/4); the agent's
    own `respond` returning empty is layer 3b (silence)."""

    def __init__(self, name: str, cap: int = DEFAULT_HOP_CAP):
        self.name = name.lower()
        self.cap = cap
        self.hops = 0  # agent turns since the last human message (the thread length)
        self.engaged = False  # have I been pulled into this thread (addressed / addressed someone)

    def candidacy(self, text: str | None, source: str | None) -> bool:
        if not text or text.lstrip().startswith("/"):
            return False
        human = _is_human(source)
        if not human and self.hops >= self.cap:  # 4 — peer thread exhausted (human exempt + resets)
            return False
        mentions = _mentions(text)
        if mentions:  # 2 — only the @-named, uniform across senders (human or peer)
            return self.name in mentions
        if human:  # 1 — unaddressed human → answer the session
            return True
        return self.engaged  # 3a — unaddressed peer → only if already in this thread

    def observe(self, text: str | None, source: str | None) -> None:
        """Fold an observed message (any sender, never self) into the state."""
        if not text:
            return
        if _is_human(source):  # a human turn resets the thread
            self.hops, self.engaged = 0, False
        else:
            self.hops += 1
        if self.name in _mentions(text):  # addressed by anyone → I'm in the thread
            self.engaged = True

    def spoke(self, text: str | None) -> None:
        """Account for THIS agent's own reply (not observed back via the bridge)."""
        self.hops += 1
        if _mentions(text):  # I addressed someone → I'm in a directed thread
            self.engaged = True


# --- observation model -----------------------------------------------------
# Two axes, deliberately separate (see docstring): the agent OBSERVES every
# meaningful frame into its context, but only WAKES (takes an LLM turn) on the
# three deterministic triggers below. `who-responds` is a demo-shell policy, not
# the contract — the deterministic rules approximate a per-turn LLM self-decision
# we skip for latency/cost; once woken the SILENCE prompt lets the agent stay quiet.

_ATTENTION_PREFIXES = ("highlight_", "dehighlight_")  # hover/dwell family → attention bucket
_MEANINGFUL_UPDATE = ("content", "config", "title", "pending", "appliedEffects", "mode")


class AttentionBuffer:
    """Not used by the demo. Hover/dwell attention signals are routed here rather than
    dropped, so a later version can aggregate them (debounce by bound referent, emit a
    dwell digest via agent.observe(...)) without changing the loop. Today it is a no-op:
    it never feeds context and never wakes the agent."""

    def push(self, frame) -> None:
        pass  # a later version aggregates here; grounding (path → referent via `ref`) reads the replica.


def _render_event(frame) -> str:
    """A peer canvas event as one context line (observed, not reacted to)."""
    t, src, cid = frame.get("type"), frame.get("source"), frame.get("canvasId")
    if t == "CANVAS_EVENT":
        tail = f" path={frame['path']}" if frame.get("path") else ""
        val = f" value={frame['value']}" if frame.get("value") is not None else ""
        return f"[canvas] {src} fired {frame.get('action')} on {cid}{tail}{val}"
    if t == "CREATE_CANVAS":
        return f"[canvas] {src} created {cid} (view={frame.get('view')}, title={frame.get('title')})"
    if t == "UPDATE_CANVAS":
        keys = ", ".join(k for k in _MEANINGFUL_UPDATE if k in frame) or "change"
        return f"[canvas] {src} updated {cid} ({keys})"
    if t == "CLOSE_CANVAS":
        return f"[canvas] {src} closed {cid}"
    if t == "CANCEL_PENDING":
        return f"[canvas] {src} cancelled a pending on {cid}"
    return f"[canvas] {t} on {cid}"


def _is_noise_update(frame) -> bool:
    """An UPDATE_CANVAS carrying ONLY a lock or highlight overlay = coordination churn."""
    if frame.get("type") != "UPDATE_CANVAS":
        return False
    if any(k in frame for k in _MEANINGFUL_UPDATE):
        return False
    return ("lock" in frame) or ("highlight" in frame)


def _classify(frame, me):
    """(kind, obs) — kind ∈ {chat, event, attention, drop}. obs = {text, source} for
    chat/event; the raw frame for attention; None for drop."""
    t, src = frame.get("type"), frame.get("source")
    if src == me:
        return "drop", None  # own frame (bridge.cares already filters; belt-and-suspenders)
    if t in ("USER_MESSAGE", "CANVAS_MESSAGE"):
        return "chat", {"text": frame.get("text") or "", "source": src}
    if t == "CANVAS_EVENT":
        if (frame.get("action") or "").startswith(_ATTENTION_PREFIXES):
            return "attention", frame
        return "event", {"text": _render_event(frame), "source": src}
    if t == "CREATE_CANVAS":
        return "event", {"text": _render_event(frame), "source": src}
    if t in ("UPDATE_CANVAS", "CLOSE_CANVAS", "CANCEL_PENDING"):
        if _is_noise_update(frame):
            return "drop", None
        return "event", {"text": _render_event(frame), "source": src}
    return "drop", None  # SNAPSHOT / ERROR / LOCK / anything else


def _new_owned_pendings(replica, me, seen):
    """Open pendings on canvases THIS agent owns that we haven't handled yet. Replica-
    driven (independent of frame shape): a consequence-arming CANVAS_EVENT carries the
    full pending map, already applied to the replica before session() yields the frame."""
    out = []
    for cid, cv in (replica.get("canvases") or {}).items():
        cv = cv or {}
        if cv.get("owner") != me or cv.get("closed"):
            continue
        for pid, p in (cv.get("pending") or {}).items():
            if pid in seen:
                continue
            seen.add(pid)
            out.append({"canvasId": cid, "pendingId": pid, "pending": p or {}})
    return out


def _render_pending(pend) -> str:
    p = pend["pending"]
    who = p.get("source", "someone")
    action = p.get("action") or p.get("control") or "?"
    tail = f" on {p['path']}" if p.get("path") else ""
    val = f" value={p['value']}" if p.get("value") is not None else ""
    return (
        f"[consequence] {who} invoked '{action}'{tail}{val} on your canvas "
        f"{pend['canvasId']} — it needs YOU (the owner) to resolve. Apply it with "
        f"update_canvas(canvas_id='{pend['canvasId']}', resolves='{pend['pendingId']}', "
        f"content=<the change>), or decline with a content-less resolve. If unsure, "
        f"read_canvas first."
    )


async def run_agent(bridge, agent, name: str, blurb: str = "", on_status=None) -> None:
    """`on_status(**delta)` (optional, async) is called on liveness changes —
    phase='online' after the greeting, busy=True/False around a reply, lastError on
    a failed turn — so a supervisor can surface status (it's the demo shell's, not
    the agent's, concern).

    Observe/react split: EVERY meaningful frame (chat + peer canvas events) is folded
    into the agent's context via `agent.observe`; a turn (`agent.respond`) fires only on
    the three wake triggers — @mention, engaged chat (both via `Conversation`), and a
    NEW pending on a canvas this agent owns (the consequence loop). Attention (hover)
    routes to a stub; true noise (lock/highlight churn, snapshots) is dropped."""

    async def status(**delta):
        if on_status is not None:
            await on_status(**delta)

    convo = Conversation(name)
    attention = AttentionBuffer()  # no-op today; never wakes
    seen_pendings: set[str] = set()
    me = bridge.source

    async def turn(text, source, *, chat: bool) -> None:
        await status(busy=True)
        try:
            out = await agent.respond(text, source)
            if out and chat:  # empty reply = SILENCE (don't count a chat turn)
                convo.spoke(out)
        except Exception as e:  # never let one bad turn kill the loop
            await status(busy=False, lastError=str(e))  # clear busy FIRST
            try:
                await bridge.say(f"[{name} error: {e}]")
            except Exception:  # a failed error-report must not kill the loop either
                pass
            return
        await status(busy=False)

    await bridge.say(f"{name} online — {blurb}." if blurb else f"{name} online.")
    await status(phase="online")
    async for frame in bridge.session():
        # 1) owner-pending wake — a consequence on my canvas needs ME to resolve it.
        #    Mark which pending this turn resolves so a content write auto-closes it
        #    (bridge.update_canvas); skip a pending a prior turn in this batch already cleared.
        for pend in _new_owned_pendings(bridge.replica, me, seen_pendings):
            cv = (bridge.replica.get("canvases") or {}).get(pend["canvasId"]) or {}
            if pend["pendingId"] not in (cv.get("pending") or {}):
                continue
            bridge.set_resolving(pend["canvasId"], pend["pendingId"])
            try:
                await turn(_render_pending(pend), "system", chat=False)
            finally:
                bridge.set_resolving(None, None)

        # 2) classify → observe (context) and/or react (chat wake).
        kind, obs = _classify(frame, me)
        if kind == "drop":
            continue
        if kind == "attention":
            attention.push(obs)  # no-op today; never wakes
            continue
        text, source = obs["text"], obs["source"]
        if kind == "chat":
            waking = convo.candidacy(text, source)
            convo.observe(text, source)  # self-selection bookkeeping, either way
            if waking:
                await turn(text, source, chat=True)
            else:
                agent.observe(text, source)  # heard it; not my turn — keep for context
        else:  # "event" — peer canvas activity: context only, no chat-wake
            agent.observe(text, source)
