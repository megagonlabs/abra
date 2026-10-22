// @ts-check
/**
 * TextView — controlled-mirror document view. LINES are wrapped by PARAGRAPHS (like cells
 * by a column): a paragraph carries the coordination `ref` (its lines inherit it) and
 * folds via collapse/expand. Line numbers are **always 1…N in display order** (derived,
 * never the raw content order). Hovering / selecting a line brushes coordination by ref.
 * Editing is inline (double-click a line): **Enter** commits (`edit_line`), **Alt/⌘/Ctrl
 * +Enter** commits and inserts a new line right after (`add_line`, positioned via the
 * `lineOrder` content key), **Esc** reverts. **Delete** removes the selected line. `find`
 * highlights matched substrings (word-level) locally. Emits CANVAS_EVENT only.
 */
import { useEffect, useRef, useState } from 'react';
import {
  affordanceClass,
  chromeEnabled,
  coordinatedKeys,
  EMPTY_SELECTION,
  elementFlags,
  hasConsequence,
  orderedRows,
  published,
  rows as rowsOf,
  toggleSelection,
} from '../shared/derive.js';
import '../views.css';

/** Fold preview: the line's first 10 characters, then an ellipsis. */
function abbreviate(/** @type {string} */ text) {
  return `${String(text ?? '').slice(0, 10)}…`;
}

/** Count non-overlapping case-insensitive matches of `q` in an already-lowercased string. */
function countMatches(/** @type {string} */ lower, /** @type {string} */ q) {
  if (!q) return 0;
  let n = 0;
  for (let i = lower.indexOf(q); i >= 0; i = lower.indexOf(q, i + q.length)) n += 1;
  return n;
}

/** Render `text`, wrapping each case-insensitive match of `q` in a <mark>. Each match is
 * tagged with its GLOBAL index (`startIdx` + local occurrence) so find-navigation can mark
 * and scroll to the `current` one. */
function highlightMatches(
  /** @type {string} */ text,
  /** @type {string} */ q,
  /** @type {number} */ startIdx = 0,
  /** @type {number} */ current = -1,
) {
  const s = String(text ?? '');
  if (!q) return s;
  const lower = s.toLowerCase();
  /** @type {(string | import('react').ReactElement)[]} */
  const out = [];
  let i = 0;
  let k = 0;
  while (i <= s.length) {
    const hit = lower.indexOf(q, i);
    if (hit < 0) {
      out.push(s.slice(i));
      break;
    }
    if (hit > i) out.push(s.slice(i, hit));
    const gIdx = startIdx + k;
    const isCurrent = gIdx === current;
    out.push(
      <mark
        key={gIdx}
        className={`abra-text-hit${isCurrent ? ' is-current' : ''}`}
        data-match-current={isCurrent ? '' : undefined}
      >
        {s.slice(hit, hit + q.length)}
      </mark>,
    );
    k += 1;
    i = hit + q.length;
  }
  return out;
}

