/**
 * Scenarios — what an agent would CREATE for each demo (mirrors the original demo
 * manifest, ABRA-shaped). Each scenario is a list of CREATE_CANVAS messages; the
 * loop seeds them and the shell stacks the resulting canvases. The linked
 * scenario seeds a graph AND a table over the same researcher refs, so brushing
 * one highlights the other (cross-view coordination by ref).
 *
 * Content is id-keyed (nodes/edges by id, rows by `_id`); `config.actions`
 * carries agent-authored meaning/label only — view-owned local_effects, broadcasts,
 * and the consequence classification live in the manifests (see abra-views manifests).
 */

export const SEED_OWNER = 'agent:seed';

const FIELDS = ['NLP', 'Vision', 'Systems', 'RL'];
const FILL = ['#4A90D9', '#E0913A', '#5BA37A', '#B5679E'];

// One shared roster — graph / table / text / gallery all derive their content from
// this, so the coordination `ref` lines up across every view. Ten researchers over
// four fields (with dense within-field co-authorship below) give the clusters enough
// mass that `force` clustering, `group by field`, and colour encoding read clearly.
const ROSTER = [
  {
    id: 'r01',
    ref: 'researcher:alice',
    name: 'Alice Kim',
    field: 'NLP',
    papers: 42,
    img: 'image_1.webp',
    note: 'leads the dialogue group; grounded generation',
  },
  {
    id: 'r02',
    ref: 'researcher:bob',
    name: 'Bob Li',
    field: 'Vision',
    papers: 17,
    img: 'image_2.webp',
    note: 'video understanding and tracking',
  },
  {
    id: 'r03',
    ref: 'researcher:carla',
    name: 'Carla Ng',
    field: 'NLP',
    papers: 28,
    img: 'image_3.webp',
    note: 'retrieval-augmented generation',
  },
  {
    id: 'r04',
    ref: 'researcher:deepa',
    name: 'Deepa Rao',
    field: 'Systems',
    papers: 9,
    img: 'image_4.webp',
    note: 'distributed training infrastructure',
  },
  {
    id: 'r05',
    ref: 'researcher:evan',
    name: 'Evan Cho',
    field: 'NLP',
    papers: 33,
    img: 'image_5.webp',
    note: 'long-context modeling and evaluation',
  },
  {
    id: 'r06',
    ref: 'researcher:fiona',
    name: 'Fiona Park',
    field: 'Vision',
    papers: 21,
    img: 'image_6.webp',
    note: 'open-vocabulary detection',
  },
  {
    id: 'r07',
    ref: 'researcher:gus',
    name: 'Gus Meyer',
    field: 'Systems',
    papers: 14,
    img: 'image_7.webp',
    note: 'schedulers for large-model serving',
  },
  {
    id: 'r08',
    ref: 'researcher:hana',
    name: 'Hana Sato',
    field: 'RL',
    papers: 25,
    img: 'image_8.webp',
    note: 'offline RL and preference learning',
  },
  {
    id: 'r09',
    ref: 'researcher:ivan',
    name: 'Ivan Petrov',
    field: 'Vision',
    papers: 19,
    img: 'image_9.webp',
    note: 'multi-view geometry',
  },
  {
    id: 'r10',
    ref: 'researcher:mei',
    name: 'Mei Ling',
    field: 'RL',
    papers: 30,
    img: 'image_10.webp',
    note: 'exploration in sparse-reward tasks',
  },
];

// Co-authorship: [sourceId, targetId, num_papers]. Dense within field, a few
// cross-field bridges — so a force / group layout shows four legible clusters.
const COAUTHORS = [
  ['r01', 'r03', 22],
  ['r01', 'r05', 12],
  ['r03', 'r05', 9], // NLP
  ['r02', 'r06', 15],
  ['r02', 'r09', 11],
  ['r06', 'r09', 8], // Vision
  ['r04', 'r07', 18], // Systems
  ['r08', 'r10', 20], // RL
  ['r03', 'r04', 6],
  ['r01', 'r02', 5],
  ['r05', 'r08', 7],
  ['r07', 'r09', 4], // bridges
];

