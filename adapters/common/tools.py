"""Neutral tool surface.

A `Tool` is a framework-agnostic capability — `{name, description, schema, run}`.
Tools belong to *agents*, not to adapters: the canvas tools are built here (bound
to a bridge), custom tools are written wherever and attached to an agent in its
definition, and each adapter merely *translates* an agent's tools into its SDK's
format and runs them. Adapters own no tools.
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from adapters.common.bridge import ToolError


@dataclass
class Tool:
    name: str
    description: str
    schema: dict  # JSON Schema for the tool's args
    run: Callable[[dict], Awaitable[str]]  # async (args) -> result text; raises on failure


# Custom-tool registry: name -> factory(bridge) -> Tool. A roster references a
# custom tool by name; `@tool` registers its factory so the name resolves. Canvas
# tools are NOT here — every agent gets all of them; this is only the extras.
TOOL_REGISTRY: dict[str, Callable] = {}


# Field names rendered as OPTIONAL (trailing ?) in the content-shape crib.
_OPTIONAL_FIELDS = {"ref", "refType", "label", "caption", "zoom", "center", "src", "find"}
# `id` is redundant with the map key, so the crib omits it. `_id` is NOT: TableView reads `row._id`
# directly (orderedRows / byRowId / block selection), so a row must carry it and it must equal the key.
_DERIVED_ID_FIELD = "id"
# Content that lives in the real element maps but has no catalogue `content` entry: a row's cells
# (one per column id) and the text view's top-level line order. Rendered so the crib matches the
# content the reducer actually holds — the shape line is what an agent authors from.
_CONTENT_EXTRA_FIELD = {"rows": '"<columnId>": <cell>'}
_CONTENT_EXTRA_COLL = {"text": 'lineOrder ["<lineId>", …]'}


def _cat_file() -> dict:
    """The whole abra-views catalogue — the SINGLE source every accessor below reads, so the
    agent crib never drifts from what the reducer accepts. Empty dict if unreadable."""
    try:
        from pathlib import Path

        root = Path(__file__).resolve().parents[2]
        return json.loads(
            (root / "packages/abra-views/src/views/shared/manifests/catalogue.json").read_text()
        )
    except Exception:
        return {}


def _control_cat() -> dict:
    """The catalogue's `control` block: {common: {id,label,fires?,writes?,value?}, types: {...}} —
    the widget contract. `type` is not in `common` (it names the `types` key), but the wire schema
    requires it, so every renderer below emits it explicitly."""
    return _cat_file().get("control") or {}


def _catalogue() -> dict:
    """The catalogue's `canvas_components` map — per-view content / actions / presentation.
    Empty dict if unreadable (the crib degrades to actions-only / nothing)."""
    try:
        return _cat_file()["view"]["canvas_components"]
    except Exception:
        return {}


# Optional per-view flavor for the create_canvas one-liner; a view not listed here falls back
# to its content-collection keys, so a NEW view still appears in the crib with zero edits here.
_VIEW_SUMMARY = {"display": "read-only media: images / gallery / PDF / map"}


def _view_line(v: str, comp: dict) -> str:
    """One catalogue-driven `<view> (<summary or content keys>)` entry for the create one-liner."""
    summary = _VIEW_SUMMARY.get(v)
    if summary:
        return f"{v} ({summary})"
    colls = "+".join((comp.get("content") or {}).keys())
    return f"{v} ({colls})" if colls else v


# FALLBACK element-address grammar (the wire path grammar: `<element>/<id>`, cells `cell/<rowId>/<colId>`) → the path
# template to fill fire_action(path=…) for a single-element action. Used ONLY until the catalogue's
# per-element descriptors carry `path` themselves (catalogue `elements` entries are {} today — that
# is their natural home; adding `path` there makes this fully catalogue-driven and lets
# this table be deleted). Compound targets ('(NODE, NODE)' uses value; 'NODE | EDGE' is ambiguous)
# and components (chrome/controller) have no single path, so they are omitted.
_ELEMENT_PATH = {
    "NODE": "node/<id>", "EDGE": "edge/<id>",
    "ROW": "row/<id>", "COLUMN": "col/<id>", "CELL": "cell/<rowId>/<colId>",
    "LINE": "line/<id>", "PARAGRAPH": "paragraph/<id>", "ITEM": "item/<id>",
}


def _action_facts(view: str, action_id: str) -> dict:
    """Catalogue STRUCTURAL facts for an action — the fire_action contract that the agent's
    binding (meaning/label) doesn't carry: `value` (the payload SHAPE to send), `consequence`
    (firing arms a pending the OWNER resolves — no immediate content change), `element` (target
    arity), and `path` (the address template to fill fire_action(path=…), e.g. cell/<rowId>/<colId>).
    Lets a participant fire correctly on a canvas it didn't create."""
    meta = (_catalogue().get(view) or {}).get("actions", {}).get(action_id) or {}
    facts: dict = {}
    if "value" in meta:
        facts["value"] = meta["value"]
    if meta.get("consequence"):
        facts["consequence"] = True
    if "element" in meta:
        el = meta["element"]
        facts["element"] = el
        # path template: prefer the catalogue's own element descriptor (single source) if it carries
        # one; else the _ELEMENT_PATH fallback. Catalogue `elements` entries are {} today, so this
        # falls back for now — no drift once the catalogue gains `path`.
        elems = (_catalogue().get(view) or {}).get("elements") or {}
        path = (elems.get(el) or {}).get("path") or _ELEMENT_PATH.get(el)
        if path:  # single addressable element → the path grammar for fire_action(path=…)
            facts["path"] = path
    return facts


