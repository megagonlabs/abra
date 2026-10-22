// @ts-check
/**
 * App — the demo-client shell. Composes a top bar
 * (session chrome + connection dot + participant strip + Participants + Start
 * fresh) over a stable two-pane frame: the canvas panel LEFT (a structure-by-count
 * CanvasArea body showing every LIVE canvas the agent opened) and chat RIGHT
 * (resizable, min-width, NOT collapsible — it's the medium). Nothing relocates.
 *
 * The replica store is the sole writer of canvas/chat state; participant/library
 * are shell slices. The display set is the agent's live canvases (create shows, close
 * hides) — no history track / show-hide toggle. Connection status is client-local.
 */
import { linkIndex } from 'abra-reducer/apply';
import { CanvasArea, CanvasPanel } from 'abra-views';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { useStore } from 'zustand';
import { ChatPane } from './components/ChatPane.jsx';
import { TopBar } from './components/TopBar.jsx';
import { ViewRail } from './components/ViewRail.jsx';
import { statusOf } from './participants.js';
import { readSessionId, startFresh, userSource } from './session.js';
import { createReplicaStore } from './store.js';
import { useViewport } from './viewport.js';
import { connectHub } from './ws.js';

// content collection for each element-path prefix (all id-keyed maps; rows keyed by _id).
const _PATH_COLL = {
  node: 'nodes',
  edge: 'edges',
  row: 'rows',
  col: 'columns',
  item: 'items',
  line: 'lines',
  paragraph: 'paragraphs',
  annotation: 'annotations',
};

/** Does an element `path` (`node/<id>`, `cell/<r>/<c>`, `row/<id>`, `item/<id>`, …) resolve to a
 * real element in `content`? Mirrors the reducer's referential check — used to grey out a chip
 * whose path points at nothing (a dangling coordination chip). */
function pathExists(/** @type {any} */ content, /** @type {string} */ path) {
  if (!content || typeof path !== 'string') return false;
  const p = path.split('/');
  if (p[0] === 'cell') return !!(content.rows?.[p[1]] && content.columns?.[p[2]]);
  const coll = _PATH_COLL[p[0]];
  return !!(coll && content[coll] && content[coll][p[1]] !== undefined);
}

