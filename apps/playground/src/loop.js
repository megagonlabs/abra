// @ts-check
/**
 * The in-process reduce loop — the playground IS the hub. A view emits an intent
 * → it's stamped into a wire message → `reduce` (the authoritative step) → each
 * broadcast is applied to the render replica via `applyDelta` → the UI re-renders.
 * The same reduce + applyDelta the real hub/client run, wired in one process.
 *
 * Two pieces of shell wiring the original standalone playground did inline, here against
 * the real contract:
 *  - the LINK-INDEX: coordination highlights are keyed by
 *    `ref`, so the union of every canvas's highlight overlay, applied to each
 *    canvas, makes brushing in one view light up the matching element in another;
 *  - the consequence loop: a gesture's consequence mints a REAL server pending;
 *    a simulated owner agent resolves it shortly after (the original faked this with a
 *    setTimeout that cleared a flag) — so the pending overlay appears and clears,
 *    and the resolution actually patches content.
 */
import {
  applyDelta,
  initialState,
  isConsequenceAction,
  linkIndex,
  mergeContent,
  reduce,
} from 'abra-reducer';
import { SEED_OWNER } from './scenarios.js';

const RESOLVE_DELAY_MS = 2200;

/**
 * Actions that STAGE into a per-canvas draft instead of emitting immediately (flushed
 * by a Commit button). **Currently empty** — consequences emit every time (each edit is
 * logged + round-trips), no commit batching. The draft machinery below is kept dormant
 * so batching can be re-enabled by listing actions here.
 */
const CONTENT_EDIT_ACTIONS = new Set();

/**
 * Like the reducer's content merge, but for **accumulating a delta**: a `null` element
 * is *kept* (a recorded delete) rather than applied — so a batched commit still carries
 * deletes even when the deleted id was never in the accumulator. (Plain `mergeContent`
 * would drop the null and lose the delete.)
 */
function mergeDelta(/** @type {any} */ acc, /** @type {any} */ d) {
  /** @type {Record<string, any>} */
  const out = { ...acc };
  for (const [key, val] of Object.entries(d ?? {})) {
    if (Array.isArray(val) || val === null || typeof val !== 'object') {
      out[key] = val;
    } else {
      const cur = { ...(out[key] ?? {}) };
      for (const [id, elem] of Object.entries(val)) {
        cur[id] =
          elem !== null && typeof elem === 'object' && !Array.isArray(elem)
            ? { ...(cur[id] ?? {}), ...elem }
            : elem; // keeps null (preserved delete) + scalars
      }
      out[key] = cur;
    }
  }
  return out;
}