/** Build an id-keyed content map from the roster. @param {(r: any) => any} fn */
const byId = (fn) => Object.fromEntries(ROSTER.map((r) => [r.id, fn(r)]));

/** Agent binding — meaning / label only (presentation + consequence-ness are view-owned). */
const GRAPH_INTERACTIONS = {
  highlight_node: { meaning: 'see who they collaborate with before deciding they are duplicates' },
  dehighlight_node: { meaning: 'release the preview focus on this researcher' },
  highlight_edge: { meaning: 'see how strong this collaboration link is before editing' },
  dehighlight_edge: { meaning: 'stop previewing this link' },
  select_node: {
    meaning: 'pick which researcher survives as the canonical record',
    label: 'Canonical',
  },
  deselect_node: { meaning: 'step back to comparing the whole network', label: 'Clear pick' },
  select_edge: { meaning: 'inspect this collaboration link before editing the graph' },
  deselect_edge: { meaning: 'stop treating this link as the active subject' },
  clear_selection: {
    meaning: 'return to scanning — nothing is singled out for editing',
    label: 'Clear',
  },
  show_node_detail: {
    meaning: 'read papers and affiliation without leaving the graph',
    label: 'Profile',
  },
  reposition_node: { meaning: 'nudge layout so the story reads clearly for others' },
  apply_layout: { meaning: 'reorganize the graph so clusters are obvious at a glance' },
  pan: { meaning: 'show the agent which region of the network I am looking at' },
  zoom: { meaning: 'show the agent which neighborhood I am inspecting' },
  fit_all: { meaning: 'reset to the full-network overview' },
  edit_node: { meaning: 'fix a misspelled or wrong name on the node' },
  add_edge: {
    meaning: 'record that they collaborated on this paper',
    label: 'Co-authored',
  },
  // one structural DELETE across element kinds — path (node/edge) says which; deleting a
  // node also drops its incident edges.
  delete: { meaning: 'drop a spurious node or link from the graph' },
};

const TABLE_INTERACTIONS = {
  highlight_cell: { meaning: 'compare this cell value against the graph row' },
  dehighlight_cell: { meaning: 'stop focusing on this cell' },
  highlight_row: { meaning: 'glance at this person before jumping to their graph node' },
  dehighlight_row: { meaning: 'release the preview focus on this row' },
  highlight_column: { meaning: 'scan this field across the roster' },
  dehighlight_column: { meaning: 'stop previewing this column' },
  select_cell: { meaning: 'mark this value before comparing it to the graph' },
  deselect_cell: { meaning: 'stop treating this cell as the active subject' },
  select_row: {
    meaning: 'choose whose roster row to fix or cite in the report',
    label: 'Pick row',
  },
  deselect_row: { meaning: 'stop treating this row as the active subject', label: 'Clear pick' },
  select_column: { meaning: 'treat this column as the active field for sorting or filtering' },
  deselect_column: { meaning: 'stop treating this column as the active subject' },
  highlight_block: { meaning: 'copy this slice of figures for the slide' },
  clear_selection: { meaning: 'return to scanning the full roster' },
  reorder_row: { meaning: 'move this person to where the narrative reads better' },
  sort_rows_by_column: { meaning: 'rank candidates by how risky they look for the briefing' },
  filter_rows_by_column: { meaning: 'narrow to rows that match this keyword' },
  add_row: { meaning: 'add a person the import missed', label: 'Add row' },
  add_column: {
    meaning: 'add a field the import forgot',
    label: 'Add column',
  },
  // structural DELETE (row or column — path says which) vs. value CLEAR (cell/block: the
  // values are blanked, the row/column structure stays).
  delete: { meaning: 'remove the selected row or column' },
  clear: {
    meaning: 'blank the selected cells without removing the row or column',
  },
  edit_cell: {
    meaning: 'correct a bad import yourself instead of re-prompting the agent',
  },
  edit_column: {
    meaning: 'rename a column header when the imported label is wrong or unclear',
  },
};