def _content_shape(view: str, comp: dict) -> str:
    """Render a view's content shape from catalogue `.content`. Every collection is an ID-KEYED MAP —
    `nodes {"<id>": {label?}}`, not a list of `{id, label}` — so the crib is written that way; an
    earlier `nodes{id, label?}` form read as an array and agents authored one."""
    out = []
    for coll, fields in (comp.get("content") or {}).items():
        names = [f"{k}?" if k in _OPTIONAL_FIELDS else k
                 for k in fields if k != _DERIVED_ID_FIELD]
        if coll in _CONTENT_EXTRA_FIELD:
            names.append(_CONTENT_EXTRA_FIELD[coll])
        out.append(f'{coll} {{"<{coll[:-1] if coll.endswith("s") else coll}Id>": {{{", ".join(names)}}}}}')
    if view in _CONTENT_EXTRA_COLL:
        out.append(_CONTENT_EXTRA_COLL[view])
    return " · ".join(out)


def _presentation_shape(comp: dict) -> str:
    """Render the settable config.presentation keys from catalogue `.presentation`, each with
    its DOMAIN (valid values / value shape, from `.description`) so a `writes` control's
    `options` can be filled correctly — the domain is view-owned, not for the agent to guess."""
    out = []
    for key, meta in (comp.get("presentation") or {}).items():
        d = meta.get("default")
        base = f"{key}={d}" if d not in (None, "") else key
        dom = meta.get("description")  # valid values / value shape = the domain
        sb = meta.get("set_by")  # how it's set: writes:<key> (control) | gesture:<action> (direct manip)
        parts = [base]
        if dom:
            parts.append(f"({dom})")
        if sb:
            parts.append(f"[{sb}]")
        out.append(" ".join(parts))
    return ", ".join(out)


def _action_ids(comp: dict) -> str:
    """A FLAT, comma-separated list of an action id per entry, with the part it fires on in
    parentheses and `*` marking a consequence: `edit_node*(NODE), add_edge*(NODE,NODE), pan(chrome)`.

    Deliberately NOT grouped `NODE: a, b; EDGE: c` — `config.actions` is a flat id-keyed map, and a
    grouped crib reads as a nested one: agents copied the group headers (`NODE`, `(NODE, NODE)` →
    `node_node`, `controller`, `surface`) straight into `config.actions` as keys."""
    elements, components = comp.get("elements") or {}, comp.get("components") or {}

    def part(el) -> str:
        if isinstance(el, list):  # relating tuple
            return ", ".join(el)
        s = str(el).strip()
        if s.startswith("(") and s.endswith(")"):  # catalogue writes tuples as "(NODE, NODE)"
            return s[1:-1]
        if el in elements or s == "ELEMENT" or "|" in s:
            return s
        return (components.get(el) or {}).get("kind") or s

    return ", ".join(
        f"{an}{'*' if a.get('consequence') else ''}({part(a.get('element'))})"
        for an, a in (comp.get("actions") or {}).items()
    )


