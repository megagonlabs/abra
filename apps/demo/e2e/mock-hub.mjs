// @ts-check
/**
 * Deterministic mock hub for e2e — a byte-stable stand-in for the live LLM cast.
 * It mirrors apps/hub/src/session.js: it seeds state from a scripted SNAPSHOT, and
 * drives the REAL reducer on every inbound participant frame, broadcasting the
 * effects. So the demo client's full path (WS → store → views/chat/shell) runs
 * against authentic reducer semantics with zero nondeterminism.
 *
 *   • JOIN            → replies LIBRARY, PARTICIPANTS, then a SNAPSHOT of current state
 *   • CANVAS_EVENT    → reduce → broadcast (e.g. a hover highlight_* fans out by ref)
 *   • CANVAS_MESSAGE  → reduce → broadcast (echoed back so the sender's bubble appears)
 *   • http GET /      → 200 "ok" (Playwright webServer readiness probe)
 *
 * Run:  PORT=8787 node apps/demo/e2e/mock-hub.mjs
 */
import { createServer } from 'node:http';
import { initialState, reduce } from 'abra-reducer';
import { WebSocketServer } from 'ws';
import { LIBRARY, MALFORMED_SNAPSHOT, PARTICIPANTS, SNAPSHOT } from './fixtures.mjs';

const PORT = Number(process.env.PORT || 8787);

// seed reducer state with the scripted canvases + messages (pre-created, keep their ids).
// deep-clone the fixture so reducer mutations never corrupt it across resets.
let state = initialState();
let idN = 0;
const resolved = new Set(); // pendingIds the stub owner already resolved
const ctx = { now: () => Date.now(), mintId: () => `mock-${++idN}` };

/** Reset to a pristine scenario snapshot — called at boot and per-test (POST /__reset[?scenario=…])
 * so tests don't leak state. `scenario=malformed` serves the broken-spec snapshot. */
function resetState(scenario) {
  const snap = scenario === 'malformed' ? MALFORMED_SNAPSHOT : SNAPSHOT;
  state = {
    ...initialState(),
    canvases: structuredClone(snap.canvases),
    messages: [...snap.messages],
    rev: snap.rev,
  };
  resolved.clear();
}
resetState();

const http = createServer((req, res) => {
  if (req.method === 'POST' && req.url?.startsWith('/__reset')) {
    const scenario = new URL(req.url, 'http://x').searchParams.get('scenario');
    resetState(scenario);
    res.writeHead(200);
    res.end('reset');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok'); // Playwright readiness probe
});
const wss = new WebSocketServer({ server: http });

/** @type {Set<import('ws').WebSocket>} */
const clients = new Set();
/** @type {Map<import('ws').WebSocket, string>} */
const sourceOf = new Map();

const send = (/** @type {any} */ ws, /** @type {any} */ frame) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
};
const snapshotFrame = () => ({
  type: 'SNAPSHOT',
  rev: state.rev,
  canvases: state.canvases,
  messages: state.messages,
});
const broadcastChat = (/** @type {string} */ text, /** @type {string} */ source) => {
  const f = { type: 'CANVAS_MESSAGE', text, source, seq: ++idN };
  for (const c of clients) send(c, f);
};

function runEffect(/** @type {any} */ e) {
  if (e.kind === 'broadcast') for (const c of clients) send(c, e.frame);
  else if (e.kind === 'toCaller')
    for (const c of clients) if (sourceOf.get(c) === e.source) send(c, e.frame);
  // 'schedule' (lease timers) intentionally ignored in the mock.
}

/** Reduce a frame + run its effects (broadcast/toCaller). */
function apply(/** @type {any} */ frame) {
  const { state: next, effects } = reduce(state, frame, { now: ctx.now(), mintId: ctx.mintId });
  state = next;
  for (const e of effects) runEffect(e);
}

/** STUB OWNER: resolve every newly-minted consequence pending as an owner agent would.
 * Deterministic — it stands in for "an owner that resolves this way", so the round-trip
 * completes and the assertion is on the MECHANISM, not on any LLM's judgment. */
function resolveNewPendings() {
  for (const [cid, cv] of Object.entries(state.canvases)) {
    for (const [pid, p] of Object.entries(cv?.pending || {})) {
      if (resolved.has(pid)) continue;
      resolved.add(pid);
      const content = stubContent(cv, /** @type {any} */ (p));
      apply({
        type: 'UPDATE_CANVAS',
        canvasId: cid,
        resolves: pid,
        ...(content ? { content } : {}),
        source: cv.owner,
      });
    }
  }
}

