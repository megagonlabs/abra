// @ts-check
/**
 * Scripted session state for the deterministic e2e harness — a fixed SNAPSHOT the
 * mock-hub replays on every JOIN. Two canvases (graph + table) share researcher
 * `ref`s (p:alice / p:bob) so cross-view brushing is exercisable; two agents post
 * chat so the per-agent bubble coloring is exercisable.
 *
 * This replaces the live LLM cast with a byte-stable script, so the demo client's
 * FULL path (WS → store → views/chat/shell) is testable without any nondeterminism.
 */

/** A full replica canvas (defaults spelled out — the mock is authoritative). */
function canvas(id, view, owner, content, config) {
  return {
    canvasId: id,
    owner,
    view,
    title: config.title ?? id,
    content,
    config: {
      actions: config.actions ?? {},
      presentation: config.presentation ?? {},
      controls: config.controls ?? [],
    },
    mode: 'exclusive',
    display: 'inline',
    closed: false,
    lock: null,
    pending: {},
    highlight: {},
    appliedEffects: {},
    rev: 1,
  };
}

const GRAPH = canvas(
  'g1',
  'graph',
  'agent:alice',
  {
    nodes: {
      n1: { label: 'Alice Ng', ref: 'p:alice' },
      n2: { label: 'Bob Lee', ref: 'p:bob' },
    },
    edges: { e1: { source: 'n1', target: 'n2', label: 'co-authored' } },
  },
  {
    title: 'Collaboration graph',
    actions: {
      highlight_node: { meaning: 'preview who this researcher works with' },
      dehighlight_node: { meaning: 'release the preview' },
      select_node: { meaning: 'pick the canonical record', label: 'Canonical' },
      deselect_node: { meaning: 'step back to the whole network' },
      // consequence actions (structural) + a controller that fires one → the +Node round-trip
      add_node: { meaning: 'add a researcher the import missed', label: 'Add node' },
      // a ref-bearing consequence: add_edge's value {from,to} must name REAL nodes (referential)
      add_edge: { meaning: 'link two researchers who collaborated' },
      delete: { meaning: 'remove a spurious node or link' },
    },
    controls: [
      {
        id: 'add_node_btn',
        type: 'button',
        label: '+ Node',
        meaning: 'add a researcher node',
        fires: 'add_node',
      },
    ],
  },
);

const TABLE = canvas(
  't1',
  'table',
  'agent:bob',
  {
    columns: {
      name: { label: 'Name', type: 'string' },
      field: { label: 'Field', type: 'string' },
    },
    rows: {
      r1: { _id: 'r1', ref: 'p:alice', name: 'Alice Ng', field: 'ML' },
      r2: { _id: 'r2', ref: 'p:bob', name: 'Bob Lee', field: 'NLP' },
    },
  },
  {
    title: 'Researcher table',
    actions: {
      highlight_row: { meaning: 'glance at this person before jumping to their node' },
      dehighlight_row: { meaning: 'release the preview' },
      select_row: { meaning: 'choose whose row to cite', label: 'Pick row' },
      deselect_row: { meaning: 'clear the pick' },
      sort_rows_by_column: { meaning: 'rank the roster by a column' },
      // consequence actions fired from toolbar controls → +Row / +Column round-trips
      add_row: { meaning: 'add a person the import missed', label: 'Add row' },
      add_column: { meaning: 'add a field the import forgot', label: 'Add column' },
    },
    controls: [
      // a compound presentation value (sort) driven per sub-key via dotted `writes`
      {
        id: 'sort_col',
        type: 'select',
        label: 'Sort by',
        meaning: 'sort by a column',
        writes: 'sort.colId',
        options: ['name', 'field'],
      },
      {
        id: 'sort_dir',
        type: 'select',
        label: 'Dir',
        meaning: 'sort direction',
        writes: 'sort.dir',
        options: ['asc', 'desc'],
      },
      // consequence controls
      {
        id: 'add_row_btn',
        type: 'button',
        label: '+ Row',
        meaning: 'add a person',
        fires: 'add_row',
      },
      {
        id: 'add_col_btn',
        type: 'button',
        label: '+ Column',
        meaning: 'add a field',
        fires: 'add_column',
      },
    ],
  },
);

/** The SNAPSHOT frame the mock replays on JOIN. */
export const SNAPSHOT = {
  type: 'SNAPSHOT',
  rev: 1,
  canvases: { g1: GRAPH, t1: TABLE },
  messages: [
    {
      type: 'CANVAS_MESSAGE',
      text: 'I laid out the collaboration graph.',
      source: 'agent:alice',
      seq: 1,
    },
    {
      type: 'CANVAS_MESSAGE',
      text: 'And I built the researcher table alongside it.',
      source: 'agent:bob',
      seq: 2,
    },
    {
      type: 'CANVAS_MESSAGE',
      text: 'Alice again — hover a node to brush its row.',
      source: 'agent:alice',
      seq: 3,
    },
    // a chip whose path RESOLVES (node/n1 exists) beside one that DANGLES (node/ghost) — the
    // client greys out the dangling one instead of silently lighting nothing.
    {
      type: 'CANVAS_MESSAGE',
      text: 'See {ref:ok} vs {ref:bad}.',
      source: 'agent:alice',
      seq: 4,
      refs: {
        ok: { canvasId: 'g1', paths: ['node/n1'], label: 'live node' },
        bad: { canvasId: 'g1', paths: ['node/ghost'], label: 'dead node' },
      },
    },
  ],
};

/**
 * A deliberately BROKEN spec — an agent that mis-authored presentation shapes (`collapsed`
 * as an object instead of a list, `find` as a number). The view MUST survive it (no crash)
 * thanks to the defensive coercions; a strict per-wire validator would reject the value
 * shapes up front instead (a validation gap the demo leaves open). Served via ?scenario=malformed.
 */
const TEXT_MALFORMED = canvas(
  'x1',
  'text',
  'agent:alice',
  {
    paragraphs: { p1: { ref: null } },
    lines: { l1: { text: 'A brief line survives a broken spec.', paragraph: 'p1' } },
    lineOrder: ['l1'],
  },
  {
    title: 'Broken text spec',
    actions: {
      highlight_line: { meaning: 'preview a line' },
      dehighlight_line: { meaning: 'release the preview' },
    },
    presentation: { collapsed: {}, find: 42 }, // WRONG: object for a list, number for a string
  },
);

export const MALFORMED_SNAPSHOT = {
  type: 'SNAPSHOT',
  rev: 1,
  canvases: { x1: TEXT_MALFORMED },
  messages: [
    {
      type: 'CANVAS_MESSAGE',
      text: 'Rendered a text view with a malformed presentation.',
      source: 'agent:alice',
      seq: 1,
    },
  ],
};

/** Shell (non-contract) control frames so the roster resolves agent names. */
export const LIBRARY = {
  type: 'LIBRARY',
  agents: [
    { name: 'alice', type: 'custom', blurb: 'graph curator' },
    { name: 'bob', type: 'custom', blurb: 'table curator' },
  ],
};
export const PARTICIPANTS = {
  type: 'PARTICIPANTS',
  agents: [
    { name: 'alice', present: true, phase: 'online', busy: false, lastError: null },
    { name: 'bob', present: true, phase: 'online', busy: false, lastError: null },
  ],
};

export const EXPECTED = {
  canvasCount: 2,
  agentSources: ['agent:alice', 'agent:bob'],
  agentMessageCount: 3,
};