def _controls_shape() -> str:
    """The `config.controls` widget contract, rendered from catalogue `control` (common keys + the
    per-type extras). Prose used to hand-copy this and agents kept omitting the required `type`."""
    cat = _control_cat()
    common, types = cat.get("common") or {}, cat.get("types") or {}
    if not types:
        return ""
    req = ["type"] + [k for k, v in common.items() if not v.get("optional") ]
    opt = [k for k, v in common.items() if v.get("optional") and k not in ("fires", "writes")]
    kinds = ", ".join(
        f"{t}({', '.join(extra)})" if extra else t for t, extra in types.items()
    )
    return (
        f"a LIST of widget objects, each {{{', '.join(req)}}}"
        + (f" plus optional {{{', '.join(opt)}}}" if opt else "")
        + "; exactly ONE of fires:'<action id>' (a published config.actions key) or "
        f"writes:'<presentation key>'. type is one of: {kinds}"
    )


# Shared authoring guidance, returned once inside every view manifest so read_canvas(view=…)
# is self-sufficient (an agent can author from the manifest alone).
_AUTHORING_GUIDE = (
    "config.actions is a FLAT map: key = one lowercase action id from `actions`, value = "
    '{meaning, label?, default?}. e.g. {"select_node": {"meaning": "pin a suspect"}}. Do NOT nest by '
    'element ({"NODE": {…}} is invalid) and never put the word "local_effect" in a meaning — a '
    "`meaning` says what the gesture accomplishes for the task, not the action's name ('select'). "
    "Publish BOTH members of a hover/select pair (highlight_+dehighlight_, select_+deselect_). "
    "Share the same `ref` on elements that mean the same task object across views to link them for "
    "cross-view highlighting (bind the hover pair; select_ does not fan out). config.controls = a "
    "header toolbar of agent-composed widgets (see `controls`); a control's writes: is the only way "
    "to drive presentation (dotted sub-key for compound values like sort.colId), and "
    "config.actions[a].default:false hides the built-in affordance so only your control drives it. "
    "In `actions`, `id*` arms a CONSEQUENCE (the user's gesture becomes a pending you resolve with "
    "update_canvas(resolves=…)); an unmarked id is a local_effect (an overlay, no turn for you) — "
    "which is which is fixed per action, you choose WHICH to bind. The part in parentheses is where "
    "the gesture lands: an ALL-CAPS ELEMENT is a ref-bearing data point; chrome = fixed furniture, "
    "controller = a config.controls widget. Every content collection is an ID-KEYED MAP "
    '({"<id>": {…}}), never an array and never a JSON string.'
)


def _view_manifest(view: str) -> dict:
    """On-demand authoring manifest for a view TYPE (read_canvas(view=…)): content shape, settable
    presentation, the flat action-id list (with `*` consequence markers) and the controls contract,
    all generated from the catalogue. Catalogue-only (no canvas/replica) — this is the per-view
    detail that used to ride the create_canvas description, fetched when an agent actually authors."""
    comps = _catalogue()
    comp = comps.get(view)
    if not comp:
        return {"error": f"unknown view {view!r}", "views": list(comps) or _VIEW_NAMES}
    return {
        "view": view,
        "content": _content_shape(view, comp) or "—",
        "presentation": _presentation_shape(comp) or "—",
        "actions": _action_ids(comp),
        "controls": _controls_shape() or "—",
        "guide": _AUTHORING_GUIDE,
    }