export function TextView({ canvas, onEvent }) {
  const paragraphs = rowsOf(canvas.content?.paragraphs, 'id');
  const lineOrder = canvas.content?.lineOrder ?? null;
  const lines = orderedRows(canvas.content?.lines, lineOrder ?? undefined, 'id');
  const byId = Object.fromEntries(lines.map((l) => [l.id, l]));
  const linesByPara = /** @type {Record<string, any[]>} */ ({});
  for (const l of lines) {
    if (!linesByPara[l.paragraph]) linesByPara[l.paragraph] = [];
    linesByPara[l.paragraph].push(l);
  }
  // line numbers follow DISPLAY order (paragraph order → lines within), always 1…N — so a
  // line added mid-document renumbers everything below it instead of getting a stale index.
  /** @type {Record<string, number>} */
  const lineNumber = {};
  let n = 0;
  for (const para of paragraphs) for (const l of linesByPara[para.id] ?? []) lineNumber[l.id] = ++n;

  const [sel, setSel] = useState(EMPTY_SELECTION);
  // `config.presentation.find` is the SINGLE SOURCE OF TRUTH for the query — the built-in
  // search box AND any agent `writes:'find'` control both drive it. `findInput` is the instant
  // local mirror for typing; it reconciles from the shared value on every broadcast.
  // presentation is agent-authored, so coerce to the expected shape defensively — a bad
  // `find` (object/number) or `collapsed` (object instead of a list) must never crash the view.
  const rawFind = canvas.config?.presentation?.find;
  const presentationFind = typeof rawFind === 'string' ? rawFind : '';
  const [findInput, setFindInput] = useState(presentationFind);
  useEffect(() => setFindInput(presentationFind), [presentationFind]);
  const [currentMatch, setCurrentMatch] = useState(0);
  const bodyRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const [editing, setEditing] = useState(
    /** @type {{ id: string, draft: string } | null} */ (null),
  );
  const rawCollapsed = canvas.config?.presentation?.collapsed;
  const presentationCollapsed = Array.isArray(rawCollapsed) ? rawCollapsed : null;
  const [localCollapsed, setLocalCollapsed] = useState(
    /** @type {string[]} */ (presentationCollapsed ?? []),
  );
  useEffect(() => setLocalCollapsed(presentationCollapsed ?? []), [presentationCollapsed]);

  const lit = coordinatedKeys(canvas);
  const query = findInput.trim().toLowerCase();
  const collapsed = new Set(localCollapsed);
  const addRef = useRef(0);

  // find-navigation: count matches over VISIBLE (non-folded) lines in display order, and
  // record where each line's matches START in the global sequence so highlightMatches can
  // tag + scroll the current one. Folded paragraphs render a preview, not full lines, so
  // their matches are excluded from the count you can navigate.
  /** @type {Record<string, number>} */
  const matchStart = {};
  let matchTotal = 0;
  if (query) {
    for (const para of paragraphs) {
      if (collapsed.has(para.id)) continue;
      for (const l of linesByPara[para.id] ?? []) {
        matchStart[l.id] = matchTotal;
        matchTotal += countMatches(String(l.text ?? '').toLowerCase(), query);
      }
    }
  }
  const activeMatch = matchTotal ? ((currentMatch % matchTotal) + matchTotal) % matchTotal : -1;
  // reset the cursor whenever the query changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on query change only
  useEffect(() => setCurrentMatch(0), [query]);
  // scroll the current match into view on navigation
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on nav change only
  useEffect(() => {
    if (activeMatch < 0) return;
    bodyRef.current
      ?.querySelector('[data-match-current]')
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeMatch, query]);

  const emit = (
    /** @type {string} */ action,
    /** @type {string=} */ path,
    /** @type {string=} */ ref,
    /** @type {any=} */ extra,
  ) => {
    if (!published(canvas, action)) return;
    onEvent({ action, path, ref, ...extra });
  };

  const clearSelection = () => {
    for (const id of sel.ids) emit('deselect_line', `line/${id}`, byId[id]?.ref);
    emit('clear_selection');
    setSel(EMPTY_SELECTION);
  };

  const toggleFold = (/** @type {string} */ paraId) => {
    const isCollapsed = collapsed.has(paraId);
    const next = isCollapsed
      ? localCollapsed.filter((x) => x !== paraId)
      : [...localCollapsed, paraId];
    setLocalCollapsed(next); // instant; reconciles from the broadcast
    emit(
      isCollapsed ? 'expand_paragraph' : 'collapse_paragraph',
      `paragraph/${paraId}`,
      undefined,
      { config: { presentation: { collapsed: next } } },
    );
  };

  const canFold = chromeEnabled(canvas, 'collapse_paragraph');
  const canEdit = published(canvas, 'edit_line');
  // honest line cursor: pointer if a line can be selected, text if it can be edited, else
  // the default arrow (so a line never looks clickable when no line action is bound).
  const lineCursor = affordanceClass(canvas, [
    ['select_line', 'pointer'],
    ['edit_line', 'text'],
  ]);

  const startEdit = (/** @type {any} */ line) => {
    if (!canEdit) return;
    setEditing({ id: line.id, draft: String(line.text ?? '') });
  };

  // add a new (empty) line right after `afterId` in the same paragraph — consequence.
  const addLineAfter = (/** @type {string} */ afterId, /** @type {string} */ paraId) => {
    emit('add_line', `paragraph/${paraId}`, byId[afterId]?.ref, {
      value: { paragraph: paraId, after: afterId },
      content: hasConsequence(canvas, 'add_line')
        ? undefined
        : { lines: { [`l-new-${addRef.current++}`]: { text: '', paragraph: paraId } } },
    });
  };

  // Enter → commit; Alt/⌘/Ctrl+Enter → commit + add a line after (`also`); Esc reverts.
  const commitEdit = (/** @type {boolean} */ also) => {
    if (!editing) return;
    const { id, draft } = editing;
    const line = byId[id];
    setEditing(null);
    if (line && String(line.text ?? '') !== draft) {
      emit('edit_line', `line/${id}`, line.ref, {
        value: { text: draft },
        content: hasConsequence(canvas, 'edit_line')
          ? undefined
          : { lines: { [id]: { text: draft } } },
      });
    }
    if (also && line) addLineAfter(id, line.paragraph);
  };

  const deleteSelectedLine = () => {
    if (sel.kind !== 'line') return;
    for (const id of sel.ids) {
      emit('delete', `line/${id}`, byId[id]?.ref, {
        content: hasConsequence(canvas, 'delete') ? undefined : { lines: { [id]: null } },
      });
    }
    setSel(EMPTY_SELECTION);
  };

  return (
    <div className="abra-text-wrap" role="application" aria-label="ABRA text">
      <div className="abra-text-toolbar">
        <input
          className="abra-text-find"
          aria-label="find"
          placeholder="Find…"
          value={findInput}
          onChange={(e) => {
            const v = e.currentTarget.value;
            setFindInput(v); // instant local highlight
            // share the query as the single-source presentation.find (self-gated on `find`
            // being published — same shape a `writes:'find'` control writes).
            emit('find', undefined, undefined, { config: { presentation: { find: v } } });
          }}
        />
        {query ? (
          <span className="abra-text-find-nav">
            <span className="abra-text-find-count">
              {matchTotal ? `${activeMatch + 1}/${matchTotal}` : '0 matches'}
            </span>
            <button
              type="button"
              className="abra-text-find-btn"
              aria-label="previous match"
              disabled={!matchTotal}
              onClick={() => setCurrentMatch((c) => c - 1)}
            >
              ↑
            </button>
            <button
              type="button"
              className="abra-text-find-btn"
              aria-label="next match"
              disabled={!matchTotal}
              onClick={() => setCurrentMatch((c) => c + 1)}
            >
              ↓
            </button>
          </span>
        ) : null}
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: surface catches empty-space clicks + Delete; content is buttons */}
      <div
        ref={bodyRef}
        className="abra-text-body"
        onClick={(e) => {
          if (e.target === e.currentTarget) clearSelection();
        }}
        onKeyDown={(e) => {
          if (!editing && (e.key === 'Delete' || e.key === 'Backspace')) deleteSelectedLine();
        }}
      >
        {paragraphs.map((para) => {
          const pRef = para.ref;
          const pLines = linesByPara[para.id] ?? [];
          const foldable = pLines.length > 1; // a single-line paragraph can't fold
          const folded = foldable && collapsed.has(para.id);
          const shown = folded ? pLines.slice(0, 1) : pLines;
          return (
            <div key={para.id} className="abra-text-para">
              {shown.map((line, i) => {
                const isFirst = i === 0;
                const ref = line.ref ?? pRef; // lines inherit the paragraph's coordination ref
                const { selected, coordinated: coord } = elementFlags(
                  { sel, lit },
                  'line',
                  line.id,
                  ref,
                );
                const isEditing = editing?.id === line.id;
                const rawText = String(line.text ?? '');
                const text = folded && isFirst ? abbreviate(rawText) : rawText;
                const cls = [
                  'abra-text-line',
                  isFirst ? 'is-para-start' : '',
                  coord ? 'abra-coord' : '',
                  selected ? 'is-selected' : '',
                  // hover paint only when the hover action is bound (CSS :hover is gated on this)
                  published(canvas, 'highlight_line') ? 'is-hoverable' : '',
                ]
                  .filter(Boolean)
                  .join(' ');
                return (
                  <div key={line.id} className={cls}>
                    <span className="abra-text-gutter">{lineNumber[line.id]}</span>
                    {isFirst && canFold && foldable ? (
                      <button
                        type="button"
                        className="abra-text-fold"
                        aria-label={folded ? 'expand paragraph' : 'collapse paragraph'}
                        onClick={() => toggleFold(para.id)}
                      >
                        {folded ? '▸' : '▾'}
                      </button>
                    ) : (
                      <span className="abra-text-fold-spacer" />
                    )}
                    {isEditing ? (
                      <input
                        // biome-ignore lint/a11y/noAutofocus: inline editor opens on demand, focus is expected
                        autoFocus
                        className="abra-text-line-editor"
                        value={editing.draft}
                        onChange={(e) => setEditing({ id: line.id, draft: e.currentTarget.value })}
                        onBlur={() => commitEdit(false)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            commitEdit(e.altKey || e.metaKey || e.ctrlKey);
                          } else if (e.key === 'Escape') {
                            setEditing(null);
                          }
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        className={`abra-text-content ${lineCursor}`}
                        onMouseEnter={() => emit('highlight_line', `line/${line.id}`, ref)}
                        onMouseLeave={() => emit('dehighlight_line', `line/${line.id}`, ref)}
                        onDoubleClick={() => startEdit(line)}
                        onClick={() => {
                          if (!published(canvas, 'select_line')) return; // no select local_effect if unbound
                          if (selected) emit('deselect_line', `line/${line.id}`, ref);
                          else emit('select_line', `line/${line.id}`, ref);
                          setSel((s) => toggleSelection(s, 'line', line.id));
                        }}
                      >
                        {highlightMatches(text, query, matchStart[line.id] ?? 0, activeMatch)}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