const TEXT_INTERACTIONS = {
  highlight_line: { meaning: "preview this person's section before jumping to their node or row" },
  dehighlight_line: { meaning: 'release the preview on this line' },
  select_line: { meaning: 'mark this line as the active passage to cite or act on' },
  deselect_line: { meaning: 'stop treating this line as active' },
  clear_selection: { meaning: 'return to reading the whole brief' },
  collapse_paragraph: { meaning: 'fold a section away to focus the reader elsewhere' },
  expand_paragraph: { meaning: 'reopen a folded section' },
  edit_line: { meaning: 'fix the wording of a line yourself' },
  add_line: { meaning: 'insert a line the draft is missing' },
  delete: { meaning: 'remove the selected line' },
};

const DISPLAY_INTERACTIONS = {
  highlight_item: {
    meaning: "preview this researcher's photo before jumping to their node or row",
  },
  dehighlight_item: { meaning: 'release the preview focus on this item' },
  change_layout: { meaning: 'switch the gallery between a grid and a filmstrip' },
};

const graph = () => ({
  type: 'CREATE_CANVAS',
  view: 'graph',
  title: 'Collaboration graph',
  source: SEED_OWNER,
  reqId: 'seed-graph',
  content: {
    nodes: byId((r) => ({ label: r.name, ref: r.ref, field: r.field })),
    edges: Object.fromEntries(
      COAUTHORS.map(([s, t, n], i) => [`e${i + 1}`, { source: s, target: t, num_papers: n }]),
    ),
  },
  config: {
    actions: GRAPH_INTERACTIONS,
    presentation: {
      layout: 'force',
      encoding: {
        'node.fill': { field: 'field', scale: { domain: FIELDS, range: FILL } },
        'edge.strokeWidth': { field: 'num_papers', scale: { domain: [0, 22], range: [1, 6] } },
      },
    },
    controls: [
      {
        id: 'layout',
        type: 'select',
        label: 'Layout',
        meaning: 'graph layout',
        writes: 'layout', // sets config.presentation.layout
        options: ['force', 'dagre', 'group'],
      },
    ],
  },
});

const table = () => ({
  type: 'CREATE_CANVAS',
  view: 'table',
  title: 'Researcher table',
  source: SEED_OWNER,
  reqId: 'seed-table',
  content: {
    columns: {
      name: { label: 'Name', type: 'string' },
      field: { label: 'Field', type: 'string' },
      papers: { label: 'Papers', type: 'number' },
    },
    rows: byId((r) => ({ _id: r.id, ref: r.ref, name: r.name, field: r.field, papers: r.papers })),
  },
  config: {
    actions: TABLE_INTERACTIONS,
    // A compound presentation value (`sort` = {colId, dir}) is driven per sub-key via dotted
    // `writes` — the built-in column-header sort gesture and these toolbar controls all
    // keyed-merge into the SAME config.presentation.sort, so they stay in lock-step.
    controls: [
      {
        id: 'sort_col',
        type: 'select',
        label: 'Sort by',
        meaning: 'sort the roster by a column',
        writes: 'sort.colId',
        options: ['name', 'field', 'papers'],
      },
      {
        id: 'sort_dir',
        type: 'select',
        label: 'Dir',
        meaning: 'sort direction',
        writes: 'sort.dir',
        options: ['asc', 'desc'],
      },
    ],
  },
});

// Extra collaboration lines per researcher — these make some paragraphs multi-line
// (foldable); the main line is generated from the roster. Kept adjacent to their main
// line so absolute line numbering stays consecutive within a paragraph.
/** @type {Record<string, string[]>} */
const TEXT_EXTRA = {
  r01: ['Frequent co-author with Carla Ng and Evan Cho.'],
  r03: ['Strong, sustained collaboration with Alice.'],
  r08: ['Bridges the RL and NLP groups via preference-learning work.'],
};