_VIEW_NAMES = list(_catalogue()) or ["graph", "table", "text", "display"]
_VIEW_LIST = ", ".join(_view_line(v, c) for v, c in _catalogue().items()) or ", ".join(_VIEW_NAMES)

# Per-view bindable action ids AND settable presentation domains, catalogue-driven, inlined into the
# create_canvas description so an agent authors a CONTRACT-VALID canvas at create WITHOUT a separate
# read_canvas(view=…) round-trip (which is easy to skip before any canvas exists). This detail used to
# ride this description; 52d8dfe moved it behind read_canvas — restored here so authoring is
# self-sufficient at create. read_canvas(view=…) still gives the fuller manifest (content shape + prose).
_CREATE_VOCAB = (
    "\n\nUse ONLY these catalogue ids/values.\n"
    "  content — every collection is an ID-KEYED MAP, never an array and never a JSON string:\n"
    '      {"nodes": {"odin": {"label": "Odin"}}, "edges": {"e1": {"source": "odin", "target": "thor"}}}\n'
    '      A table row repeats its key as `_id` and holds one entry per column id: '
    '{"rows": {"r1": {"_id": "r1", "name": "Odin"}}}\n'
    "  config.actions — a FLAT map whose KEYS are action ids from the per-view list below and whose "
    "values are {meaning, label?, default?} and nothing else:\n"
    '      {"select_node": {"meaning": "pin a god to trace their kin"}, '
    '"add_edge": {"meaning": "record a kinship I missed"}}\n'
    "      NOT nested by element — {\"NODE\": {\"select_node\": …}} is invalid. A `meaning` is your own "
    'task sentence; never the literal word "local_effect".\n'
    "      In the list below, `id*` arms a CONSEQUENCE you resolve; an unmarked id is a local_effect. "
    "The part in parentheses is where the gesture lands, not a key.\n"
    "      Publish BOTH halves of any hover/select pair you use (highlight_X + dehighlight_X, "
    "select_X + deselect_X) or neither.\n"
    f"  config.controls — {_controls_shape()}\n"
    "  config.presentation — values must match the per-view domains below.\n"
    "By view:\n"
) + "\n".join(
    f"  {v}:\n    content: {_content_shape(v, c) or '—'}\n"
    f"    actions: {_action_ids(c)}\n    presentation: {_presentation_shape(c) or '—'}"
    for v, c in _catalogue().items()
)


# JSON Schema for one config.controls widget, generated from catalogue `control` so the tool's
# machine-readable schema carries the same contract the prose does (agents kept omitting the required
# `type`, which only ever appeared in prose while `config` was declared as a bare {"type":"object"}).
def _control_item_schema() -> dict:
    cat = _control_cat()
    common, types = cat.get("common") or {}, cat.get("types") or {}
    if not types:
        return {"type": "object"}
    jtype = {"string": "string", "number": "number", "boolean": "boolean"}
    props: dict = {"type": {"type": "string", "enum": list(types)}}
    for k, meta in common.items():
        t = str(meta.get("type", "string"))
        props[k] = {} if t == "any" else {"type": jtype.get(t, "string")}
    for extra in types.values():  # per-type extras: select.options, slider.min/max/step
        for k, meta in extra.items():
            t = str(meta.get("type", "string"))
            props.setdefault(k, {"type": "array"} if t.startswith("array") else {"type": jtype.get(t, "string")})
    required = ["type"] + [k for k, m in common.items() if not m.get("optional")]
    return {"type": "object", "properties": props, "required": required}


_CONTROL_ITEM = _control_item_schema()
# ActionBinding is strict on the wire: {meaning (required), label?, default?} and nothing else.
_BINDING_ITEM = {
    "type": "object",
    "properties": {"meaning": {"type": "string", "minLength": 1},
                   "label": {"type": "string"}, "default": {"type": "boolean"}},
    "required": ["meaning"],
    "additionalProperties": False,
}
_CONFIG_SCHEMA = {
    "type": "object",
    "properties": {
        "actions": {"type": "object", "additionalProperties": _BINDING_ITEM},
        "presentation": {"type": "object"},
        "controls": {"type": "array", "items": _CONTROL_ITEM},
    },
    "additionalProperties": False,
}