export function createLoop(/** @type {any[]} */ seedMsgs = []) {
  let authoritative = initialState();
  /** @type {Record<string, any>} */
  let replica = { rev: 0, canvases: {}, messages: [] };
  /** @type {Record<string, any[]>} per-canvas ordered staged content ops (the draft). */
  const drafts = {};
  let draftN = 0;
  /** @type {Record<string, any[]>} */
  let events = { localEffect: [], consequence: [], control: [] };
  let snapshot = build();
  let seq = 0;
  let mintN = 0;
  let evN = 0;
  const listeners = new Set();
  const timers = new Set();
  const autoResolved = new Set();

  const ctx = () => ({ now: Date.now(), mintId: () => `m${++mintN}` });

  function build() {
    // The coordination link-index (SHARED `linkIndex` from abra-reducer/apply — same
    // logic the hub client uses, so coordination is identical across shells): each canvas
    // renders the highlights that originated on OTHER canvases, so brushing one view
    // lights the matching element in another while the originating element shows only its
    // own local highlight (never the coordination pulse).
    const all = replica.canvases;
    const merged = linkIndex(all);
    /** @type {Record<string, any>} */
    const canvases = {};
    for (const [id, c] of Object.entries(all)) {
      const delta = draftDelta(c);
      canvases[id] = {
        ...c,
        highlight: merged[id],
        // optimistic: render content + the un-committed draft so edits show locally.
        content: delta ? mergeContent(c.content, delta) : c.content,
      };
    }
    const rendered = { ...replica, canvases };
    /** @type {Record<string, number>} */
    const draftCounts = {};
    for (const [k, v] of Object.entries(drafts)) if (v.length) draftCounts[k] = v.length;
    return {
      replica: rendered,
      events,
      pending: openPending(replica.canvases),
      rev: replica.rev,
      drafts: draftCounts,
    };
  }

  /** Fold a canvas's staged ops into ONE content delta (each op sees the prior result). */
  function draftDelta(/** @type {any} */ canvas) {
    const ops = drafts[canvas.canvasId];
    if (!ops?.length) return null;
    let content = canvas.content;
    /** @type {Record<string, any>} */
    let delta = {};
    for (const op of ops) {
      const d = resolution({ ...canvas, content }, op);
      if (d) {
        delta = mergeDelta(delta, d); // accumulate (preserve deletes)
        content = mergeContent(content, d); // evolve (apply deletes)
      }
    }
    return delta;
  }
  const bump = () => {
    snapshot = build();
    for (const l of listeners) l();
  };

  /** Apply one wire message through the authoritative reducer + into the replica. */
  function dispatch(/** @type {any} */ msg) {
    const { state, effects } = reduce(authoritative, { seq: seq++, ...msg }, ctx());
    authoritative = state;
    for (const e of effects) {
      if (e.kind === 'broadcast') replica = applyDelta(replica, e.frame);
      else if (e.kind === 'schedule') scheduleLease(e.lease);
      // toCaller (ERROR) is swallowed here; the panel only shows emitted gestures.
    }
    scheduleAutoResolves();
    bump();
  }

  /** A user gesture / patch from a view: classify it, log it, dispatch it. */
  function emit(
    /** @type {string} */ source,
    /** @type {string} */ canvasId,
    /** @type {any} */ intent,
  ) {
    const canvas = replica.canvases[canvasId];
    // Content edits STAGE into the draft (committed as a batch via commit()); the view
    // re-renders with the optimistic overlay. Presentation/coordination pass through.
    if (canvas && intent.action && CONTENT_EDIT_ACTIONS.has(intent.action)) {
      if (!drafts[canvasId]) drafts[canvasId] = [];
      drafts[canvasId].push({
        pendingId: `op${++draftN}`,
        action: intent.action,
        path: intent.path,
        value: intent.value,
      });
      bump();
      return;
    }
    if (intent.action || intent.control) {
      // Consequence-ness is structural (the view manifest), not an agent field.
      const bucket = intent.control
        ? 'control'
        : isConsequenceAction(canvas?.view, intent.action)
          ? 'consequence'
          : 'localEffect';
      logEvent(bucket, { source, canvasId, ...intent });
      dispatch({
        type: 'CANVAS_EVENT',
        canvasId,
        action: intent.action,
        control: intent.control,
        path: intent.path,
        ref: intent.ref,
        value: intent.value,
        // A USER presentation gesture (collapse/reorder/sort/filter) rides the event as a
        // config.presentation patch — the server applies the op. UPDATE_CANVAS is agent-only.
        config: intent.config,
        source,
        reqId: `r${++mintN}`,
        timestamp: Date.now(),
      });
    }
    if (intent.content !== undefined) {
      // Bench-only optimistic direct-content write (no live agent to resolve a
      // consequence). Not part of the user-facing contract — the demo shell drops it.
      dispatch({
        type: 'UPDATE_CANVAS',
        canvasId,
        content: intent.content,
        source,
        reqId: `r${++mintN}`,
      });
    }
  }

  function logEvent(/** @type {string} */ bucket, /** @type {any} */ e) {
    const row = { id: ++evN, ts: timeLabel(), ...e };
    events = { ...events, [bucket]: [row, ...events[bucket]].slice(0, 50) };
  }

  /** Schedule a simulated owner resolve for each newly-opened pending. */
  function scheduleAutoResolves() {
    for (const c of Object.values(replica.canvases)) {
      for (const p of Object.values(c.pending ?? {})) {
        if (autoResolved.has(p.pendingId)) continue;
        autoResolved.add(p.pendingId);
        const t = setTimeout(() => {
          timers.delete(t);
          const cur = replica.canvases[c.canvasId];
          if (!cur?.pending?.[p.pendingId]) return; // already gone
          dispatch({
            type: 'UPDATE_CANVAS',
            canvasId: c.canvasId,
            resolves: p.pendingId,
            // resolve against CURRENT content (not the stale schedule-time canvas), as
            // a real agent would — so e.g. delete_column's row-clear can't resurrect a
            // row another resolve already deleted.
            content: resolution(cur, p),
            source: SEED_OWNER,
            reqId: `resolve-${p.pendingId}`,
          });
        }, RESOLVE_DELAY_MS);
        timers.add(t);
      }
    }
  }

  function scheduleLease(/** @type {any} */ lease) {
    const t = setTimeout(
      () => {
        timers.delete(t);
        dispatch({
          type: 'LEASE_EXPIRED',
          kind: lease.kind,
          canvasId: lease.canvasId,
          pendingId: lease.pendingId,
          scheduledExpires: lease.expires,
          source: 'system',
        });
      },
      Math.max(0, lease.expires - Date.now()),
    );
    timers.add(t);
  }

  /** Flush a canvas's draft: the owner applies the ordered ops as ONE batched write. */
  function commit(/** @type {string} */ canvasId) {
    const canvas = replica.canvases[canvasId];
    if (!canvas || !drafts[canvasId]?.length) return;
    const delta = draftDelta(canvas); // fold the ordered ops into one content delta
    delete drafts[canvasId];
    if (delta) {
      dispatch({
        type: 'UPDATE_CANVAS',
        canvasId,
        content: delta,
        source: SEED_OWNER, // the owner commits the human's staged edits (content gate)
        reqId: `commit-${++mintN}`,
      });
    } else {
      bump();
    }
  }

  // seed synchronously (CREATE_CANVAS from the agent) — not shown in the panel.
  for (const m of seedMsgs) dispatch(m);
  events = { localEffect: [], consequence: [], control: [] };
  snapshot = build();

  return {
    emit,
    commit,
    clearEvents: () => {
      events = { localEffect: [], consequence: [], control: [] };
      bump();
    },
    subscribe: (/** @type {() => void} */ l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getSnapshot: () => snapshot,
    teardown: () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
  };
}

/**
 * The content patch a simulated owner returns to satisfy a consequence — it stands
 * in for a real agent. It reads the pending's `action` / `path` / `value` and writes
 * the corresponding content: the DATA edit (edit / delete / add) the human cannot do
 * directly (content is owner-gated). Returns undefined to decline (content-less
 * resolve) for consequences this stub doesn't simulate.
 */
function resolution(/** @type {any} */ canvas, /** @type {any} */ p) {
  const seg = typeof p.path === 'string' ? p.path.split('/') : [];
  switch (p.action) {
    // --- table -------------------------------------------------------------
    case 'edit_cell': {
      const [, rowId, colId] = seg; // cell/<rowId>/<colId>
      return rowId && colId ? { rows: { [rowId]: { [colId]: p.value?.value } } } : undefined;
    }
    case 'edit_column': {
      const [, colId] = seg; // col/<colId> — rename the column (label only; structure kept)
      return colId ? { columns: { [colId]: { label: p.value?.label } } } : undefined;
    }
    case 'clear': {
      // blank the addressed cells' VALUES (structure kept). The view resolved the exact
      // cell list (respecting sort/filter order) into value.cells = [[rowId, colId], …].
      const cells = Array.isArray(p.value?.cells) ? p.value.cells : [];
      /** @type {Record<string, Record<string, string>>} */
      const rows = {};
      for (const [r, c] of cells) {
        if (!r || !c) continue;
        if (!rows[r]) rows[r] = {};
        rows[r][c] = '';
      }
      return Object.keys(rows).length ? { rows } : undefined;
    }
    case 'add_row': {
      const id = `r-${p.pendingId}`;
      // give the new row an id + an EMPTY value for every existing column, so all of
      // its cells render and are immediately editable/draggable (not undefined holes).
      const cols = Object.keys(canvas.content?.columns ?? {});
      const empty = Object.fromEntries(cols.map((c) => [c, '']));
      return { rows: { [id]: { _id: id, ...empty, ...(p.value ?? {}) } } };
    }
    case 'add_column': {
      const id = `c-${p.pendingId}`;
      // add the column AND seed each existing row's cell. If the agent passed
      // `value.values` ({ rowId: cellValue }) a SINGLE add_column fills the whole column
      // in one op — no serial edit_cell per row; otherwise seed '' so the cells exist
      // (editable) instead of being undefined holes.
      const seed = p.value?.values ?? {};
      const rowPatch = Object.fromEntries(
        Object.keys(canvas.content?.rows ?? {}).map((rid) => [rid, { [id]: seed[rid] ?? '' }]),
      );
      return {
        columns: {
          [id]: { label: p.value?.label ?? 'New column', type: p.value?.type ?? 'string' },
        },
        rows: rowPatch,
      };
    }
    // --- structural delete (any view) — path says which element -------------
    case 'delete': {
      const [kind, id] = seg;
      if (!id) return undefined;
      if (kind === 'row') return { rows: { [id]: null } };
      if (kind === 'col') {
        const cleared = Object.fromEntries(
          Object.keys(canvas.content?.rows ?? {}).map((rid) => [rid, { [id]: null }]),
        );
        return { columns: { [id]: null }, rows: cleared };
      }
      if (kind === 'node') {
        // also drop incident edges so content keeps no dangling links
        const edges = canvas.content?.edges ?? {};
        const edgeNulls = Object.fromEntries(
          Object.entries(edges)
            .filter(([, e]) => e?.source === id || e?.target === id)
            .map(([eid]) => [eid, null]),
        );
        return {
          nodes: { [id]: null },
          ...(Object.keys(edgeNulls).length ? { edges: edgeNulls } : {}),
        };
      }
      if (kind === 'edge') return { edges: { [id]: null } };
      if (kind === 'line') return { lines: { [id]: null } };
      return undefined;
    }
    case 'edit_line': {
      const [, lineId] = seg; // line/<lineId>
      return lineId ? { lines: { [lineId]: { text: p.value?.text } } } : undefined;
    }
    case 'add_line': {
      const id = `l-${p.pendingId}`;
      // splice the new line's id right AFTER value.after in the document order, so a line
      // added mid-paragraph lands in the right place (lineOrder is a content position key).
      const existing = canvas.content?.lineOrder ?? Object.keys(canvas.content?.lines ?? {});
      const order = [...existing];
      const idx = p.value?.after ? order.indexOf(p.value.after) : -1;
      if (idx >= 0) order.splice(idx + 1, 0, id);
      else order.push(id);
      return {
        lines: { [id]: { text: p.value?.text ?? '', paragraph: p.value?.paragraph } },
        lineOrder: order,
      };
    }
    // --- graph -------------------------------------------------------------
    case 'edit_node': {
      const [, nodeId] = seg; // node/<nodeId>
      return nodeId ? { nodes: { [nodeId]: { label: p.value?.label } } } : undefined;
    }
    case 'add_edge': {
      const from = p.value?.from;
      const to = p.value?.to;
      const source = typeof from === 'string' && from.startsWith('node/') ? from.slice(5) : null;
      const target = typeof to === 'string' && to.startsWith('node/') ? to.slice(5) : null;
      if (!source || !target || source === target) return undefined;
      return { edges: { [`e-${p.pendingId}`]: { source, target, num_papers: 1 } } };
    }
    default:
      return undefined; // decline (add_node — not simulated)
  }
}

/** Whether any pending is open + a label for the overlay. */
function openPending(/** @type {Record<string, any>} */ canvases) {
  for (const c of Object.values(canvases)) {
    for (const p of Object.values(c.pending ?? {})) {
      const name = p.action ?? 'consequence';
      return { open: true, label: `Waiting for ${name}` };
    }
  }
  return { open: false, label: '' };
}

let clock = 0;
function timeLabel() {
  // monotonic counter (avoids Date formatting churn); good enough for an ordering hint.
  return `#${++clock}`;
}
