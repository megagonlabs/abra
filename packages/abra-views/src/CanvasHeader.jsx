/**
 * CanvasHeader — per-canvas head: view-type glyph + title + agent-composed controls +
 * working indicator + close. Store-agnostic; plain DOM only (no shell UI library).
 */
import './canvas-chrome.css';
import { ControlWidget } from './ControlWidget.jsx';
import catalogue from './views/shared/manifests/catalogue.json';

/** @type {Record<string, string>} */
const GLYPHS = {
  graph: '⬡',
  table: '▦',
  text: '¶',
  form: '▤',
  diff: '⇄',
  display: '▣',
  harness: '⚗',
};

/** Is an agent actively working this canvas? (lock held or an open pending.) */
function isWorking(canvas) {
  if (canvas.lock) return true;
  const pending = canvas.pending ?? {};
  return Object.keys(pending).length > 0;
}

export function CanvasHeader({ canvas, onEvent, onClose, nameOf }) {
  const controls = canvas.config?.controls ?? [];
  // viewId = a short, stable handle derived from the (uuid) canvasId — every canvas has
  // one, so no new id is minted; this just surfaces it. ownerName = the owning agent.
  const viewId = canvas.canvasId ? `#${String(canvas.canvasId).slice(0, 6)}` : '';
  const ownerId = canvas.owner ?? canvas.source ?? '';
  const ownerName = nameOf ? nameOf(ownerId) : String(ownerId).replace(/^agent:/, '');
  // Published action-meanings on THIS canvas — the agent-bound "what each manipulation
  // means", surfaced to the human via an info pop                  over (gesture feedforward the views
  // otherwise only hint at through the affordance cursor).
  const viewActions = catalogue?.view?.canvas_components?.[canvas.view]?.actions ?? {};
  const interactions = Object.entries(canvas.config?.actions ?? {})
    .filter(([id]) => !id.startsWith('dehighlight_') && !id.startsWith('deselect_'))
    .map(([id, b]) => ({
      id,
      meaning: b?.meaning,
      gesture: viewActions[id]?.gesture,
      consequence: viewActions[id]?.consequence === true,
    }));
  return (
    <div className="abra-header">
      {/* identity row: view glyph · id · title · owner · (spinner/closed/close) */}
      <div className="abra-header-main">
        <span className="abra-header-glyph" aria-hidden>
          {GLYPHS[canvas.view] ?? '?'}
        </span>
        {viewId ? (
          <span className="abra-header-id" title="canvas id">
            {viewId}
          </span>
        ) : null}
        <span className="abra-title">{canvas.title ?? canvas.view}</span>
        {ownerName ? (
          <span className="abra-header-by" title="owner">
            by {ownerName}
          </span>
        ) : null}
        <span className="abra-header-spacer" />
        {isWorking(canvas) ? (
          <span
            className="abra-spinner"
            role="status"
            title="an agent is editing"
            aria-label="working"
          />
        ) : null}
        {canvas.closed ? <span className="abra-closed">closed</span> : null}
        {interactions.length ? (
          <div className="abra-header-info">
            <button
              type="button"
              className="abra-header-infobtn"
              aria-label="what the interactions on this canvas mean"
            >
              ⓘ
            </button>
            <div className="abra-header-meanings" role="tooltip">
              <div className="abra-meanings-title">Interactions on this canvas</div>
              <ul>
                {interactions.map((it) => (
                  <li key={it.id}>
                    <div className="abra-meaning-head">
                      <span className="abra-meaning-tag">{it.id}</span>
                      <span className="abra-meaning-gesture">{it.gesture ?? 'interaction'}</span>
                    </div>
                    <span className="abra-meaning-text">
                      {it.meaning}
                      {it.consequence ? <em> · agent resolves</em> : null}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}
        {onClose ? (
          <button type="button" className="abra-header-close" aria-label="close" onClick={onClose}>
            ×
          </button>
        ) : null}
      </div>
      {/* controls on their own row below — wraps when there are many, so none get clipped */}
      {onEvent && controls.length ? (
        <div className="abra-header-controls">
          {controls.map((/** @type {any} */ c) => (
            <ControlWidget key={c.id} control={c} canvas={canvas} onEvent={onEvent} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