def tool(fn):
    """Register a custom-tool factory under its function name. The factory takes
    the bridge and returns a `Tool`; reference it from a roster by that name.

        @tool
        def web_search(bridge):
            return Tool("web_search", "Search the web.", {...}, _run)
    """
    TOOL_REGISTRY[fn.__name__] = fn
    return fn


async def run_tool(tool: Tool, args: dict | None) -> tuple[str, bool]:
    """Execute a tool, returning (result_text, is_error)."""
    try:
        return await tool.run(args or {}), False
    except ToolError as e:
        # code = coarse branch (closed ERROR set); reason = machine sub-tag (value.shape / …);
        # message = the specific complaint, so the model can self-correct not re-guess.
        tag = f" [{e.reason}]" if e.reason else ""
        head = f"rejected: {e.code}{tag}"
        return (f"{head} — {e.message}" if e.message else head), True
    except Exception as e:  # malformed args, etc. — fed back so the model self-corrects
        return f"error: {e}", True


def _applied(payload, **extra) -> str:
    """Summarize a write's APPLIED reply for the agent: the server round-trips every write
    (a tool awaits its own reqId → applied / rejected:<code>), so every tool now returns a
    JSON status the model can act on — `rev` (the new session revision) and `pendingId`
    (present iff a consequence was armed → resolve it with update_canvas(resolves=…)). A
    rejected write surfaces as `rejected: <code>` (a closed error set) via run_tool."""
    out = {"status": "applied"}
    if isinstance(payload, dict):
        if payload.get("rev") is not None:
            out["rev"] = payload["rev"]
        if payload.get("pendingId"):
            out["pendingId"] = payload["pendingId"]
    out.update({k: v for k, v in extra.items() if v is not None})
    return json.dumps(out)


