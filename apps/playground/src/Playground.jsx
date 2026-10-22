/**
 * Playground — the original standalone playground, re-wired. Same shell (scenario picker +
 * spec tree · stacked views · "emitted to agent" panel · pending overlay), but the
 * data layer is the controlled-mirror reduce loop instead of local Zustand
 * authority: views are render replicas of `canvas` that emit intents; coordination
 * rides the highlight overlay through the link-index; a consequence mints a real
 * server pending a simulated owner resolves. One human user, brushing across the
 * stacked views (graph↔table by ref).
 *
 * The scenario picker offers curated presets AND a "Custom" mode: the spec panel
 * becomes a JSON editor (seeded from a preset via "Edit as custom") whose Render
 * re-seeds the loop — so any content/config/controls spec can be tried live
 * (presets for the model demo · the editor for spec/control/config coverage).
 */
import { ControlWidget, DisplayView, GraphView, TableView, TextView } from 'abra-views';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { createLoop } from './loop.js';
import { SCENARIOS, SEED_OWNER } from './scenarios.js';

const VIEW = { graph: GraphView, table: TableView, text: TextView, display: DisplayView };

const CUSTOM = '__custom__';
const CUSTOM_META = {
  id: CUSTOM,
  label: '✎ Custom (edit spec)',
  description:
    'Edit the canvas spec JSON below, then Render. Start from a preset with “Edit as custom”.',
};

/** A CREATE_CANVAS minus the wire envelope — the part worth editing. */
const authoring = ({ type, source, reqId, ...rest }) => rest;
/** Wrap an edited authoring spec back into a CREATE_CANVAS. */
const wrapCreate = (spec) => ({
  type: 'CREATE_CANVAS',
  source: SEED_OWNER,
  reqId: 'custom',
  ...spec,
});

