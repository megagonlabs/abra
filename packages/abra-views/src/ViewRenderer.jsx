/**
 * ViewRenderer — canvas replica → UI.
 * Props-in / callback-out; never mutates `canvas`.
 */
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

export function ViewRenderer({ canvas, onEvent }) {
  if (!canvas) return null;
  const View = VIEWS[canvas.view];
  if (!View) return <div data-view={canvas.view} data-canvas-id={canvas.canvasId} />;

  return (
    <div data-view={canvas.view} data-canvas-id={canvas.canvasId}>
      <View canvas={canvas} onEvent={onEvent} />
    </div>
  );
}
