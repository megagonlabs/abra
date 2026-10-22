// @ts-check
/**
 * ViewRail — the human's control over WHICH live canvases show and in WHAT order (a
 * client-local viewport concern, not canvas state). One row per live canvas: type glyph +
 * short id + title + owner, an eye toggle (activate/deactivate), and ↑/↓ reorder.
 * Deliberately a LIST, not chips — a stable, scannable roster the user curates. State
 * isolation runs at its default (see useViewport) with no user-facing knob.
 */
const GLYPHS = { graph: '⬡', table: '▦', text: '¶', display: '▣', form: '▤', diff: '⇄' };

/**
 * @param {{
 *   order: string[], canvases: Record<string, any>, hidden: Set<string>,
 *   onToggle: (id: string) => void,
 *   onMove: (id: string, dir: -1 | 1) => void,
 *   nameOf?: (source: any) => string,
 * }} props
 */
export function ViewRail({ order, canvases, hidden, onToggle, onMove, nameOf }) {
  const rows = order.filter((id) => canvases[id]);
  const visible = rows.filter((id) => !hidden.has(id)).length;
  return (
    <aside className="abra-rail" aria-label="views">
      <div className="abra-rail-head">
        Views ({visible}/{rows.length})
      </div>
      <ul className="abra-rail-list">
        {rows.map((id, i) => {
          const c = canvases[id];
          const off = hidden.has(id);
          const ownerName = nameOf
            ? nameOf(c.owner ?? c.source ?? '')
            : String(c.owner ?? '').replace(/^agent:/, '');
          return (
            <li key={id} className={`abra-rail-row${off ? ' abra-rail-row--off' : ''}`}>
              <button
                type="button"
                className="abra-rail-eye"
                aria-pressed={!off}
                title={off ? 'show this view' : 'hide this view'}
                onClick={() => onToggle(id)}
              >
                {off ? '◌' : '●'}
              </button>
              <span className="abra-rail-glyph" aria-hidden>
                {GLYPHS[c.view] ?? '?'}
              </span>
              <span className="abra-rail-meta">
                <span className="abra-rail-title">{c.title ?? c.view}</span>
                <span className="abra-rail-sub">
                  #{String(id).slice(0, 6)}
                  {ownerName ? ` · ${ownerName}` : ''}
                </span>
              </span>
              <span className="abra-rail-ord">
                <button
                  type="button"
                  disabled={i === 0}
                  title="move up"
                  onClick={() => onMove(id, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  disabled={i === rows.length - 1}
                  title="move down"
                  onClick={() => onMove(id, 1)}
                >
                  ↓
                </button>
              </span>
            </li>
          );
        })}
        {rows.length === 0 ? <li className="abra-rail-empty">no views yet</li> : null}
      </ul>
    </aside>
  );
}
