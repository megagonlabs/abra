/**
 * GraphView — controlled-mirror graph (React-Flow @xyflow/react v12 + dagre).
 *
 * Pure render of `canvas`: nodes/edges derived from id-keyed content; view-private
 * channels painted inline per the view manifest (actionPresentation.json) — highlight = border/stroke, selection =
 * opacity (default 0.6 -> selected 1). Edge strokeWidth remains reserved for
 * encoding, so hover never overwrites width. The NODE/EDGE coordination_channel
 * (animated border / strokeDasharray) is read from `canvas.highlight`. Handlers emit CANVAS_EVENT intents (gated on
 * the published binding) via `onEvent` — never mutating the replica.
 *
 * React-Flow is kept as a *controlled* graph via useNodesState/useEdgesState:
 * derived data is reconciled INTO the existing nodes (preserving id + measured
 * size + position) rather than replaced wholesale, so a re-render never remounts
 * a node under the cursor (which would re-fire hover and flood events). Hover
 * emits are also deduped to the actually-hovered element.
 */
import dagre from '@dagrejs/dagre';
import {
  Background,
  ConnectionMode,
  Controls,
  Handle,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
} from 'd3-force';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  affordanceClass,
  appliedEffectKeys,
  coordinatedKeys,
  EMPTY_SELECTION,
  elementFlags,
  encoding,
  hasConsequence,
  isSelected,
  linear,
  nominalColor,
  published,
  rows,
  toggleSelection,
} from '../shared/derive.js';
import { useInteractionManager } from '../shared/interaction.js';
import { FloatingConnectionLine } from './FloatingConnectionLine.jsx';
import { FloatingEdge } from './FloatingEdge.jsx';
import '../views.css';

const NODE_W = 130;
const NODE_H = 36;
const DEFAULT_OPACITY = 0.6;
const SELECTED_OPACITY = 1;
const HIGHLIGHT = '#f59e0b';
const COORDINATION = '#111111';
const NODE_FALLBACK_PALETTE = [
  '#8ecae6',
  '#83c5be',
  '#b8c0ff',
  '#a7f3d0',
  '#c4b5fd',
  '#93c5fd',
  '#99f6e4',
  '#f0abfc',
];

function fallbackNodeColor(/** @type {string} */ id) {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return NODE_FALLBACK_PALETTE[hash % NODE_FALLBACK_PALETTE.length];
}

/** Custom node: paints view-private channels inline + the animated coordination border. */
function AbraNode({ data }) {
  return (
    // `nopan`: a drag that STARTS on a node must not pan the pane — an element hit swallows
    // the surface gesture (node-drag itself, when reposition_node is bound, still works via
    // React Flow's own node-drag system). `cursorClass`: honest per-binding cursor.
    // biome-ignore lint/a11y/noStaticElementInteractions: a React Flow node (inherently interactive); dblclick-to-edit is a viewer affordance
    <div
      className={`abra-node nopan ${data.cursorClass ?? 'abra-cur-default'}${data.coordinated ? ' abra-coord' : ''}`}
      style={data.style}
      onDoubleClick={(e) => {
        // edit entry rides the node's OWN dblclick — independent of React Flow's
        // draggable-gated onNodeDoubleClick + the pane's zoom-on-dblclick.
        e.stopPropagation();
        if (!data.editing) data.onEdit?.();
      }}
    >
      {/* invisible connect zones along each EDGE (grab the border to connect); the
          centre stays drag-to-move + click-to-select. Loose mode → any edge ↔ any edge. */}
      <Handle
        id="t"
        type="source"
        position={Position.Top}
        className="abra-node-handle abra-node-handle-h"
        isConnectable={data.connectable}
      />
      <Handle
        id="b"
        type="source"
        position={Position.Bottom}
        className="abra-node-handle abra-node-handle-h"
        isConnectable={data.connectable}
      />
      <Handle
        id="l"
        type="source"
        position={Position.Left}
        className="abra-node-handle abra-node-handle-v"
        isConnectable={data.connectable}
      />
      <Handle
        id="r"
        type="source"
        position={Position.Right}
        className="abra-node-handle abra-node-handle-v"
        isConnectable={data.connectable}
      />
      {data.editing ? (
        <input
          className="abra-node-editor"
          ref={(el) => el?.focus()}
          defaultValue={data.label}
          style={{
            width: '90%',
            font: 'inherit',
            color: 'inherit',
            textAlign: 'center',
            border: 'none',
            background: 'rgba(0, 0, 0, 0.25)',
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') data.onCommit?.(e.currentTarget.value);
            else if (e.key === 'Escape') data.onCancel?.();
          }}
          onBlur={(e) => data.onCommit?.(e.currentTarget.value)}
        />
      ) : (
        data.label
      )}
    </div>
  );
}
const nodeTypes = { abra: AbraNode };
// Floating edges (border-to-border bezier) + a floating connection preview, so an
// edge / the in-progress connection never snap to a handle point — restored from the
// pre-rebuild implementation. The invisible edge-handles only *initiate* a connect.
const edgeTypes = { floating: FloatingEdge };

