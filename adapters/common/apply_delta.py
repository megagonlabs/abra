"""Shared replica reduction — Python mirror of abra-reducer/src/apply.js.

`merge_content` mirrors `mergeContent` (content keyed-merge); `apply_delta` mirrors
`applyDelta` (client-side frame reduction that rebuilds the replica from hub
broadcasts). Both are fixture-tested against the JS reducer (adapters/common/fixtures)
so the two implementations cannot drift. Keep this a mechanical mirror of the JS.
"""

from __future__ import annotations

from typing import Any


def merge_content(
    base: dict[str, Any] | None, patch: dict[str, Any] | None
) -> dict[str, Any]:
    """Merge a content patch into base content (array=replace, dict=keyed-merge, None deletes)."""
    out: dict[str, Any] = dict(base or {})
    for key, val in (patch or {}).items():
        if isinstance(val, list):
            out[key] = val
        elif isinstance(val, dict):
            cur: dict[str, Any] = dict(out.get(key) or {})
            for el_id, elem in val.items():
                if elem is None:
                    cur.pop(el_id, None)
                elif isinstance(elem, dict):
                    cur[el_id] = {**(cur.get(el_id) or {}), **elem}
                else:
                    cur[el_id] = elem
            out[key] = cur
        else:
            out[key] = val
    return out


def merge_config_patch(
    base: dict[str, Any] | None, patch: dict[str, Any] | None
) -> dict[str, Any] | None:
    """Merge an UPDATE `config` patch (presentation keyed-merge; controls LWW)."""
    if not patch:
        return base
    out: dict[str, Any] = dict(base or {})
    changed = False
    if "presentation" in patch:
        out["presentation"] = merge_content((base or {}).get("presentation"), patch["presentation"])
        changed = True
    if "controls" in patch:
        out["controls"] = patch["controls"]
        changed = True
    return out if changed else base


def _build_canvas(frame: dict[str, Any]) -> dict[str, Any]:
    cv: dict[str, Any] = {
        "canvasId": frame.get("canvasId"),
        "owner": frame.get("source"),
        "view": frame.get("view"),
        "content": frame.get("content") or {},
        "mode": frame.get("mode") or "exclusive",
        "display": frame.get("display") or "inline",
        "closed": False,
        "lock": None,
        "pending": {},
        "highlight": {},
        "appliedEffects": {},
        "rev": frame.get("rev"),
    }
    for k in ("config", "title", "order"):
        if k in frame:
            cv[k] = frame[k]
    return cv


def _merge_canvas(cur: dict[str, Any], frame: dict[str, Any]) -> dict[str, Any]:
    nxt = dict(cur)
    if "content" in frame:
        nxt["content"] = merge_content(cur.get("content"), frame["content"])
    if "config" in frame:
        nxt["config"] = merge_config_patch(cur.get("config"), frame["config"])
    for k in ("lock", "pending", "highlight", "appliedEffects", "mode", "title", "display", "order"):
        if k in frame:
            nxt[k] = frame[k]
    return nxt


def _set_canvas(state: dict[str, Any], cid: str, cv: dict[str, Any], rev: Any) -> dict[str, Any]:
    r = rev if rev is not None else state.get("rev")
    canvases = dict(state.get("canvases") or {})
    canvases[cid] = {**cv, "rev": r}
    return {**state, "rev": r, "canvases": canvases}


def apply_delta(state: dict[str, Any], frame: dict[str, Any]) -> dict[str, Any]:
    """Apply a hub broadcast/frame to the render replica `{rev, canvases, messages}`."""
    t = frame.get("type") if frame else None
    if t == "SNAPSHOT":
        return {
            "rev": frame.get("rev") or 0,
            "canvases": dict(frame.get("canvases") or {}),
            "messages": list(frame.get("messages") or []),
        }
    if t == "CREATE_CANVAS":
        return _set_canvas(state, frame["canvasId"], _build_canvas(frame), frame.get("rev"))
    if t == "UPDATE_CANVAS":
        cur = (state.get("canvases") or {}).get(frame["canvasId"])
        if cur is None:
            return state
        return _set_canvas(state, frame["canvasId"], _merge_canvas(cur, frame), frame.get("rev"))
    if t == "CLOSE_CANVAS":
        cur = (state.get("canvases") or {}).get(frame["canvasId"])
        if cur is None:
            return state
        return _set_canvas(state, frame["canvasId"], {**cur, "closed": True}, frame.get("rev"))
    if t == "CANCEL_PENDING":
        cur = (state.get("canvases") or {}).get(frame["canvasId"])
        if cur is None:
            return state
        return _set_canvas(state, frame["canvasId"], {**cur, "pending": frame.get("pending") or {}}, frame.get("rev"))
    if t == "CANVAS_EVENT":
        cur = (state.get("canvases") or {}).get(frame["canvasId"])
        if cur is None:
            return state
        # A CANVAS_EVENT carries a server-maintained map only when the binding wrote
        # one: pending (consequence), appliedEffects (agent local-effect), highlight
        # (coordination). A pure attention / client-local event carries none -> no-op.
        cv = cur
        if "pending" in frame:
            cv = {**cv, "pending": frame["pending"]}
        if "appliedEffects" in frame:
            cv = {**cv, "appliedEffects": frame["appliedEffects"]}
        if "highlight" in frame:
            cv = {**cv, "highlight": frame["highlight"]}
        # A user's presentation op rides the event as a config.presentation patch; the
        # replica keyed-merges it (only presentation — never actions/controls).
        cfg = frame.get("config")
        if isinstance(cfg, dict) and cfg.get("presentation") is not None:
            cv = {
                **cv,
                "config": merge_config_patch(cv.get("config"), {"presentation": cfg["presentation"]}),
            }
        if cv is cur:
            return state
        return _set_canvas(state, frame["canvasId"], cv, frame.get("rev"))
    if t in ("CANVAS_MESSAGE", "USER_MESSAGE"):
        return {**state, "messages": [*(state.get("messages") or []), frame]}
    return state
