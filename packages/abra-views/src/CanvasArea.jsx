/**
 * CanvasArea — the canvas-panel BODY: a predefined STRUCTURE BY COUNT over
 * `react-resizable-panels` v4. One neutral
 * arrangement per count — 1 = full · 2 = side-by-side · 3 = two-over-one ·
 * 4 = 2×2 — every divider resizable, a single GLOBAL min-size per cell so no cell
 * starves. Shown canvases fill slots in the given order; a `popout` canvas renders
 * as a normal cell (no floating windows). Each cell reuses the store-agnostic
 * `CanvasPanel`. Selection/visibility (the chip bar) is the shell's concern — this
 * component just lays out whichever ids it's handed. Empty set → the empty-state.
 *
 * @typedef {import('react-resizable-panels').Group} _G
 */
import { Group, Panel, Separator } from 'react-resizable-panels';
import { CanvasPanel } from './CanvasPanel.jsx';

/** Global, view-agnostic minimum cell size (px) — stops a cell starving. */
const CELL_MIN = '180px';

const EMPTY = 'Canvases appear here when an agent opens one.';

/** One leaf cell: a resizable Panel wrapping the per-canvas renderer. */
function Cell({ id, canvas, onEvent, onClose, nameOf }) {
  return (
    <Panel className="abra-cell" minSize={CELL_MIN}>
      <CanvasPanel
        canvas={canvas}
        onEvent={(partial) => onEvent?.(id, partial)}
        onClose={() => onClose?.(id)}
        nameOf={nameOf}
      />
    </Panel>
  );
}

/**
 * @param {{
 *   shown: string[],
 *   canvases: Record<string, any>,
 *   onEvent?: (id: string, partial: any) => void,
 *   onClose?: (id: string) => void,
 *   nameOf?: (source: any) => string,
 * }} props
 */
export function CanvasArea({ shown, canvases, onEvent, onClose, nameOf }) {
  const ids = (shown ?? []).filter((id) => canvases[id]);

  if (ids.length === 0) {
    return <div className="abra-canvas-body abra-empty">{EMPTY}</div>;
  }

  /** @param {string} id */
  const cell = (id) => (
    <Cell
      key={id}
      id={id}
      canvas={canvases[id]}
      onEvent={onEvent}
      onClose={onClose}
      nameOf={nameOf}
    />
  );

  // 1 = full
  if (ids.length === 1) {
    return (
      <Group className="abra-structure" orientation="horizontal">
        {cell(ids[0])}
      </Group>
    );
  }

  // 2 = side-by-side
  if (ids.length === 2) {
    return (
      <Group className="abra-structure" orientation="horizontal">
        {cell(ids[0])}
        <Separator className="abra-sep" />
        {cell(ids[1])}
      </Group>
    );
  }

  // 3 = two-over-one (top row of two, full-width bottom)
  if (ids.length === 3) {
    return (
      <Group className="abra-structure" orientation="vertical">
        <Panel className="abra-row" minSize={CELL_MIN}>
          <Group className="abra-structure" orientation="horizontal">
            {cell(ids[0])}
            <Separator className="abra-sep" />
            {cell(ids[1])}
          </Group>
        </Panel>
        <Separator className="abra-sep" />
        {cell(ids[2])}
      </Group>
    );
  }

  // >4 = a scrollable grid showing EVERY live canvas (no recency, nothing hidden). The
  // agent hides a view by CLOSING it; the shell never silently drops one.
  if (ids.length > 4) {
    return (
      <div className="abra-grid">
        {ids.map((id) => (
          <div key={id} className="abra-grid-cell">
            <CanvasPanel
              canvas={canvases[id]}
              onEvent={(partial) => onEvent?.(id, partial)}
              onClose={() => onClose?.(id)}
              nameOf={nameOf}
            />
          </div>
        ))}
      </div>
    );
  }

  // 4 = 2×2 (two rows of two)
  return (
    <Group className="abra-structure" orientation="vertical">
      <Panel className="abra-row" minSize={CELL_MIN}>
        <Group className="abra-structure" orientation="horizontal">
          {cell(ids[0])}
          <Separator className="abra-sep" />
          {cell(ids[1])}
        </Group>
      </Panel>
      <Separator className="abra-sep" />
      <Panel className="abra-row" minSize={CELL_MIN}>
        <Group className="abra-structure" orientation="horizontal">
          {cell(ids[2])}
          <Separator className="abra-sep" />
          {cell(ids[3])}
        </Group>
      </Panel>
    </Group>
  );
}