/** One valid resolution per consequence action — the content patch a stub owner returns. */
function stubContent(/** @type {any} */ cv, /** @type {any} */ p) {
  const a = p.action;
  const id = () => `x${++idN}`;
  if (a === 'add_node') return { nodes: { [id()]: { label: 'Added node' } } };
  if (a === 'add_row') {
    const r = id();
    return { rows: { [r]: { _id: r, name: 'New person', field: '—' } } };
  }
  if (a === 'add_column') {
    const c = id();
    return { columns: { [c]: { label: 'New col', type: 'string' } } };
  }
  if (a === 'add_line') {
    const l = id();
    return { lines: { [l]: { text: 'New line', paragraph: p.value?.paragraph ?? 'p1' } } };
  }
  if (a === 'add_edge' && p.value)
    return {
      edges: {
        [id()]: {
          source: String(p.value.from).replace('node/', ''),
          target: String(p.value.to).replace('node/', ''),
        },
      },
    };
  if (a === 'edit_node' && p.path && p.value)
    return { nodes: { [p.path.replace('node/', '')]: { label: p.value.label } } };
  if (a === 'edit_cell' && p.path && p.value) {
    const [, rowId, colId] = p.path.split('/');
    return { rows: { [rowId]: { [colId]: p.value.value } } };
  }
  if (a === 'delete' && p.path) {
    const [kind, x] = p.path.split('/');
    if (kind === 'node') {
      // a real owner drops the node AND its incident edges (else a dangling edge breaks render)
      const edges = cv.content?.edges || {};
      const edgeNulls = {};
      for (const [eid, e] of Object.entries(edges))
        if (e && (e.source === x || e.target === x)) edgeNulls[eid] = null;
      return {
        nodes: { [x]: null },
        ...(Object.keys(edgeNulls).length ? { edges: edgeNulls } : {}),
      };
    }
    if (kind === 'edge') return { edges: { [x]: null } };
    if (kind === 'row') return { rows: { [x]: null } };
    if (kind === 'col') return { columns: { [x]: null } };
  }
  return null; // decline (content-less resolve)
}

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('message', (/** @type {any} */ raw) => {
    let frame;
    try {
      frame = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (frame.type === 'JOIN') {
      sourceOf.set(ws, frame.source || `user:mock-${++idN}`);
      send(ws, LIBRARY);
      send(ws, PARTICIPANTS);
      send(ws, snapshotFrame()); // re-JOIN (reconnect) re-seeds current state → no dupes
      return;
    }
    // stamp the unspoofable source (mirrors the hub), then reduce + broadcast.
    const stamped = { ...frame, source: sourceOf.get(ws) };
    apply(stamped);
    // CHAT-DRIVEN UPDATE: an owner agent reacting to chat. "add node" in a message → the owner
    // authors a node on g1 (an UPDATE that lands WHILE the user may be mid-interaction).
    if (
      (stamped.type === 'USER_MESSAGE' || stamped.type === 'CANVAS_MESSAGE') &&
      /add\s*node/i.test(stamped.text || '')
    ) {
      const g = state.canvases.g1;
      if (g)
        apply({
          type: 'UPDATE_CANVAS',
          canvasId: 'g1',
          content: { nodes: { [`x${++idN}`]: { label: 'Node from chat' } } },
          source: g.owner,
        });
    }
    // VALIDATION: "create broken" → the owner attempts a mis-authored spec (layout:'circle', a
    // ghost option). The reducer REJECTS it at CREATE (VALIDATION); no canvas is created and the
    // reject is surfaced to chat. Proves per-wire validation catches a bad spec up front.
    if (
      (stamped.type === 'USER_MESSAGE' || stamped.type === 'CANVAS_MESSAGE') &&
      /create\s*broken/i.test(stamped.text || '')
    ) {
      const bad = {
        type: 'CREATE_CANVAS',
        view: 'graph',
        content: { nodes: {} },
        config: { actions: {}, presentation: { layout: 'circle' } },
        source: 'agent:alice',
        seq: 0,
      };
      const { effects } = reduce(state, bad, { now: ctx.now(), mintId: ctx.mintId });
      const errFrame = effects
        .map((/** @type {any} */ e) => e.frame || {})
        .find((/** @type {any} */ f) => f.type === 'ERROR');
      if (errFrame)
        broadcastChat(`[rejected: ${errFrame.code}] ${errFrame.message}`, 'agent:alice');
    }
    // STUB OWNER: a deterministic stand-in for the owner agent. Whenever a consequence
    // pending appears on a canvas, resolve it the way *an* owner could — so the round-trip
    // (fire → pending → resolve → content) completes without a live LLM. We assert the
    // MECHANISM, not the agent's judgment.
    resolveNewPendings();
  });
  ws.on('close', () => {
    clients.delete(ws);
    sourceOf.delete(ws);
  });
});

http.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[mock-hub] listening on http://localhost:${PORT} (ws + readiness)`);
});