/** Lay nodes out top-down with dagre (hierarchical). */
function layoutDagre(/** @type {any[]} */ ns, /** @type {any[]} */ es) {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'TB', nodesep: 48, ranksep: 64 });
  for (const n of ns) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of es) if (e.source && e.target) g.setEdge(e.source, e.target);
  dagre.layout(g);
  /** @type {Record<string, { x: number, y: number }>} */
  const pos = {};
  for (const n of ns) {
    const p = g.node(n.id);
    pos[n.id] = p ? { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 } : { x: 0, y: 0 };
  }
  return pos;
}

/**
 * Force-directed layout via d3-force. Deterministic: d3-force@3 seeds nodes on a fixed
 * phyllotaxis spiral and defaults to a seeded LCG (not Math.random), so a fixed tick
 * count yields the same positions every render (controlled-mirror safe). many-body
 * repulsion + link distance + collision + weak centering splay leaves into a genuine 2D
 * spread (a plain Fruchterman–Reingold collapses tree/path graphs into a line).
 */
function layoutForce(/** @type {any[]} */ ns, /** @type {any[]} */ es) {
  /** @type {Record<string, { x: number, y: number }>} */
  const pos = {};
  if (ns.length === 0) return pos;
  const nodes = ns.map((n) => ({ id: n.id }));
  const links = es
    .filter((e) => e.source && e.target)
    .map((e) => ({ source: e.source, target: e.target }));
  // Tuned for a COMPACT spread: weaker repulsion + shorter links + firmer centering pull the
  // nodes closer, while `collide` (a hard radius per node) still stops label overlap — so the
  // graph reads as a tight cluster, not a sparse scatter.
  const sim = forceSimulation(nodes)
    .force('charge', forceManyBody().strength(-420))
    .force(
      'link',
      forceLink(links)
        .id((/** @type {any} */ d) => d.id)
        .distance(95)
        .strength(1),
    )
    .force('center', forceCenter(0, 0))
    .force('collide', forceCollide(Math.max(NODE_W, NODE_H) * 0.62))
    .force('x', forceX(0).strength(0.12))
    .force('y', forceY(0).strength(0.12))
    .stop();
  sim.tick(400); // run to a stable state synchronously (no animation)
  // Nodes are WIDE (long labels) so they need horizontal room but little vertical room. The
  // collide radius is width-based (isotropic), which over-reserves vertical space — so squash
  // the y-axis afterwards to pack rows tighter while keeping the horizontal spread. The gaps
  // still clear NODE_H, so labels never overlap.
  const Y_SQUASH = 0.58;
  for (const n of /** @type {any[]} */ (nodes)) pos[n.id] = { x: n.x, y: n.y * Y_SQUASH };
  return pos;
}

/**
 * Group nodes into labelled columns by a field — POSITION encodes the category
 * (a "layout-as-encoding": x = which group, so clusters read as data, not just
 * readability). Fields appear in first-seen order; nodes stack within their column.
 */