export function Playground() {
  const [scenarioId, setScenarioId] = useState(SCENARIOS[0].id);
  const scenario = SCENARIOS.find((s) => s.id === scenarioId) ?? CUSTOM_META;
  const isCustom = scenarioId === CUSTOM;

  // Custom spec: the editor text (smooth, local) + the APPLIED seed (changes only
  // on Render, so the loop re-seeds deliberately, not on every keystroke).
  const [customText, setCustomText] = useState(() =>
    JSON.stringify(authoring(SCENARIOS[0].build()[0]), null, 2),
  );
  const [customSeed, setCustomSeed] = useState(() => SCENARIOS[0].build());
  const [customError, setCustomError] = useState(/** @type {string | null} */ (null));

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-seed on scenario / applied-custom change only
  const loop = useMemo(
    () => createLoop(isCustom ? customSeed : scenario.build()),
    [scenarioId, customSeed],
  );
  useEffect(() => () => loop.teardown(), [loop]);
  const snap = useSyncExternalStore(loop.subscribe, loop.getSnapshot);

  const canvases = Object.values(snap.replica.canvases ?? {});

  // Controls are now DECLARATIVE (ControlWidget emits the `config.presentation` patch
  // itself via `control.writes`), so the shell just forwards every intent — `loop.emit`
  // already splits action → CANVAS_EVENT and config/content → UPDATE_CANVAS.
  /** @param {string} id */
  const onEventFor = (id) => (intent) => loop.emit('user', id, intent);

  const renderCustom = () => {
    try {
      const parsed = JSON.parse(customText);
      setCustomError(null);
      setCustomSeed([wrapCreate(parsed)]);
    } catch (e) {
      setCustomError(String(e?.message ?? e));
    }
  };

  /** Fork the current preset's first canvas into the editor + switch to Custom. */
  const forkToCustom = () => {
    const first = scenario.build?.()?.[0];
    if (!first) return;
    setCustomText(JSON.stringify(authoring(first), null, 2));
    setCustomError(null);
    setCustomSeed([first]);
    setScenarioId(CUSTOM);
  };

  const specSummary = {
    views: canvases.map((c) => ({
      canvasId: c.canvasId,
      view: c.view,
      controls: c.config?.controls ?? [],
      config: c.config,
    })),
  };

  return (
    <div className="pg">
      <header className="pg-top">
        <span>{scenario.description}</span>
        <span className="pg-faint">
          {canvases.length > 1
            ? `views: ${canvases.map((c) => c.canvasId).join(' / ')}`
            : `canvas: ${canvases[0]?.canvasId ?? '—'}`}
        </span>
      </header>

      <div className="pg-body">
        <aside className="pg-sidebar">
          <div className="pg-side-block">
            <div className="pg-h">Scenario</div>
            <select
              className="pg-select"
              value={scenarioId}
              onChange={(e) => setScenarioId(e.target.value)}
            >
              {SCENARIOS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
              <option value={CUSTOM}>{CUSTOM_META.label}</option>
            </select>
            <p className="pg-desc">{scenario.description}</p>
          </div>
          <div className="pg-side-block pg-spec">
            <div className="pg-h">{isCustom ? 'Spec editor' : 'Current spec'}</div>
            {isCustom ? (
              <div className="pg-editor">
                <textarea
                  className="pg-editor-area"
                  spellCheck={false}
                  value={customText}
                  onChange={(e) => setCustomText(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') renderCustom();
                  }}
                />
                {customError && <div className="pg-editor-err">{customError}</div>}
                <div className="pg-editor-actions">
                  <button type="button" className="pg-render-btn" onClick={renderCustom}>
                    Render (⌘↵)
                  </button>
                </div>
              </div>
            ) : (
              <div className="pg-spec-body">
                <JsonTree name="spec" value={specSummary} depth={0} defaultOpen />
                <button type="button" className="pg-edit-btn" onClick={forkToCustom}>
                  ✎ Edit as custom
                </button>
              </div>
            )}
          </div>
        </aside>

        <div className={`pg-stack pg-count-${Math.min(canvases.length, 4)}`}>
          {canvases.length === 0 ? (
            <div className="pg-empty">seeding…</div>
          ) : (
            canvases.map((c) => {
              const View = VIEW[c.view];
              const onEvent = onEventFor(c.canvasId);
              return (
                <div className="pg-view" key={c.canvasId}>
                  <div className="pg-view-head">
                    <span className="pg-view-title">{c.title ?? c.view}</span>
                    <div className="pg-view-controls">
                      {(c.config?.controls ?? []).map((ctrl) => (
                        // pass `canvas` so the control is CONTROLLED (reflects the current
                        // config.presentation value) — matches CanvasHeader in the demo.
                        <ControlWidget key={ctrl.id} control={ctrl} canvas={c} onEvent={onEvent} />
                      ))}
                    </div>
                  </div>
                  <div className="pg-view-body">
                    {View ? <View canvas={c} onEvent={onEvent} /> : null}
                  </div>
                </div>
              );
            })
          )}
        </div>

        <aside className="pg-panel">
          <div className="pg-panel-head">
            <span>Emitted to agent</span>
            <button type="button" className="pg-clear" onClick={() => loop.clearEvents()}>
              clear
            </button>
          </div>
          <EventGroup
            title="Local effects"
            hint="Hover, select, or clear…"
            rows={snap.events.localEffect}
          />
          <EventGroup
            title="Consequence"
            hint="Double-click or add_edge…"
            rows={snap.events.consequence}
          />
          <EventGroup
            title="Controls action"
            hint="Use the toolbar…"
            rows={snap.events.control}
            controlsOnly
          />
        </aside>
      </div>

      {snap.pending.open && (
        <div className="pg-overlay">
          <div className="pg-overlay-card">
            <div className="pg-overlay-title">{snap.pending.label}</div>
            <div className="pg-progress">
              <div className="pg-progress-bar" />
            </div>
            <div className="pg-overlay-sub">
              Interaction pauses while the owner agent resolves the consequence.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** One section of the emitted-to-agent panel. */
function EventGroup({ title, hint, rows, controlsOnly }) {
  return (
    <div className="pg-group">
      <div className="pg-h">{title}</div>
      {rows.length === 0 ? (
        <div className="pg-callout">{hint}</div>
      ) : (
        rows.map((e) => <EventCard key={e.id} event={e} controlsOnly={controlsOnly} />)
      )}
    </div>
  );
}

function EventCard({ event, controlsOnly }) {
  const rows = controlsOnly
    ? [
        ['control', event.control],
        ['value', json(event.value)],
      ]
    : [
        ['action', event.action],
        ['ref', event.ref],
        ['path', event.path],
        ['value', json(event.value)],
      ];
  return (
    <div className="pg-card">
      <div className="pg-card-ts">
        {event.ts} · {event.source}
      </div>
      {rows.map(([k, v]) =>
        v !== undefined ? (
          <div className="pg-kv" key={k}>
            <span className="pg-k">{k}</span>
            <span className="pg-v">{v}</span>
          </div>
        ) : null,
      )}
    </div>
  );
}

const json = (v) => (v !== undefined ? JSON.stringify(v) : undefined);

/** A small collapsible JSON tree for the spec panel. */
function JsonTree({ name, value, depth, defaultOpen = false }) {
  const branch = value !== null && typeof value === 'object';
  const [open, setOpen] = useState(defaultOpen || depth < 2);
  const entries = branch ? Object.entries(value) : [];
  return (
    <div className="pg-json" style={{ paddingLeft: depth ? 10 : 0 }}>
      <div className="pg-json-row">
        {branch ? (
          <button type="button" className="pg-json-toggle" onClick={() => setOpen((o) => !o)}>
            {open ? '▾' : '▸'}
          </button>
        ) : (
          <span className="pg-json-toggle" />
        )}
        <span className="pg-json-key">{name}</span>
        <span className="pg-json-prev">{preview(value)}</span>
      </div>
      {branch &&
        open &&
        entries.map(([k, v]) => <JsonTree key={k} name={k} value={v} depth={depth + 1} />)}
    </div>
  );
}

function preview(v) {
  if (Array.isArray(v)) return `[${v.length}]`;
  if (v !== null && typeof v === 'object') return `{${Object.keys(v).length}}`;
  if (typeof v === 'string') return JSON.stringify(v);
  return String(v);
}