def canvas_tools(bridge) -> dict[str, Tool]:
    """The 5 ABRA canvas tools, bound to a bridge (closures; the bridge isn't touched here)."""

    def _obj(a: dict, key: str):
        """Normalize a structured argument that arrived DOUBLE-ENCODED as a JSON string.

        This is a provider artifact, not a modelling error: an OpenAI tool call ships one JSON
        `arguments` blob that we json.loads whole, so nested objects always arrive parsed, while
        Anthropic hands back `tool_use.input` already-decoded and a model may quote a nested value
        into a string. Rejecting only one provider for that is an unfair asymmetry. A string that
        does NOT parse is left alone — malformed JSON is a real error and still rejects."""
        v = a.get(key)
        if not isinstance(v, str):
            return v
        try:
            parsed = json.loads(v)
        except ValueError:
            return v
        if not isinstance(parsed, dict | list):
            return v
        if not hasattr(bridge, "coerced_args"):
            bridge.coerced_args = []
        bridge.coerced_args.append(key)
        return parsed

    def _config(a: dict) -> dict:
        config = dict(_obj(a, "config") or {})
        if "presentation" in a:
            config["presentation"] = _obj(a, "presentation")
        if "controls" in a:
            config["controls"] = _obj(a, "controls")
        return config

    async def create(a):
        # The binding lives at CREATE: config (actions + presentation + controls).
        config = _config(a)
        opts = {k: a[k] for k in ("title",) if k in a}
        if config:
            opts["config"] = config
        cid = await bridge.create_canvas(a["view"], _obj(a, "content") or {}, **opts)
        return json.dumps({"status": "applied", "canvasId": cid})

    async def update(a):
        fields = {k: a[k] for k in ("title", "resolves") if k in a}
        if "content" in a:
            fields["content"] = _obj(a, "content")
        config_patch = _config(a)
        if config_patch:
            fields["config"] = config_patch
        return _applied(await bridge.update_canvas(a["canvas_id"], **fields))

    def _enrich_actions(view, actions):
        # each published action + its catalogue contract (value shape / consequence / element),
        # so a participant can build a correct fire_action(value=…). Bridge stays
        # catalogue-agnostic; the view-manifest knowledge lives here in the tool surface.
        return {aid: {**(b or {}), **_action_facts(view, aid)} for aid, b in actions.items()}

    async def read(a):
        if a.get("view") and not a.get("canvas_id"):
            # view-TYPE authoring manifest — catalogue-only, no canvas/replica needed.
            return json.dumps(_view_manifest(a["view"]))
        result = bridge.read_canvas(a.get("canvas_id"), a.get("scope", "index"))
        if isinstance(result, dict):
            view = result.get("view")
            if isinstance(result.get("actions"), dict):
                # interface scope — actions at top level (the interaction CONTRACT, no content)
                result = {**result, "actions": _enrich_actions(view, result["actions"])}
            elif isinstance((result.get("config") or {}).get("actions"), dict):
                # full scope — enriched contract AND content together: this is the one read that
                # gives BOTH each action's value shape AND the real element ids the value must
                # reference (add_edge's node ids, add_line's paragraph id). Read `full` before
                # firing an action whose value names elements.
                cfg = result["config"]
                result = {**result, "config": {**cfg, "actions": _enrich_actions(view, cfg["actions"])}}
        return json.dumps(result)

    async def close(a):
        return _applied(await bridge.close_canvas(a["canvas_id"]))

    async def fire(a):
        # `pendingId` in the reply = the fired action armed a consequence — the OWNER
        # resolves it with update_canvas(resolves=<pendingId>). No pendingId = a plain
        # presentation/local_effect action that already took effect.
        payload = await bridge.fire_action(
            a["canvas_id"], a["action"], value=a.get("value"), path=a.get("path")
        )
        return _applied(payload)

    return {
        "create_canvas": Tool(
            "create_canvas",
            "Create a typed canvas over a fixed view set: " + _VIEW_LIST + ". Bind interaction "
            "meaning at create in config.actions; set render params in config.presentation; add "
            "toolbar widgets in config.controls (all three shapes are spelled out below). "
            "config.actions is IMMUTABLE after create — a new action-meaning needs a new canvas. "
            "Whether an action arms a consequence or is a local_effect is fixed per action, not "
            "chosen by you. read_canvas(view='<view>') returns the same manifest plus prose — but "
            "everything you need to author is listed below, so you can author in one call. "
            "Returns the new canvasId." + _CREATE_VOCAB,
            {
                "type": "object",
                "properties": {
                    "view": {"type": "string", "enum": _VIEW_NAMES},
                    "content": {"type": "object"},
                    "config": _CONFIG_SCHEMA,
                    "presentation": {"type": "object"},
                    "controls": {"type": "array", "items": _CONTROL_ITEM},
                    "title": {"type": "string"},
                },
                "required": ["view", "content"],
            },
            create,
        ),
        "update_canvas": Tool(
            "update_canvas",
            "Update a canvas by id with a content patch and/or a config.presentation patch "
            "(both keyed-merged), config.controls (owner-only), and/or a new title. Content is "
            "element-keyed and merges, so author WHOLE structures in ONE call rather than many "
            "serial edits — e.g. add a FILLED table column in a single patch: "
            "content={columns:{cost:{label:'Cost',type:'number'}}, rows:{r1:{cost:10}, r2:{cost:20}}} "
            "(don't add_column then edit_cell per row). You can co-author content on a canvas you "
            "don't own (collaborative, content only). Read_canvas first only for what you don't "
            "already hold: scope='full' for existing element ids (a content edit), scope='interface' "
            "for the published action ids a control's fires: must name; a layout/title change or a "
            "pending resolve needs no read. Returns {status, rev, pendingId?}; resolve a pending you "
            "own with "
            "resolves=<pendingId>.",
            {
                "type": "object",
                "properties": {
                    "canvas_id": {"type": "string"},
                    "content": {"type": "object"},
                    "presentation": {"type": "object"},
                    "title": {"type": "string"},
                    "resolves": {"type": "string"},
                },
                "required": ["canvas_id"],
            },
            update,
        ),
        "read_canvas": Tool(
            "read_canvas",
            "Inspect a canvas, or a view TYPE. view='<graph|table|text|display>' (no canvas_id) "
            "returns that view's AUTHORING manifest — content shape, presentation options, the "
            "controls contract, and every bindable action id with a `*` marking a consequence; call "
            "it before create_canvas. "
            "On a canvas: no canvas_id (or scope 'index') lists every canvas {canvasId, view, title, "
            "owner}; scope 'interface' returns the published interaction contract (each bound action "
            "enriched with consequence/value/element/path, plus controls), no content; scope 'full' returns "
            "contract + content (the real element ids a value must reference). Read on a canvas before "
            "a write that references existing elements or a binding you don't already hold — a "
            "fire_action value, or a content update on a canvas you didn't author; use 'full' when the "
            "value names elements (add_edge's node ids, add_line's paragraph id). A value referencing a "
            "nonexistent id is rejected (VALIDATION).",
            {
                "type": "object",
                "properties": {
                    "canvas_id": {"type": "string"},
                    "scope": {"type": "string", "enum": ["index", "interface", "full"]},
                    "view": {"type": "string", "enum": _VIEW_NAMES},
                },
            },
            read,
        ),
        "close_canvas": Tool(
            "close_canvas",
            "Close a canvas you own. The UI shows every LIVE canvas you've opened (there is "
            "no hide toggle), so when you move to a new/unrelated task, CLOSE the canvases "
            "from the previous one — otherwise they stay on screen and clutter the workspace.",
            {"type": "object", "properties": {"canvas_id": {"type": "string"}}, "required": ["canvas_id"]},
            close,
        ),
        "fire_action": Tool(
            "fire_action",
            "Invoke a published action binding (the cross-agent act) — normally another agent's. "
            "On a canvas you do NOT own, this is the route: a direct content write there is rejected "
            "NOT_OWNER unless the canvas is collaborative and you hold the lock. fire_action has no "
            "ownership/lock/mode gate (it only needs the action to be published) — the trade is that a "
            "consequence hands the edit to the owner to resolve; a local_effect applies at once. "
            "Unless you already hold the binding, read_canvas(canvas_id=…, scope='interface') to see "
            "which actions are published and each one's `value` shape, element, and `path` template "
            "(e.g. cell/<rowId>/<colId>); use "
            "scope='full' when the value must reference real element ids (e.g. add_edge's node "
            "ids). Returns {status, rev, pendingId?} — a pendingId means it armed a consequence "
            "the owner will resolve; none means a local_effect that already took effect.",
            {
                "type": "object",
                "properties": {
                    "canvas_id": {"type": "string"},
                    "action": {"type": "string"},
                    "value": {"type": "object"},
                    "path": {"type": "string"},
                },
                "required": ["canvas_id", "action"],
            },
            fire,
        ),
    }


def resolve_tools(bridge, extra: list | None = None) -> dict[str, Tool]:
    """Every agent gets ALL canvas tools (the substrate-binding surface) — `extra`
    only adds the agent's CUSTOM tools on top. Items in `extra` may be attached
    `Tool` objects or registered custom-tool *names* (resolved via TOOL_REGISTRY).
    A canvas-tool name is harmlessly ignored (already present). Framework built-in
    names are NOT resolved here — the adapter strips those first. Unknown custom
    names raise."""
    out: dict[str, Tool] = dict(canvas_tools(bridge))  # all five, always
    for it in extra or []:
        if isinstance(it, Tool):
            out[it.name] = it
        elif isinstance(it, str):
            if it in out:  # a canvas-tool name — already present
                continue
            factory = TOOL_REGISTRY.get(it)
            if factory is None:
                raise ValueError(f"unknown custom tool: {it!r}")
            t = factory(bridge)
            out[t.name] = t
        else:
            raise ValueError(f"not a tool: {it!r}")
    return out