function layoutGroup(/** @type {any[]} */ ns, /** @type {string} */ groupBy) {
  /** @type {string[]} */
  const order = [];
  /** @type {Map<string, any[]>} */
  const buckets = new Map();
  for (const n of ns) {
    const key = String(n[groupBy] ?? '—');
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
      order.push(key);
    }
    bucket.push(n);
  }
  const COL_W = 220;
  const ROW_H = 66;
  /** @type {Record<string, { x: number, y: number }>} */
  const pos = {};
  order.forEach((key, gi) => {
    (buckets.get(key) ?? []).forEach((n, ri) => {
      pos[n.id] = { x: gi * COL_W, y: ri * ROW_H };
    });
  });
  return pos;
}

/** Pick the layout engine by the shared presentation lens (default: force). */
function layout(
  /** @type {any[]} */ ns,
  /** @type {any[]} */ es,
  /** @type {string} */ mode,
  /** @type {string} */ groupBy,
) {
  if (mode === 'dagre') return layoutDagre(ns, es);
  if (mode === 'group') return layoutGroup(ns, groupBy);
  return layoutForce(ns, es);
}

export function GraphView({ canvas, onEvent, viewportApiRef }) {
  const nodes = rows(canvas.content?.nodes);
  const edges = rows(canvas.content?.edges);
  const [rfNodes, setNodes, onNodesChange] = useNodesState([]);
  const [rfEdges, setEdges, onEdgesChange] = useEdgesState([]);
  const graphRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const rfRef = useRef(/** @type {import('@xyflow/react').ReactFlowInstance | null} */ (null));
  const [hover, setHover] = useState(/** @type {{ kind: string, id: string } | null} */ (null));
  const [sel, setSel] = useState(EMPTY_SELECTION);
  const hoverRef = useRef(/** @type {{ kind: string, id: string } | null} */ (null));
  const longHoverTimerRef = useRef(/** @type {ReturnType<typeof setTimeout> | null} */ (null));
  const viewportRef = useRef(/** @type {{ x: number, y: number, zoom: number } | null} */ (null));
  const [detailCard, setDetailCard] = useState(
    /** @type {{ id: string, x: number, y: number, title: string, referent: string | null, connections: string } | null} */ (
      null
    ),
  );
  const ix = useInteractionManager();

  // Register imperative VIEWPORT commands so a header control (fit_all) can invoke them
  // locally via CanvasPanel — viewport is client-local, no round-trip. The closure reads
  // rfRef at call time (after onInit), so registering once is fine.
  useEffect(() => {
    if (!viewportApiRef) return undefined;
    viewportApiRef.current = {
      fit_all: () => rfRef.current?.fitView({ duration: 300, padding: 0.2 }),
    };
    return () => {
      viewportApiRef.current = null;
    };
  }, [viewportApiRef]);
  // Inline node-label edit: `editing` holds the node id whose label is open in an
  // inline input (no blocking prompt). The input lives in the custom node; commit/
  // cancel run through a stable ref so the reconciled node `data` never carries a
  // stale closure.
  const [editing, setEditing] = useState(/** @type {string | null} */ (null));
  const editRef = useRef(
    /** @type {{ commit: (id: string, v: string) => void, cancel: () => void }} */ ({
      commit: () => {},
      cancel: () => {},
    }),
  );

  const layoutMode = canvas.config?.presentation?.layout ?? 'force';
  const groupBy = canvas.config?.presentation?.groupBy ?? 'field';
  // node positions are PRESENTATION (a `reposition_node` writes config.presentation.positions,
  // keyed by node id) — a per-node override on the computed layout, never content.
  const posOverride = canvas.config?.presentation?.positions ?? {};
  // layoutKey identifies the layout *result* (mode + its params) — a switch snaps + re-fits.
  const layoutKey = layoutMode === 'group' ? `group:${groupBy}` : layoutMode;
  const topoKey = `${layoutKey}|${nodes.map((n) => n.id).join(',')}|${edges
    .map((e) => `${e.id}:${e.source}>${e.target}`)
    .join(',')}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: layout depends only on topology + mode (topoKey)
  const positions = useMemo(() => layout(nodes, edges, layoutMode, groupBy), [topoKey]);
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const edgeById = Object.fromEntries(edges.map((e) => [e.id, e]));

  const lit = coordinatedKeys(canvas);
  const sharedEffects = appliedEffectKeys(canvas);
  const litKey = [...lit].sort().join(',');
  const appliedKey = [...sharedEffects].sort().join(',');
  const enc = encoding(canvas);
  const fillEnc = enc['node.fill'];
  const widthEnc = enc['edge.strokeWidth'];
  const hoverKey = hover ? `${hover.kind}:${hover.id}` : '';
  const selKey = `${sel.kind}:${sel.ids.join(',')}`;
  const canReposition = published(canvas, 'reposition_node');
  const canConnect = published(canvas, 'add_edge');
  // honest node cursor: grab if the node can be moved, else pointer if it can be selected,
  // else the default arrow (config.actions is immutable, so this is constant per canvas).
  const nodeCursor = affordanceClass(canvas, [
    ['reposition_node', 'grab'],
    ['select_node', 'pointer'],
  ]);
  // On a layout-mode switch, snap ALL nodes to the fresh layout; on a topology-only
  // change keep existing node positions (new nodes still take the computed slot).
  const prevLayoutRef = useRef(layoutKey);

  // Reconcile derived data INTO the existing React-Flow nodes (keep id + measured
  // + position; only data/style change), so no node remounts on a re-render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reconcile on derived-visual change only
  useEffect(() => {
    const relayout = prevLayoutRef.current !== layoutKey;
    prevLayoutRef.current = layoutKey;
    setNodes((prev) => {
      const prevById = Object.fromEntries(prev.map((n) => [n.id, n]));
      return nodes.map((n) => {
        const old = prevById[n.id];
        const { selected, hovered, coordinated, sharedEffect } = elementFlags(
          { sel, hover, lit, applied: sharedEffects },
          'node',
          n.id,
          n.ref ?? `node/${n.id}`,
        );
        const baseFill = nominalColor(fillEnc, n) ?? fallbackNodeColor(n.id);
        return {
          ...(old ?? {}),
          id: n.id,
          type: 'abra',
          position: (relayout ? positions[n.id] : old?.position) ??
            posOverride[n.id] ??
            positions[n.id] ?? { x: 0, y: 0 },
          draggable: canReposition,
          selectable: false,
          connectable: canConnect,
          data: {
            label: n.label ?? n.id,
            coordinated,
            connectable: canConnect,
            cursorClass: nodeCursor,
            editing: editing === n.id,
            onEdit: () => editRef.current.start(n.id),
            onCommit: (/** @type {string} */ v) => editRef.current.commit(n.id, v),
            onCancel: () => editRef.current.cancel(),
            style: {
              background: baseFill,
              borderColor: !coordinated && (hovered || sharedEffect) ? HIGHLIGHT : undefined,
              opacity: selected ? SELECTED_OPACITY : DEFAULT_OPACITY,
            },
          },
        };
      });
    });
  }, [topoKey, hoverKey, selKey, litKey, appliedKey, canReposition, canConnect, editing]);

  // Re-fit the viewport after a layout-mode switch: the reconcile above moves nodes to
  // the new layout, but `fitView` only frames on mount — without this the new positions
  // land off-centre (compact dagre vs. spread force) and read as the "wrong" layout. rAF
  // waits for the moved nodes to commit into the React-Flow store before framing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-fit on layout-mode change only
  useEffect(() => {
    const raf = requestAnimationFrame(() =>
      rfRef.current?.fitView({ duration: 300, padding: 0.2 }),
    );
    return () => cancelAnimationFrame(raf);
  }, [layoutKey]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reconcile on derived-visual change only
  useEffect(() => {
    setEdges(() =>
      edges.map((e) => {
        const { selected, hovered, coordinated, sharedEffect } = elementFlags(
          { sel, hover, lit, applied: sharedEffects },
          'edge',
          e.id,
          e.ref ?? `edge/${e.id}`,
        );
        const baseStroke = '#5b6b8c';
        return {
          id: e.id,
          type: 'floating',
          source: e.source,
          target: e.target,
          ref: e.ref,
          label: e.label,
          animated: coordinated,
          style: {
            opacity: selected ? SELECTED_OPACITY : DEFAULT_OPACITY,
            stroke: coordinated ? COORDINATION : hovered || sharedEffect ? HIGHLIGHT : baseStroke,
            strokeWidth: linear(widthEnc, e) ?? 1,
            strokeDasharray: coordinated ? '6 4' : undefined,
          },
        };
      }),
    );
  }, [topoKey, hoverKey, selKey, litKey, appliedKey]);

  const emit = (
    /** @type {string} */ action,
    /** @type {string=} */ path,
    /** @type {string=} */ ref,
    /** @type {any=} */ extra,
  ) => {
    if (!published(canvas, action)) return;
    onEvent({ action, path, ref, ...extra });
  };

  /** Emit the dehighlight for whatever element is currently hovered (if any). */
  const dehighlightCurrent = () => {
    const cur = hoverRef.current;
    if (!cur) return;
    if (cur.kind === 'node') emit('dehighlight_node', `node/${cur.id}`, byId[cur.id]?.ref);
    else if (cur.kind === 'edge') emit('dehighlight_edge', `edge/${cur.id}`);
  };

  const clearLongHover = () => {
    if (longHoverTimerRef.current) {
      clearTimeout(longHoverTimerRef.current);
      longHoverTimerRef.current = null;
    }
    setDetailCard(null);
  };

  const armLongHover = (
    /** @type {string} */ nodeId,
    /** @type {number} */ x,
    /** @type {number} */ y,
  ) => {
    if (!published(canvas, 'show_node_detail')) return;
    if (longHoverTimerRef.current) clearTimeout(longHoverTimerRef.current);
    longHoverTimerRef.current = setTimeout(() => {
      const rect = graphRef.current?.getBoundingClientRect();
      const relX = rect ? x - rect.left : x;
      const relY = rect ? y - rect.top : y;
      const node = byId[nodeId];
      emit('show_node_detail', `node/${nodeId}`, node?.ref);
      // Card content derives from the replica at hover time (label · referent · neighbors) —
      // detail is never stored in content, so nothing needs precomputing agent-side.
      const neighbors = edges
        .filter((e) => e.source === nodeId || e.target === nodeId)
        .map((e) => byId[e.source === nodeId ? e.target : e.source]?.label)
        .filter(Boolean);
      setDetailCard({
        id: nodeId,
        x: relX + 6,
        y: relY + 6,
        title: node?.label ?? nodeId,
        referent: node?.ref ? (node.refType ? `${node.refType} · ${node.ref}` : node.ref) : null,
        connections: neighbors.length
          ? `${neighbors.length} connection${neighbors.length === 1 ? '' : 's'}: ` +
            `${neighbors.slice(0, 4).join(', ')}${neighbors.length > 4 ? ', …' : ''}`
          : 'no connections',
      });
      longHoverTimerRef.current = null;
    }, 450);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: unmount cleanup only; clearLongHover is a per-render closure over a ref
  useEffect(() => () => clearLongHover(), []);

  const enterNode = (/** @type {any} */ _e, /** @type {any} */ node) => {
    if (!ix.isIdle()) return;
    const cur = hoverRef.current;
    if (cur?.kind === 'node' && cur.id === node.id) return; // already hovering — dedupe
    dehighlightCurrent(); // dehighlight-before-highlight
    hoverRef.current = { kind: 'node', id: node.id };
    // local highlight paint fires ONLY if the hover action is bound (else an unpublished
    // gesture would still paint its local_effect).
    if (published(canvas, 'highlight_node')) setHover({ kind: 'node', id: node.id });
    emit('highlight_node', `node/${node.id}`, byId[node.id]?.ref);
    armLongHover(node.id, _e.clientX ?? 0, _e.clientY ?? 0);
  };
  const leaveNode = (/** @type {any} */ _e, /** @type {any} */ node) => {
    if (!ix.isIdle()) return;
    const cur = hoverRef.current;
    if (cur?.kind !== 'node' || cur.id !== node.id) return; // stale leave — ignore
    hoverRef.current = null;
    setHover(null);
    emit('dehighlight_node', `node/${node.id}`, byId[node.id]?.ref);
    clearLongHover();
  };
  const clickNode = (/** @type {any} */ _e, /** @type {any} */ node) => {
    if (!ix.isIdle()) return;
    clearLongHover();
    const ref = byId[node.id]?.ref;
    if (!published(canvas, 'select_node')) return; // no selection local_effect if unbound
    if (isSelected(sel, 'node', node.id)) emit('deselect_node', `node/${node.id}`, ref);
    else emit('select_node', `node/${node.id}`, ref);
    setSel((s) => toggleSelection(s, 'node', node.id));
  };

  const enterEdge = (/** @type {any} */ _e, /** @type {any} */ edge) => {
    if (!ix.isIdle()) return;
    clearLongHover();
    const cur = hoverRef.current;
    if (cur?.kind === 'edge' && cur.id === edge.id) return;
    dehighlightCurrent();
    hoverRef.current = { kind: 'edge', id: edge.id };
    if (published(canvas, 'highlight_edge')) setHover({ kind: 'edge', id: edge.id });
    emit('highlight_edge', `edge/${edge.id}`, edge.ref);
  };
  const leaveEdge = (/** @type {any} */ _e, /** @type {any} */ edge) => {
    if (!ix.isIdle()) return;
    const cur = hoverRef.current;
    if (cur?.kind !== 'edge' || cur.id !== edge.id) return;
    hoverRef.current = null;
    setHover(null);
    emit('dehighlight_edge', `edge/${edge.id}`, edge.ref);
  };
  const clickEdge = (/** @type {any} */ _e, /** @type {any} */ edge) => {
    if (!ix.isIdle()) return;
    if (!published(canvas, 'select_edge')) return; // no selection local_effect if unbound
    if (isSelected(sel, 'edge', edge.id)) emit('deselect_edge', `edge/${edge.id}`, edge.ref);
    else emit('select_edge', `edge/${edge.id}`, edge.ref);
    setSel((s) => toggleSelection(s, 'edge', edge.id));
  };

  const clearSelection = () => {
    if (!ix.isIdle()) return;
    for (const id of sel.ids) {
      if (sel.kind === 'node') emit('deselect_node', `node/${id}`, byId[id]?.ref);
      else if (sel.kind === 'edge') emit('deselect_edge', `edge/${id}`);
    }
    emit('clear_selection');
    setSel(EMPTY_SELECTION);
    clearLongHover();
  };

  // one structural `delete` across element kinds — the path (node/edge) says which.
  // Deleting a node also nulls its incident edges (else content keeps dangling edges).
  const removeSelected = () => {
    if (!ix.isIdle()) return;
    for (const id of sel.ids) {
      if (sel.kind === 'node') {
        const incident = edges.filter((e) => e.source === id || e.target === id);
        const edgeNulls = Object.fromEntries(incident.map((e) => [e.id, null]));
        const extra = hasConsequence(canvas, 'delete')
          ? undefined
          : {
              content: {
                nodes: { [id]: null },
                ...(incident.length ? { edges: edgeNulls } : {}),
              },
            };
        emit('delete', `node/${id}`, byId[id]?.ref, extra);
      } else if (sel.kind === 'edge') {
        const extra = hasConsequence(canvas, 'delete')
          ? undefined
          : { content: { edges: { [id]: null } } };
        emit('delete', `edge/${id}`, edgeById[id]?.ref, extra);
      }
    }
    setSel(EMPTY_SELECTION);
  };

  // double_click enters inline edit mode (reusable viewer behavior); the agent-bound
  // action is the COMMIT (Enter) carrying the new label (edit_node in the graph manifest). This rides
  // the node's OWN dblclick (AbraNode), NOT React Flow's onNodeDoubleClick — that path is
  // gated by draggable + the pane's zoom-on-dblclick, so edit_node would silently break
  // unless reposition_node happened to also be bound (draggable).
  const startEdit = (/** @type {string} */ nodeId) => {
    if (!ix.isIdle() || !published(canvas, 'edit_node') || !ix.begin('edit')) return;
    setEditing(nodeId);
  };
  const commitNodeEdit = (/** @type {string} */ nodeId, /** @type {string} */ value) => {
    if (!ix.is('edit')) return; // Enter already committed / Escape cancelled
    ix.end('edit');
    setEditing(null);
    const current = byId[nodeId]?.label ?? nodeId;
    if (value == null || value === current) return;
    emit('edit_node', `node/${nodeId}`, byId[nodeId]?.ref, {
      value: { label: value },
      content: hasConsequence(canvas, 'edit_node')
        ? undefined
        : { nodes: { [nodeId]: { label: value } } },
    });
  };
  const cancelNodeEdit = () => {
    ix.end('edit');
    setEditing(null);
  };
  editRef.current.start = startEdit;
  editRef.current.commit = commitNodeEdit;
  editRef.current.cancel = cancelNodeEdit;

  const onNodeDragStart = () => {
    if (!published(canvas, 'reposition_node')) return;
    dehighlightCurrent();
    hoverRef.current = null;
    setHover(null);
    ix.begin('drag');
    clearLongHover();
  };

  const onNodeDragStop = (/** @type {any} */ _e, /** @type {any} */ node) => {
    ix.end('drag');
    const x = Math.round(node.position.x);
    const y = Math.round(node.position.y);
    emit('reposition_node', `node/${node.id}`, byId[node.id]?.ref, {
      value: { x, y },
      // positions are PRESENTATION — an ungated config.presentation patch (keyed-merged by
      // node id), forwarded like any presentation op; never a content write.
      config: { presentation: { positions: { [node.id]: { x, y } } } },
    });
  };

  const onConnect = (/** @type {{ source?: string, target?: string }} */ conn) => {
    if (
      !published(canvas, 'add_edge') ||
      !conn.source ||
      !conn.target ||
      conn.source === conn.target
    )
      return;
    emit('add_edge', undefined, undefined, {
      value: { from: `node/${conn.source}`, to: `node/${conn.target}` },
    });
  };

  const onMoveEnd = (
    /** @type {any} */ _e,
    /** @type {{ x: number, y: number, zoom: number }} */ viewport,
  ) => {
    const prev = viewportRef.current;
    viewportRef.current = viewport;
    if (!prev) return;
    const dx = Math.round(viewport.x - prev.x);
    const dy = Math.round(viewport.y - prev.y);
    if ((dx || dy) && published(canvas, 'pan'))
      emit('pan', undefined, undefined, { value: { dx, dy } });
    if (Math.abs(viewport.zoom - prev.zoom) > 0.001 && published(canvas, 'zoom')) {
      emit('zoom', undefined, undefined, { value: { zoom: viewport.zoom } });
    }
  };

  return (
    <div ref={graphRef} className="abra-graph" style={{ height: '100%', minHeight: 0 }}>
      <ReactFlow
        key={canvas.canvasId}
        onInit={(inst) => {
          rfRef.current = inst;
        }}
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        style={{
          '--xy-selection-border': 'none',
          '--xy-selection-background-color': 'transparent',
          '--xy-node-boxshadow-selected': 'none',
        }}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        fitView
        nodesDraggable={canReposition}
        zoomOnDoubleClick={false}
        nodesConnectable={canConnect}
        connectionMode={ConnectionMode.Loose}
        connectionLineComponent={FloatingConnectionLine}
        connectionRadius={10}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        selectionOnDrag={false}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Delete' || e.key === 'Backspace') removeSelected();
        }}
        proOptions={{ hideAttribution: true }}
        onNodeMouseEnter={enterNode}
        onNodeMouseLeave={leaveNode}
        onNodeClick={clickNode}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        onEdgeMouseEnter={enterEdge}
        onEdgeMouseLeave={leaveEdge}
        onEdgeClick={clickEdge}
        onConnect={onConnect}
        onMoveEnd={onMoveEnd}
        onPaneClick={clearSelection}
      >
        <Background color="#dfe3eb" gap={18} />
        <Controls showInteractive={false} />
      </ReactFlow>
      {detailCard ? (
        <div className="abra-node-detail" style={{ left: detailCard.x, top: detailCard.y }}>
          <div>{detailCard.title}</div>
          {detailCard.referent ? <div>{detailCard.referent}</div> : null}
          <div>{detailCard.connections}</div>
        </div>
      ) : null}
    </div>
  );
}
