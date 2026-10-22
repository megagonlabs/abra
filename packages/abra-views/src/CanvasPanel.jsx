/**
 * CanvasPanel — the store-agnostic per-canvas renderer. Dispatches by `view`
 * type to a view component (props-in / callback-out: it emits CANVAS_EVENTs via
 * `onEvent`, never mutating state locally). New views register in VIEWS —
 * additive, not a refactor.
 */
import { useRef } from 'react';
import { CanvasHeader } from './CanvasHeader.jsx';
import { DisplayView } from './views/Display/DisplayView.jsx';
import { GraphView } from './views/Graph/GraphView.jsx';
import { TableView } from './views/Table/TableView.jsx';
import { TextView } from './views/Text/TextView.jsx';

const VIEWS = {
  graph: GraphView,
  table: TableView,
  text: TextView,
  display: DisplayView,
};

function UnknownView({ canvas }) {
  return <div className="abra-unknown">No renderer for view “{canvas.view}”.</div>;
}

export function CanvasPanel({ canvas, onEvent, onClose, nameOf }) {
  const View = VIEWS[canvas.view] ?? UnknownView;
  // Imperative VIEWPORT commands (fit_all / fit_content) aren't shared STATE — they're a
  // one-shot `fitView()`-style call with nothing to persist, so they can't ride
  // config.presentation like layout/sort do. The view registers them on `viewportApiRef`
  // (keyed by action id); a header control that fires one is handled LOCALLY (viewport is
  // client-local) instead of round-tripping. Everything else forwards to onEvent as usual.
  const viewportApiRef = useRef(/** @type {Record<string, (v: any) => void> | null} */ (null));
  const onHeaderEvent = (/** @type {any} */ intent) => {
    const cmd = intent?.action ? viewportApiRef.current?.[intent.action] : undefined;
    if (cmd) {
      cmd(intent.value);
      return;
    }
    onEvent?.(intent);
  };
  // Views are controlled mirrors keyed on `{canvasId}:{epoch}`:
  // `epoch` is a client-local remount key. Bumping it (a shell viewport concern) tears
  // down + rebuilds the view, resetting its LOCAL selected/hovered state — the lever a
  // shell uses to isolate per-view interaction state across canvas add/remove. Absent
  // (playground) → stable key → never remounts.
  const viewKey = `${canvas.canvasId}:${canvas.epoch ?? 0}`;
  return (
    <section className="abra-canvas" data-view={canvas.view} data-closed={!!canvas.closed}>
      <CanvasHeader canvas={canvas} onEvent={onHeaderEvent} onClose={onClose} nameOf={nameOf} />
      <div className="abra-canvas-body">
        <View key={viewKey} canvas={canvas} onEvent={onEvent} viewportApiRef={viewportApiRef} />
      </div>
    </section>
  );
}