const text = () => {
  const paragraphs = Object.fromEntries(ROSTER.map((r) => [`p-${r.id}`, { ref: r.ref }]));
  /** @type {Record<string, { text: string, paragraph: string }>} */
  const lines = {};
  let n = 0;
  for (const r of ROSTER) {
    lines[`l${++n}`] = {
      text: `${r.name} — ${r.field} · ${r.note}; ${r.papers} papers.`,
      paragraph: `p-${r.id}`,
    };
    for (const t of TEXT_EXTRA[r.id] ?? []) lines[`l${++n}`] = { text: t, paragraph: `p-${r.id}` };
  }
  return {
    type: 'CREATE_CANVAS',
    view: 'text',
    title: 'Research brief',
    source: SEED_OWNER,
    reqId: 'seed-text',
    // paragraphs wrap lines (like a column wraps cells): the coordination `ref` lives on
    // the paragraph (no required title); folding shows the first line abbreviated.
    content: { paragraphs, lines },
    config: { actions: TEXT_INTERACTIONS },
  };
};

// A researcher photo gallery — strip (1×n horizontal scroll) layout, sharing the
// same refs as graph/table/text, so hovering a photo brushes the co-referent across
// views. Images live in apps/playground/public/display/ (served at /display/<name>).
const gallery = () => ({
  type: 'CREATE_CANVAS',
  view: 'display',
  title: 'Researcher gallery',
  source: SEED_OWNER,
  reqId: 'seed-gallery-display',
  content: {
    items: byId((r) => ({
      id: r.id,
      ref: r.ref,
      type: 'image',
      src: `/display/${r.img}`,
      caption: r.name,
    })),
  },
  config: {
    actions: DISPLAY_INTERACTIONS,
    presentation: { layout: 'strip' },
    controls: [
      {
        id: 'layout',
        type: 'select',
        label: 'Layout',
        meaning: 'display layout',
        writes: 'layout', // presentation is driven via `writes` → config.presentation.layout
        options: ['grid', 'strip'],
      },
    ],
  },
});

// A single-media display showcasing pan/zoom (single) — drop any image at the src.
const display = () => ({
  type: 'CREATE_CANVAS',
  view: 'display',
  title: 'Poster',
  source: SEED_OWNER,
  reqId: 'seed-display',
  content: {
    items: {
      p1: { id: 'p1', type: 'image', src: '/display/image_5.webp', caption: 'Poster' },
    },
  },
  config: {
    actions: DISPLAY_INTERACTIONS,
  },
});

// A PDF document — single-focus viewer (vertical scroll · ⌘/ctrl-wheel or ＋/－ zoom ·
// drag to pan). The file is the first page of the ABRA EMNLP 2026 demo paper (title,
// Figure 1, abstract); overwrite it with any PDF.
const pdfDoc = () => ({
  type: 'CREATE_CANVAS',
  view: 'display',
  title: 'Paper (PDF)',
  source: SEED_OWNER,
  reqId: 'seed-document',
  content: {
    items: {
      d1: {
        id: 'd1',
        type: 'document',
        src: '/display/abra-emnlp2026-demo-p1.pdf',
        caption: 'Paper',
      },
    },
  },
  config: {
    actions: DISPLAY_INTERACTIONS,
  },
});

// An interactive OpenStreetMap framed by coordinates (center [lat, lng] + zoom). No
// local file — Leaflet fetches OSM tiles from the network (needs internet).
const mapView = () => ({
  type: 'CREATE_CANVAS',
  view: 'display',
  title: 'Map',
  source: SEED_OWNER,
  reqId: 'seed-map',
  content: {
    items: {
      m1: {
        id: 'm1',
        type: 'map',
        center: [37.7596, -122.4269],
        zoom: 15,
        caption: 'Dolores Park, SF',
      },
    },
  },
  config: {
    actions: DISPLAY_INTERACTIONS,
  },
});

