/**
 * TableView — controlled-mirror table (@tanstack/react-table v8).
 *
 * Pure render of `canvas`: columns/rows derived from id-keyed content; channels
 * painted per the view manifest (actionPresentation.json) — highlight = border/borderLeft/borderTop, selection =
 * fill/background. Coordination is read from `canvas.highlight`: a row whose `ref`
 * is lit pulses the ROW coordination_channel (animated borderLeft on the row
 * handle). Handlers emit CANVAS_EVENT intents (gated on the published binding)
 * via `onEvent` — never mutating the replica. Selection is the one view-private
 * state, single across cell / row / column.
 */
import { getCoreRowModel, useReactTable } from '@tanstack/react-table';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  affordanceClass,
  appliedEffectKeys,
  chromeEnabled,
  coordinatedKeys,
  EMPTY_SELECTION,
  elementFlags,
  hasConsequence,
  isSelected,
  orderedRows,
  published,
  rows as rowsOf,
  toggleSelection,
} from '../shared/derive.js';
import { useInteractionManager } from '../shared/interaction.js';
import '../views.css';

const HIGHLIGHT = '#f59e0b';
const SORT_ORDER = [null, 'asc', 'desc'];

function compareValues(/** @type {any} */ a, /** @type {any} */ b) {
  const an = Number(a);
  const bn = Number(b);
  if (!Number.isNaN(an) && !Number.isNaN(bn)) return an - bn;
  return String(a ?? '').localeCompare(String(b ?? ''), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function nextSortDir(/** @type {'asc' | 'desc' | null} */ dir) {
  return SORT_ORDER[(SORT_ORDER.indexOf(dir) + 1) % SORT_ORDER.length];
}

export function TableView({ canvas, onEvent }) {
  const cols = rowsOf(canvas.content?.columns);
  const [localSort, setLocalSort] = useState(
    /** @type {{ colId: string, dir: 'asc' | 'desc' } | null} */ (
      canvas.config?.presentation?.sort ?? null
    ),
  );
  const [localFilter, setLocalFilter] = useState(
    /** @type {{ colId: string, keyword: string } | null} */ (
      canvas.config?.presentation?.filter ?? null
    ),
  );
  // Row order is a PRESENTATION value (config.presentation.order), not content:
  // a presentation patch is outside the content authoring gate, so a user may
  // reorder even on an exclusive canvas (the agent owns the DATA, not the view
  // order). `localOrder` is the instant view-local shadow; it reconciles from the
  // authoritative `presentation.order` on every broadcast.
  const [localOrder, setLocalOrder] = useState(
    /** @type {string[] | null} */ (canvas.config?.presentation?.order ?? null),
  );
  const [dragRowId, setDragRowId] = useState(/** @type {string | null} */ (null));
  // the row currently hovered while dragging — drives the live reorder PREVIEW (the dragged
  // row is rendered at this target slot so you see where it will land before dropping).
  const [dragOverId, setDragOverId] = useState(/** @type {string | null} */ (null));
  const [editing, setEditing] = useState(
    /** @type {{ rowId: string, colId: string, draft: string } | null} */ (null),
  );
  const [headerEdit, setHeaderEdit] = useState(
    /** @type {{ colId: string, draft: string } | null} */ (null),
  );
  const [block, setBlock] = useState(
    /** @type {{ fromRowId: string, fromColId: string, toRowId: string, toColId: string } | null } */ (
      null
    ),
  );
  const [blockDrag, setBlockDrag] = useState(
    /** @type {{ fromRowId: string, fromColId: string, toRowId: string, toColId: string } | null } */ (
      null
    ),
  );
  const blockAnchorRef = useRef(/** @type {{ rowId: string, colId: string } | null } */ (null));
  const suppressCellClickRef = useRef(false);

  const [hover, setHover] = useState(/** @type {{ kind: string, id: string } | null} */ (null));
  const [sel, setSel] = useState(EMPTY_SELECTION);
  const ix = useInteractionManager();
  const lit = coordinatedKeys(canvas);
  const sharedEffects = appliedEffectKeys(canvas);
  const presentationSort = canvas.config?.presentation?.sort ?? null;
  const presentationFilter = canvas.config?.presentation?.filter ?? null;
  const presentationOrder = canvas.config?.presentation?.order ?? null;

  useEffect(() => setLocalSort(presentationSort), [presentationSort]);
  useEffect(() => setLocalFilter(presentationFilter), [presentationFilter]);
  useEffect(() => setLocalOrder(presentationOrder), [presentationOrder]);

  const baseData = useMemo(
    () => orderedRows(canvas.content?.rows, localOrder, '_id'),
    [canvas.content?.rows, localOrder],
  );
  const byRowId = useMemo(() => Object.fromEntries(baseData.map((r) => [r._id, r])), [baseData]);
  const displayData = useMemo(() => {
    let next = baseData;
    if (localFilter?.keyword) {
      const q = localFilter.keyword.toLowerCase();
      next = next.filter((r) =>
        String(r[localFilter.colId] ?? '')
          .toLowerCase()
          .includes(q),
      );
    }
    // `presentation.sort` is the single source of truth. Any writer keyed-merges into it:
    // the header sends the full `{colId, dir}`; a `writes:'sort.colId'` control sets only the
    // column (dir may be absent) and a `writes:'sort.dir'` switch sets only the direction.
    // So a colId with no dir means "sort ascending" — the view owns that default.
    if (localSort?.colId) {
      const sign = localSort.dir === 'desc' ? -1 : 1;
      next = [...next].sort((a, b) => sign * compareValues(a[localSort.colId], b[localSort.colId]));
    }
    return next;
  }, [baseData, localFilter, localSort]);
  const rowIndexById = useMemo(
    () => Object.fromEntries(displayData.map((row, idx) => [row._id, idx])),
    [displayData],
  );
  const colIndexById = useMemo(
    () => Object.fromEntries(cols.map((col, idx) => [col.id, idx])),
    [cols],
  );

  const columns = cols.map((c) => ({ id: c.id, accessorKey: c.id, header: c.label ?? c.id }));
  const table = useReactTable({ data: displayData, columns, getCoreRowModel: getCoreRowModel() });

  const isWithinBlock = (
    /** @type {string} */ rowId,
    /** @type {string} */ colId,
    /** @type {{ fromRowId: string, fromColId: string, toRowId: string, toColId: string } | null } */ range,
  ) => {
    if (!range) return false;
    const r1 = rowIndexById[range.fromRowId];
    const r2 = rowIndexById[range.toRowId];
    const c1 = colIndexById[range.fromColId];
    const c2 = colIndexById[range.toColId];
    const rr = rowIndexById[rowId];
    const cc = colIndexById[colId];
    if (
      !Number.isInteger(r1) ||
      !Number.isInteger(r2) ||
      !Number.isInteger(c1) ||
      !Number.isInteger(c2) ||
      !Number.isInteger(rr) ||
      !Number.isInteger(cc)
    )
      return false;
    const rMin = Math.min(r1, r2);
    const rMax = Math.max(r1, r2);
    const cMin = Math.min(c1, c2);
    const cMax = Math.max(c1, c2);
    return rr >= rMin && rr <= rMax && cc >= cMin && cc <= cMax;
  };

  const blockEdgeStyle = (
    /** @type {string} */ rowId,
    /** @type {string} */ colId,
    /** @type {{ fromRowId: string, fromColId: string, toRowId: string, toColId: string } | null } */ range,
  ) => {
    if (!range) return {};
    const r1 = rowIndexById[range.fromRowId];
    const r2 = rowIndexById[range.toRowId];
    const c1 = colIndexById[range.fromColId];
    const c2 = colIndexById[range.toColId];
    const rr = rowIndexById[rowId];
    const cc = colIndexById[colId];
    if (
      !Number.isInteger(r1) ||
      !Number.isInteger(r2) ||
      !Number.isInteger(c1) ||
      !Number.isInteger(c2) ||
      !Number.isInteger(rr) ||
      !Number.isInteger(cc)
    )
      return {};

    const rMin = Math.min(r1, r2);
    const rMax = Math.max(r1, r2);
    const cMin = Math.min(c1, c2);
    const cMax = Math.max(c1, c2);
    if (rr < rMin || rr > rMax || cc < cMin || cc > cMax) return {};

    return {
      borderTop: rr === rMin ? `2px solid ${HIGHLIGHT}` : undefined,
      borderBottom: rr === rMax ? `2px solid ${HIGHLIGHT}` : undefined,
      borderLeft: cc === cMin ? `2px solid ${HIGHLIGHT}` : undefined,
      borderRight: cc === cMax ? `2px solid ${HIGHLIGHT}` : undefined,
    };
  };

  const emit = (
    /** @type {string} */ action,
    /** @type {string=} */ path,
    /** @type {string=} */ ref,
    /** @type {any=} */ extra,
  ) => {
    if (!published(canvas, action)) return;
    onEvent({ action, path, ref, ...extra });
  };

  /** Inline channel paint for one body cell. */
  const cellStyle = (/** @type {string} */ rowId, /** @type {string} */ colId) => {
    const selected =
      isSelected(sel, 'cell', `${rowId}:${colId}`) ||
      isSelected(sel, 'row', rowId) ||
      isSelected(sel, 'column', colId);
    const cellKey = `${rowId}:${colId}`;
    const hovered = hover?.kind === 'cell' && hover.id === cellKey;
    const sharedEffect = sharedEffects.has(`cell/${rowId}/${colId}`);
    const coordinated = lit.has(`cell/${rowId}/${colId}`);
    const activeBlock = blockDrag ?? block;
    return {
      borderColor: !coordinated && (hovered || sharedEffect) ? HIGHLIGHT : undefined,
      outline: !coordinated && (hovered || sharedEffect) ? `2px solid ${HIGHLIGHT}` : undefined,
      outlineOffset: -2,
      backgroundColor: selected ? 'var(--abra-table-selection-fill)' : undefined,
      ...blockEdgeStyle(rowId, colId, activeBlock),
    };
  };

  const clearSelection = () => {
    if (!ix.isIdle()) return;
    for (const id of sel.ids) {
      if (sel.kind === 'cell') {
        const [rowId, colId] = id.split(':');
        emit('deselect_cell', `cell/${rowId}/${colId}`, byRowId[rowId]?.ref);
      } else if (sel.kind === 'row') emit('deselect_row', `row/${id}`, byRowId[id]?.ref);
      else if (sel.kind === 'column') emit('deselect_column', `col/${id}`);
    }
    emit('clear_selection');
    setSel(EMPTY_SELECTION);
    setHover(null);
    setBlock(null);
    setBlockDrag(null);
  };

  const clearBlockHighlight = () => {
    if (ix.is('block_drag')) return;
    setBlock(null);
    setBlockDrag(null);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: emit is a per-render closure; the listener re-registers on the drag state only
  useEffect(() => {
    const onMouseUp = () => {
      blockAnchorRef.current = null;
      if (!blockDrag) return;
      if (published(canvas, 'highlight_block')) {
        emit('highlight_block', undefined, undefined, {
          value: {
            from: `cell/${blockDrag.fromRowId}/${blockDrag.fromColId}`,
            to: `cell/${blockDrag.toRowId}/${blockDrag.toColId}`,
          },
        });
      }
      setBlock(blockDrag);
      setBlockDrag(null);
      ix.end('block_drag');
      suppressCellClickRef.current = true;
    };
    window.addEventListener('mouseup', onMouseUp);
    return () => window.removeEventListener('mouseup', onMouseUp);
  }, [blockDrag, canvas, ix]);

  const cycleSort = (/** @type {string} */ colId) => {
    if (!published(canvas, 'sort_rows_by_column')) return;
    const dir = localSort?.colId === colId ? nextSortDir(localSort.dir) : 'asc';
    const sort = dir ? { colId, dir } : null;
    setLocalSort(sort);
    // Sort is a presentation op: it writes config.presentation.sort and the view
    // derives the row order from it (no content / no rowOrder materialization).
    emit('sort_rows_by_column', `col/${colId}`, undefined, {
      value: { dir },
      config: { presentation: { sort } },
    });
  };

  const applyFilter = (/** @type {string} */ colId, /** @type {string} */ keyword) => {
    const filter = keyword ? { colId, keyword } : null;
    setLocalFilter(filter);
    emit('filter_rows_by_column', `col/${colId}`, undefined, {
      value: { keyword },
      config: { presentation: { filter } },
    });
  };

  const commitEdit = () => {
    if (!editing) return;
    const { rowId, colId, draft } = editing;
    ix.end('edit');
    setEditing(null);
    if (String(byRowId[rowId]?.[colId] ?? '') === draft) return;
    emit('edit_cell', `cell/${rowId}/${colId}`, byRowId[rowId]?.ref, {
      value: { value: draft },
      content: hasConsequence(canvas, 'edit_cell')
        ? undefined
        : { rows: { [rowId]: { [colId]: draft } } },
    });
  };

  const cancelEdit = () => {
    ix.end('edit');
    setEditing(null);
  };

  const startEdit = (/** @type {string} */ rowId, /** @type {string} */ colId) => {
    if (!published(canvas, 'edit_cell') || !ix.begin('edit')) return;
    setEditing({ rowId, colId, draft: String(byRowId[rowId]?.[colId] ?? '') });
  };

  // edit_column — rename a COLUMN. A distinct action from edit_cell: it targets the column
  // header (`col/<id>` → content.columns[colId].label), not a row cell, so it's its own
  // consequence. Double-click the header label to enter; Enter/blur commits, Esc cancels.
  const startColEdit = (/** @type {string} */ colId) => {
    if (!published(canvas, 'edit_column') || !ix.begin('edit')) return;
    const current = cols.find((c) => c.id === colId)?.label ?? colId;
    setHeaderEdit({ colId, draft: String(current) });
  };
  const commitColEdit = () => {
    if (!headerEdit) return;
    const { colId, draft } = headerEdit;
    ix.end('edit');
    setHeaderEdit(null);
    if (String(cols.find((c) => c.id === colId)?.label ?? colId) === draft) return;
    emit('edit_column', `col/${colId}`, undefined, {
      value: { label: draft },
      content: hasConsequence(canvas, 'edit_column')
        ? undefined
        : { columns: { [colId]: { label: draft } } },
    });
  };
  const cancelColEdit = () => {
    ix.end('edit');
    setHeaderEdit(null);
  };

  const reorderRow = (/** @type {string} */ rowId, /** @type {string} */ targetId) => {
    ix.end('drag');
    setDragRowId(null);
    setDragOverId(null);
    if (!rowId || rowId === targetId) return;
    const order = (localOrder?.length ? [...localOrder] : baseData.map((r) => r._id)).filter(
      (id) => id !== rowId,
    );
    const targetIndex = Math.max(0, order.indexOf(targetId));
    order.splice(targetIndex, 0, rowId);
    setLocalOrder(order); // instant view-local; reconciles from the broadcast
    emit('reorder_row', `row/${rowId}`, byRowId[rowId]?.ref, {
      value: { toIndex: targetIndex },
      config: hasConsequence(canvas, 'reorder_row') ? undefined : { presentation: { order } },
    });
  };

  // Delete key dispatches by what's selected: ROW/COLUMN → structural `delete` (element
  // removed); CELL/BLOCK → `clear` (values blanked to '', row/column structure kept).
  const deleteSelected = () => {
    if (!ix.isIdle()) return;

    if (sel.kind === 'row' || sel.kind === 'column') {
      for (const id of sel.ids) {
        if (sel.kind === 'row') {
          emit('delete', `row/${id}`, byRowId[id]?.ref, {
            content: hasConsequence(canvas, 'delete') ? undefined : { rows: { [id]: null } },
          });
        } else {
          const rowPatch = Object.fromEntries(baseData.map((r) => [r._id, { [id]: null }]));
          emit('delete', `col/${id}`, undefined, {
            content: hasConsequence(canvas, 'delete')
              ? undefined
              : { columns: { [id]: null }, rows: rowPatch },
          });
        }
      }
      setSel(EMPTY_SELECTION);
      return;
    }

    // CELL / BLOCK → clear the addressed cells' values (structure intact). The view
    // resolves the exact cell list (it knows the sort/filter order); the owner blanks them.
    /** @type {[string, string][]} */
    let cells = [];
    if (sel.kind === 'cell') {
      cells = sel.ids
        .map((id) => /** @type {[string, string]} */ (id.split(':')))
        .filter(([r, c]) => r && c);
    } else {
      const range = blockDrag ?? block;
      if (range) {
        for (const r of displayData) {
          for (const c of cols) {
            if (isWithinBlock(r._id, c.id, range)) cells.push([r._id, c.id]);
          }
        }
      }
    }
    if (cells.length) {
      /** @type {Record<string, Record<string, string>>} */
      const patch = {};
      for (const [r, c] of cells) {
        if (!patch[r]) patch[r] = {};
        patch[r][c] = '';
      }
      const [r0, c0] = cells[0];
      emit('clear', `cell/${r0}/${c0}`, sel.kind === 'cell' ? byRowId[r0]?.ref : undefined, {
        value: { cells },
        content: hasConsequence(canvas, 'clear') ? undefined : { rows: patch },
      });
    }
    setSel(EMPTY_SELECTION);
    setBlock(null);
    setBlockDrag(null);
  };

  // add_row / add_column: a thin "+" affordance at the bottom / right edge. Both are
  // DATA additions (content) → consequences (the owner mints the new row/column); the
  // view emits value-only when armed, falling back to a direct content write otherwise.
  const addRow = () => {
    if (!ix.isIdle()) return;
    const id = `r-${Date.now()}`;
    emit('add_row', undefined, undefined, {
      value: {},
      content: hasConsequence(canvas, 'add_row') ? undefined : { rows: { [id]: { _id: id } } },
    });
  };
  const addColumn = () => {
    if (!ix.isIdle()) return;
    const id = `c-${Date.now()}`;
    const col = { label: 'New column', type: 'string' };
    emit('add_column', undefined, undefined, {
      value: col,
      content: hasConsequence(canvas, 'add_column') ? undefined : { columns: { [id]: col } },
    });
  };

  // Built-in "+" slots: shown iff the action is published AND its binding doesn't opt out
  // of the default chrome (`default:false` → drive add_row/add_column only from a control).
  const showAddRow = chromeEnabled(canvas, 'add_row');
  const showAddColumn = chromeEnabled(canvas, 'add_column');

  // Honest-affordance cursors (derive.affordanceClass): the cursor tracks the published
  // binding per element, so an element with no bound action shows a plain arrow rather than
  // a false grab/click. reorder_row → grab, else select_row → pointer, else default.
  const canReorderRow = published(canvas, 'reorder_row');
  const rowHandleCursor = affordanceClass(canvas, [
    ['reorder_row', 'grab'],
    ['select_row', 'pointer'],
  ]);
  const cellCursor = affordanceClass(canvas, [
    ['select_cell', 'pointer'],
    ['edit_cell', 'text'],
    ['highlight_block', 'crosshair'],
  ]);
  const columnCursor = affordanceClass(canvas, [['select_column', 'pointer']]);

  const headerGroup = table.getHeaderGroups()[0];
  const bodyRows = table.getRowModel().rows;
  // Live reorder preview: while dragging, render the rows with the dragged one moved to the
  // hovered target slot (inserted BEFORE it — same as reorderRow commits), so the user sees
  // the resulting order before dropping. Not dragging → the real order.
  const renderRows =
    dragRowId && dragOverId && dragRowId !== dragOverId
      ? (() => {
          const rest = bodyRows.filter((r) => r.original._id !== dragRowId);
          const moved = bodyRows.find((r) => r.original._id === dragRowId);
          const to = rest.findIndex((r) => r.original._id === dragOverId);
          if (!moved || to < 0) return bodyRows;
          rest.splice(to, 0, moved);
          return rest;
        })()
      : bodyRows;

  return (
    <div
      className={`abra-table-wrap${ix.is('block_drag') ? ' is-block-dragging' : ''}`}
      role="application"
      aria-label="ABRA table"
      onMouseLeave={() => {
        clearBlockHighlight();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
      }}
    >
      <div className="abra-table-grid">
        {/* wrap the <table> in a block div so it's NOT a direct flex item — a <table>
            as a flex child mis-lays-out in narrow containers (cells collapse). The div
            is the flex item; the table lays out normally inside it. */}
        <div className="abra-table-scroll">
          <table className="abra-table">
            <thead>
              <tr>
                <th
                  className="abra-row-handle"
                  aria-label="clear selection"
                  onClick={clearSelection}
                />
                {headerGroup?.headers.map((h) => {
                  const colId = h.column.id;
                  const { selected, hovered, coordinated, sharedEffect } = elementFlags(
                    { sel, hover, lit, applied: sharedEffects },
                    'column',
                    colId,
                    `col/${colId}`,
                  );
                  // effective dir mirrors the sort application: a colId with no dir = 'asc'.
                  const sorted = localSort?.colId === colId ? (localSort.dir ?? 'asc') : null;
                  const filterActive = localFilter?.colId === colId && !!localFilter.keyword;
                  return (
                    <th
                      key={h.id}
                      className={`${columnCursor}${coordinated ? ' abra-coord' : ''}`}
                      style={{
                        borderTopColor:
                          !coordinated && (hovered || sharedEffect) ? HIGHLIGHT : undefined,
                        fontWeight: sorted ? 700 : undefined,
                        backgroundColor: selected
                          ? 'var(--abra-table-selection-surface)'
                          : undefined,
                      }}
                      onMouseEnter={() => {
                        if (!ix.isIdle()) return;
                        clearBlockHighlight();
                        if (published(canvas, 'highlight_column'))
                          setHover({ kind: 'column', id: colId });
                        emit('highlight_column', `col/${colId}`);
                      }}
                      onMouseLeave={() => {
                        if (!ix.isIdle()) return;
                        setHover(null);
                        emit('dehighlight_column', `col/${colId}`);
                      }}
                      onClick={() => {
                        if (!ix.isIdle() || !published(canvas, 'select_column')) return;
                        if (selected) emit('deselect_column', `col/${colId}`);
                        else emit('select_column', `col/${colId}`);
                        setSel((s) => toggleSelection(s, 'column', colId));
                      }}
                    >
                      <div className="abra-th-content">
                        <div className="abra-th-topline">
                          {headerEdit?.colId === colId ? (
                            <input
                              className="abra-th-edit"
                              // biome-ignore lint/a11y/noAutofocus: inline rename, focus on open
                              autoFocus
                              aria-label={`rename ${colId}`}
                              value={headerEdit.draft}
                              onChange={(e) =>
                                setHeaderEdit({ colId, draft: e.currentTarget.value })
                              }
                              onClick={(e) => e.stopPropagation()}
                              onMouseDown={(e) => e.stopPropagation()}
                              onBlur={commitColEdit}
                              onKeyDown={(e) => {
                                e.stopPropagation();
                                if (e.key === 'Enter') commitColEdit();
                                else if (e.key === 'Escape') cancelColEdit();
                              }}
                            />
                          ) : (
                            // biome-ignore lint/a11y/noStaticElementInteractions: double-click to rename, same pattern as the cell
                            <span
                              className="abra-th-label"
                              onDoubleClick={(e) => {
                                e.stopPropagation();
                                startColEdit(colId);
                              }}
                            >
                              {String(h.column.columnDef.header ?? colId)}
                            </span>
                          )}
                          {chromeEnabled(canvas, 'sort_rows_by_column') ? (
                            <button
                              className="abra-th-button"
                              type="button"
                              aria-label={`sort ${colId}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                cycleSort(colId);
                              }}
                            >
                              {sorted === 'asc' ? '↑' : sorted === 'desc' ? '↓' : '↕'}
                            </button>
                          ) : null}
                        </div>
                        {/* filter box on its OWN line below the label — never overlaps it */}
                        {chromeEnabled(canvas, 'filter_rows_by_column') ? (
                          <input
                            className={`abra-th-filter${filterActive ? ' is-active' : ''}`}
                            aria-label={`filter ${colId}`}
                            placeholder="Filter"
                            value={localFilter?.colId === colId ? localFilter.keyword : ''}
                            onChange={(e) => applyFilter(colId, e.currentTarget.value)}
                            onClick={(e) => e.stopPropagation()}
                            onMouseDown={(e) => e.stopPropagation()}
                            onKeyDown={(e) => {
                              e.stopPropagation();
                              if (e.key === 'Escape') applyFilter(colId, '');
                            }}
                          />
                        ) : null}
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {renderRows.map((row) => {
                const rowId = row.original._id;
                const ref = row.original.ref;
                const rowSelected = isSelected(sel, 'row', rowId);
                const rowHovered = hover?.kind === 'row' && hover.id === rowId;
                const rowCoordinated = (!!ref && lit.has(ref)) || lit.has(`row/${rowId}`);
                const rowSharedEffect = sharedEffects.has(ref ?? `row/${rowId}`);
                const rowDragging = rowId === dragRowId; // the row being dragged (dimmed in-place)
                return (
                  <tr
                    key={rowId}
                    className={rowDragging ? 'abra-row-dragging' : undefined}
                    onDragOver={(e) => {
                      if (!dragRowId) return;
                      e.preventDefault();
                      if (rowId !== dragRowId) setDragOverId(rowId); // live preview target
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      // commit against the TRACKED target (dragOverId), not this row's id —
                      // the live preview moves the dragged row under the cursor, so the drop
                      // target's own id is unreliable (often the dragged row → a no-op).
                      const from = e.dataTransfer.getData('text/plain') || dragRowId;
                      reorderRow(from, dragOverId ?? rowId);
                    }}
                  >
                    <td
                      className={`abra-row-handle${rowCoordinated ? ' abra-coord' : ''}`}
                      style={{
                        borderLeftColor:
                          !rowCoordinated && (rowHovered || rowSharedEffect)
                            ? HIGHLIGHT
                            : undefined,
                        backgroundColor: rowSelected
                          ? 'var(--abra-table-selection-surface)'
                          : undefined,
                      }}
                      onMouseEnter={() => {
                        if (!ix.isIdle()) return;
                        clearBlockHighlight();
                        if (published(canvas, 'highlight_row'))
                          setHover({ kind: 'row', id: rowId });
                        emit('highlight_row', `row/${rowId}`, ref);
                      }}
                      onMouseLeave={() => {
                        if (!ix.isIdle()) return;
                        setHover(null);
                        emit('dehighlight_row', `row/${rowId}`, ref);
                      }}
                    >
                      <button
                        className={`abra-row-handle-button ${rowHandleCursor}`}
                        type="button"
                        draggable={canReorderRow}
                        onDragStart={(e) => {
                          if (!published(canvas, 'reorder_row') || !ix.begin('drag')) return;
                          setDragRowId(rowId);
                          setHover(null);
                          e.dataTransfer.setData('text/plain', rowId);
                        }}
                        onDragEnd={() => {
                          ix.end('drag');
                          setDragRowId(null);
                          setDragOverId(null);
                        }}
                        onClick={() => {
                          if (!ix.isIdle() || !published(canvas, 'select_row')) return;
                          if (rowSelected) emit('deselect_row', `row/${rowId}`, ref);
                          else emit('select_row', `row/${rowId}`, ref);
                          setSel((s) => toggleSelection(s, 'row', rowId));
                        }}
                      >
                        ⠿
                      </button>
                    </td>
                    {row.getVisibleCells().map((cell) => {
                      const colId = cell.column.id;
                      const cellSelected = isSelected(sel, 'cell', `${rowId}:${colId}`);
                      const cellCoordinated = lit.has(`cell/${rowId}/${colId}`);
                      const isEditing = editing?.rowId === rowId && editing.colId === colId;
                      return (
                        <td
                          key={cell.id}
                          className={`abra-cell${cellCoordinated ? ' abra-coord' : ''}${isEditing ? ' is-editing' : ''}`}
                          style={cellStyle(rowId, colId)}
                          onMouseEnter={() => {
                            const activeBlock = blockDrag ?? block;
                            if (ix.is('block_drag') && blockDrag) {
                              setBlockDrag({ ...blockDrag, toRowId: rowId, toColId: colId });
                              return;
                            }
                            if (
                              blockAnchorRef.current &&
                              published(canvas, 'highlight_block') &&
                              (blockAnchorRef.current.rowId !== rowId ||
                                blockAnchorRef.current.colId !== colId) &&
                              ix.begin('block_drag')
                            ) {
                              setBlockDrag({
                                fromRowId: blockAnchorRef.current.rowId,
                                fromColId: blockAnchorRef.current.colId,
                                toRowId: rowId,
                                toColId: colId,
                              });
                              return;
                            }
                            if (!ix.isIdle()) return;
                            if (activeBlock && isWithinBlock(rowId, colId, activeBlock)) {
                              setHover(null);
                              return;
                            }
                            if (activeBlock && !isWithinBlock(rowId, colId, activeBlock)) {
                              clearBlockHighlight();
                            }
                            if (published(canvas, 'highlight_cell'))
                              setHover({ kind: 'cell', id: `${rowId}:${colId}` });
                            emit('highlight_cell', `cell/${rowId}/${colId}`, ref);
                          }}
                          onMouseLeave={() => {
                            if (!ix.isIdle()) return;
                            const activeBlock = blockDrag ?? block;
                            if (activeBlock && isWithinBlock(rowId, colId, activeBlock)) {
                              setHover(null);
                              return;
                            }
                            setHover(null);
                            emit('dehighlight_cell', `cell/${rowId}/${colId}`, ref);
                          }}
                        >
                          {isEditing ? (
                            <input
                              ref={(node) => node?.focus()}
                              className="abra-cell-editor"
                              value={editing.draft}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) =>
                                setEditing({ ...editing, draft: e.currentTarget.value })
                              }
                              onBlur={commitEdit}
                              onKeyDown={(e) => {
                                e.stopPropagation();
                                if (e.key === 'Enter') commitEdit();
                                if (e.key === 'Escape') cancelEdit();
                              }}
                            />
                          ) : (
                            <button
                              className={`abra-cell-button ${cellCursor}`}
                              type="button"
                              onMouseDown={(e) => {
                                if (!published(canvas, 'highlight_block') || e.button !== 0) return;
                                blockAnchorRef.current = { rowId, colId };
                              }}
                              onClick={() => {
                                if (suppressCellClickRef.current) {
                                  suppressCellClickRef.current = false;
                                  return;
                                }
                                if (!ix.isIdle() || !published(canvas, 'select_cell')) return;
                                if (cellSelected)
                                  emit('deselect_cell', `cell/${rowId}/${colId}`, ref);
                                else emit('select_cell', `cell/${rowId}/${colId}`, ref);
                                setSel((s) => toggleSelection(s, 'cell', `${rowId}:${colId}`));
                              }}
                              onDoubleClick={() => startEdit(rowId, colId)}
                            >
                              {String(cell.getValue() ?? '')}
                            </button>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              {showAddRow ? (
                <tr className="abra-add-row">
                  <td className="abra-add-row-cell" colSpan={1 + cols.length}>
                    <button type="button" aria-label="add row" title="Add row" onClick={addRow}>
                      +
                    </button>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {showAddColumn ? (
          <button
            type="button"
            className="abra-col-add"
            aria-label="add column"
            title="Add column"
            onClick={addColumn}
          >
            +
          </button>
        ) : null}
      </div>
    </div>
  );
}