export function App() {
  const storeRef = useRef(/** @type {any} */ (null));
  if (!storeRef.current) storeRef.current = createReplicaStore();
  const store = storeRef.current;
  // per-window session id (in the URL) + per-tab user identity — computed once
  const idsRef = useRef(/** @type {any} */ (null));
  if (!idsRef.current) idsRef.current = { sessionId: readSessionId(), source: userSource() };
  const { sessionId, source } = idsRef.current;
  const state = useStore(store);
  const connRef = useRef(/** @type {any} */ (null));
  const [draft, setDraft] = useState('');
  /** @type {['connected' | 'reconnecting', Function]} */
  const [conn, setConn] = useState(/** @type {const} */ ('reconnecting'));
  // a hovered chat coordination chip → { canvasId, path } to light (client-local, transient).
  const [refHover, setRefHover] = useState(
    /** @type {{canvasId:string, path:string}|null} */ (null),
  );

  // Every LIVE (non-closed) canvas the agent opened, in creation order. The agent's intent
  // is to display all of them; the ViewRail (client-local viewport) lets the HUMAN curate
  // which to show + in what order — it never closes a canvas, only hides it in this window.
  const liveIds = useMemo(
    () => Object.keys(state.canvases).filter((id) => !state.canvases[id].closed),
    [state.canvases],
  );
  const vp = useViewport(liveIds);
  const liveIdSet = useMemo(() => new Set(liveIds), [liveIds]); // chip availability check
  // a chip is only live if its path resolves to a real element in that canvas's content.
  const resolvePath = (/** @type {string} */ canvasId, /** @type {string} */ path) => {
    const c = state.canvases[canvasId];
    return !!c && !c.closed && pathExists(c.content, path);
  };
  // Coordination LINK-INDEX: the reducer writes each `highlight` overlay onto its
  // originating canvas; render each canvas with the union of the OTHERS' overlays so a
  // brushed ref pulses co-referents in OTHER views (and the source element itself shows
  // only its local highlight, never the coordination pulse). Same shared helper the
  // playground uses — coordination must behave identically across shells. We also stamp a
  // client-local `epoch` (from the viewport) so the state-isolation toggles can remount a
  // view to clear its local selection/hover.
  const linkedCanvases = useMemo(() => {
    const merged = linkIndex(state.canvases);
    /** @type {Record<string, any>} */
    const out = {};
    for (const [id, c] of Object.entries(state.canvases)) {
      let highlight = merged[id];
      // hovered chat chip → inject its exact path into THIS canvas's overlay (keyed by the
      // path, so the element at that path lights with the coordination effect). client-local.
      if (refHover?.canvasId === id && refHover.path)
        highlight = {
          ...highlight,
          [refHover.path]: { 'user:chip': { referential: { paths: [refHover.path] } } },
        };
      out[id] = { ...c, highlight, epoch: vp.epochOf(id) };
    }
    return out;
  }, [state.canvases, vp.epochOf, refHover]);

  // Resolve a wire source id → display label: own → "you", any user → "user", an agent →
  // its display name (p.name, case-insensitive; falls back to the raw id if it has left).
  // Memoized so the id→name map is built once per cast change, not per chat message.
  const nameOf = useMemo(() => {
    /** @type {Map<string, string>} */
    const byId = new Map();
    for (const p of state.participants) byId.set(p.name.toLowerCase(), p.name);
    return (/** @type {any} */ s) => {
      if (s === source) return 'you';
      const str = String(s ?? 'sys');
      if (str.startsWith('user:')) return 'user';
      const id = str.replace(/^agent:/, '');
      return byId.get(id) ?? id;
    };
  }, [state.participants, source]);

  // cast members currently busy → the chat activity line.
  const workingNames = state.participants
    .filter((p) => statusOf(p) === 'working')
    .map((p) => p.name);

  // resolve an agent's capability blurb from the library (case-insensitive).
  const blurbOf = (/** @type {string} */ name) =>
    state.library.find((a) => a.name.toLowerCase() === name.toLowerCase())?.blurb ?? '';

  useEffect(() => {
    const port = 8787;
    const conn = connectHub({
      url: `ws://${window.location.hostname}:${port}`,
      sessionId,
      source,
      onFrame: (f) => store.getState().applyFrame(f),
      onStatus: (s) => setConn(s),
    });
    connRef.current = conn;
    return () => conn.close();
  }, [store, sessionId, source]);

  // The USER speaks ONLY CANVAS_EVENT — UPDATE_CANVAS and CREATE_CANVAS are agent-only.
  // A presentation gesture (collapse / reorder / layout / filter) rides along as a
  // `config.presentation` patch on the same event; the server applies it (a presentation
  // op). Content is never user-authored — it changes via consequences the owning agent
  // resolves — so it is not forwarded here.
  const emitEvent = (/** @type {string} */ canvasId, /** @type {any} */ intent) => {
    const conn = connRef.current;
    if (!conn) return;
    conn.send({
      type: 'CANVAS_EVENT',
      canvasId,
      action: intent.action,
      control: intent.control,
      path: intent.path,
      ref: intent.ref,
      value: intent.value,
      config: intent.config,
      timestamp: Date.now(),
    });
  };

  const sendChat = (/** @type {any} */ e) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    connRef.current?.send({ type: 'USER_MESSAGE', text });
    setDraft('');
  };

  // immediate-apply participant intents (the hub's CONTROL_RELAY forwards them).
  const addAgent = (/** @type {string} */ name) =>
    connRef.current?.send({ type: 'ADD_AGENT', name });
  const removeAgent = (/** @type {string} */ name) =>
    connRef.current?.send({ type: 'REMOVE_AGENT', name });
  // restart a crashed agent = remove (clears the host's entry) then re-add.
  const restartAgent = (/** @type {string} */ name) => {
    removeAgent(name);
    addAgent(name);
  };

  return (
    <div className="abra-app">
      <TopBar
        sessionId={sessionId}
        conn={conn}
        participants={state.participants}
        library={state.library}
        blurbOf={blurbOf}
        onAdd={addAgent}
        onRemove={removeAgent}
        onRestart={restartAgent}
        onStartFresh={startFresh}
      />
      <Group className="abra-body" orientation="horizontal">
        <Panel className="abra-panel" minSize="40%">
          <div className="abra-canvaswrap">
            <ViewRail
              order={vp.order}
              canvases={linkedCanvases}
              hidden={vp.hidden}
              onToggle={vp.toggleActive}
              onMove={vp.move}
              nameOf={nameOf}
            />
            <div className="abra-canvasmain">
              <CanvasArea
                shown={vp.shown}
                canvases={linkedCanvases}
                onEvent={emitEvent}
                onClose={(id) => connRef.current?.send({ type: 'CLOSE_CANVAS', canvasId: id })}
                nameOf={nameOf}
              />
              {/* Parked = deactivated-but-live canvases kept MOUNTED offscreen so their
                  local selection/hover survives being hidden (keepStateWhileHidden). */}
              {vp.parked.length ? (
                <div className="abra-parked" aria-hidden>
                  {vp.parked.map((id) =>
                    linkedCanvases[id] ? (
                      <CanvasPanel
                        key={id}
                        canvas={linkedCanvases[id]}
                        onEvent={(partial) => emitEvent(id, partial)}
                        nameOf={nameOf}
                      />
                    ) : null,
                  )}
                </div>
              ) : null}
            </div>
          </div>
        </Panel>
        <Separator className="abra-sep" />
        {/* chat stays adjustable but within a ~100px band (280–380) — never so wide it
            crowds the canvas nor so narrow the conversation is unreadable. */}
        <Panel className="abra-chat-pane" minSize="280px" defaultSize="320px" maxSize="380px">
          <ChatPane
            messages={state.messages}
            label={nameOf}
            working={workingNames}
            draft={draft}
            onDraft={setDraft}
            onSend={sendChat}
            onRefHover={setRefHover}
            liveIds={liveIdSet}
            resolvePath={resolvePath}
          />
        </Panel>
      </Group>
    </div>
  );
}