const graphGallery = () => ({
  ...graph(),
  title: 'Control gallery',
  reqId: 'seed-gallery',
  config: {
    ...graph().config,
    // Presentation is driven through `writes: '<config.presentation key>'` — the SINGLE
    // mechanism. This select writes config.presentation.layout, keyed-merged into the same
    // key the layout logic reads, so the control and any other writer stay in sync. `fires`
    // is reserved for consequence / local_effect actions, never presentation.
    controls: [
      {
        id: 'layout',
        type: 'select',
        label: 'Layout',
        meaning: 'graph layout',
        writes: 'layout',
        options: ['force', 'dagre', 'group'],
      },
    ],
  },
});

const readOnlyTable = () => {
  const t = table();
  const { edit_cell: _omit, ...readOnlyActions } = t.config.actions;
  return {
    ...t,
    title: 'Read-only table + filter',
    reqId: 'seed-readonly',
    // No toolbar controls: the column-header filter input drives filtering (a select-of-
    // field-values toolbar doesn't map to the `{colId, keyword}` filter shape, and the old
    // one was never wired). A control's `writes` must be a plain presentation scalar.
    config: {
      ...t.config,
      actions: readOnlyActions,
    },
  };
};

// Three multi-view scenarios — one per view-kind pairing. Standalone single-view
// behaviors are exercised within these (every canvas carries the full binding), and
// each pair shares referents so brushing one brush-and-links the other by `ref`.
export const SCENARIOS = [
  {
    id: 'graph-graph',
    label: 'Graph + graph',
    description:
      'Two graphs over the same referents — full graph bindings on both, brush-and-link by ref; the second adds every control type (button · select · switch · slider · number).',
    build: () => [graph(), graphGallery()],
  },
  {
    id: 'graph-table',
    label: 'Graph + table',
    description:
      'A graph and a table with full bindings over the same referents — brush-and-link by ref across the two view kinds.',
    build: () => [graph(), table()],
  },
  {
    id: 'table-table',
    label: 'Table + table',
    description:
      'Two tables over the same referents — brush-and-link by ref; one fully editable, the other read-only with a filter toolbar.',
    build: () => [table(), readOnlyTable()],
  },
  {
    id: 'graph-table-text',
    label: 'Graph + table + text',
    description:
      'Three views over the same researcher referents — hover any node / row / line to brush-and-link the co-referent across all three.',
    build: () => [graph(), table(), text()],
  },
  {
    id: 'all-four',
    label: 'Graph + table + text + gallery',
    description:
      'All four view kinds over the same researcher referents — graph · table · text · Display gallery. Hover any node / row / line / photo to brush-and-link the co-referent across all four (image_1..10.webp are generated samples; overwrite them with your own).',
    build: () => [graph(), table(), text(), gallery()],
  },
  {
    id: 'table-gallery',
    label: 'Table + gallery',
    description:
      'A table and a Display gallery (1×n horizontal scroll) over the same researcher referents — hover a photo or row to brush-and-link the co-referent. Photos: generated samples in apps/playground/public/display (overwrite with your own).',
    build: () => [table(), gallery()],
  },
  {
    id: 'display',
    label: 'Display (poster)',
    description:
      'A single-media Display — pan (drag) + zoom (wheel) on one image. Image: apps/playground/public/display/image_5.webp.',
    build: () => [display()],
  },
  {
    id: 'document',
    label: 'Document (PDF)',
    description:
      'A PDF viewer — vertical scroll · ⌘/ctrl-wheel or ＋/－ zoom · drag to pan. Shows the first page of the ABRA demo paper; overwrite the PDF with any other.',
    build: () => [pdfDoc()],
  },
  {
    id: 'map',
    label: 'Map',
    description:
      'An interactive OpenStreetMap framed by coordinates (center + zoom). No file — Leaflet fetches OSM tiles (needs internet).',
    build: () => [mapView()],
  },
];
