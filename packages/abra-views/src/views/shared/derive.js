// @ts-check
/**
 * Shared derive helpers for the controlled-mirror views. Views are pure
 * functions of `canvas`: they normalize the id-keyed content into arrays, read
 * the coordination overlay, and gate gestures on the published binding. No view
 * ever mutates `canvas` — they emit CANVAS_EVENT intents through `onEvent`.
 */
import catalogue from './manifests/catalogue.json' with { type: 'json' };

/**
 * Normalize an id-keyed content map (`nodes` / `edges` / `columns` / `rows`)
 * into a stable array of `{ id, ...fields }`. Insertion order is preserved.
 * @param {Record<string, any> | undefined} map
 * @param {string} [idKey] field name to expose the key under (default `id`)
 * @returns {any[]}
 */
export function rows(map, idKey = 'id') {
  if (!map) return [];
  return Object.entries(map).map(([id, val]) => ({ [idKey]: id, ...(val ?? {}) }));
}

/** Like rows(), but respects an optional order list. Unknown ids append after ordered ids. */
export function orderedRows(map, /** @type {string[] | undefined} */ order, idKey = 'id') {
  const base = rows(map, idKey);
  // `order` is agent-authored (a presentation / content list) — a malformed value (object,
  // string) must degrade to "no order", never crash on `.map`/iteration.
  if (!Array.isArray(order) || !order.length) return base;
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...base].sort((a, b) => {
    const ai = rank.has(a[idKey]) ? rank.get(a[idKey]) : Number.POSITIVE_INFINITY;
    const bi = rank.has(b[idKey]) ? rank.get(b[idKey]) : Number.POSITIVE_INFINITY;
    if (ai === bi) return 0;
    return ai < bi ? -1 : 1;
  });
}

/** Is this action published on the canvas (i.e. the gesture is bound)? */
export function published(/** @type {any} */ canvas, /** @type {string} */ actionId) {
  return !!canvas?.config?.actions?.[actionId];
}

/**
 * Does an action arm a consequence/pending lifecycle? This is a STRUCTURAL fact of
 * the view (declared `consequence: true` in `catalogue.json`), not an
 * agent choice — so it's read from the manifest, gated on the action being published.
 */
export function hasConsequence(/** @type {any} */ canvas, /** @type {string} */ actionId) {
  if (!canvas?.config?.actions?.[actionId]) return false; // not published on this canvas
  const meta = /** @type {any} */ (catalogue)?.view?.canvas_components?.[canvas.view]?.actions?.[
    actionId
  ];
  return meta?.consequence === true;
}

/**
 * Should the view render its BUILT-IN affordance (default chrome / gesture) for this
 * action? True iff the action is published AND its binding doesn't set `default:false`.
 * This is what makes the four modes work: publishing + `default!==false` shows the chrome
 * (DEFAULT_ONLY / DEFAULT_CONTROLLER); `default:false` suppresses it so only a control
 * drives the action (CONTROLLER_ONLY). The control itself is independent (config.controls).
 */
export function chromeEnabled(/** @type {any} */ canvas, /** @type {string} */ actionId) {
  return published(canvas, actionId) && canvas?.config?.actions?.[actionId]?.default !== false;
}

/** cursor `kind` -> utility class (views.css). `none` = the default arrow. */
const CURSOR_CLASS = {
  pointer: 'abra-cur-pointer', // click acts (select / open)
  text: 'abra-cur-text', // click-into-edit (a text field)
  grab: 'abra-cur-grab', // drag to move / reorder (+ :active grabbing)
  crosshair: 'abra-cur-crosshair', // drag to select a region
  none: 'abra-cur-default', // inert — no bound action, plain arrow
};

/**
 * Honest-affordance cursor class for an element, so a view never signals an interaction
 * the canvas didn't bind. `prefs` is [[actionId, kind], …] in PRIORITY order — the class
 * of the first PUBLISHED action wins; if none are published the element is inert and gets
 * the default arrow. One mechanism across every view (graph node, table cell/row/column,
 * text line, …): the cursor tracks the published binding, not a static per-element guess.
 * @param {any} canvas
 * @param {Array<[string, keyof typeof CURSOR_CLASS]>} prefs
 * @returns {string}
 */
export function affordanceClass(canvas, prefs) {
  for (const [actionId, kind] of prefs) {
    if (published(canvas, actionId)) return CURSOR_CLASS[kind] ?? CURSOR_CLASS.none;
  }
  return CURSOR_CLASS.none;
}

/**
 * The set of join keys (`ref ?? path`) currently lit in the coordination
 * overlay — i.e. some OTHER participant/view is brushing a co-referent element.
 * In the playground the link-index has already merged other canvases' overlays
 * into `canvas.highlight`, so a key present here means "light me up".
 * @param {any} canvas
 * @returns {Set<string>}
 */
export function coordinatedKeys(canvas) {
  const hl = canvas?.highlight ?? {};
  /** @type {Set<string>} */
  const lit = new Set();
  for (const [joinKey, bySource] of Object.entries(hl)) {
    if (bySource && Object.keys(bySource).length) lit.add(joinKey);
  }
  return lit;
}

/**
 * Join keys currently carrying an agent-fired shared local_effect overlay.
 * @param {any} canvas
 * @returns {Set<string>}
 */
export function appliedEffectKeys(canvas) {
  const ae = canvas?.appliedEffects ?? {};
  /** @type {Set<string>} */
  const lit = new Set();
  for (const [joinKey, bySource] of Object.entries(ae)) {
    if (bySource && Object.keys(bySource).length) lit.add(joinKey);
  }
  return lit;
}

/** Read the agent-authored presentation encoding map (field → scale) if any. */
export function encoding(/** @type {any} */ canvas) {
  return canvas?.config?.presentation?.encoding ?? {};
}

/**
 * Resolve a nominal color from an encoding scale `{ domain, range }`.
 * @param {{ field?: string, scale?: { domain?: any[], range?: any[] } } | undefined} enc
 * @param {any} row
 * @returns {string | undefined}
 */
export function nominalColor(enc, row) {
  if (!enc?.field || !enc.scale) return undefined;
  const { domain = [], range = [] } = enc.scale;
  const i = domain.indexOf(row?.[enc.field]);
  return i >= 0 ? range[i] : undefined;
}

/**
 * Resolve a quantitative value from an encoding scale (linear domain→range).
 * @param {{ field?: string, scale?: { domain?: number[], range?: number[] } } | undefined} enc
 * @param {any} row
 * @returns {number | undefined}
 */
export function linear(enc, row) {
  if (!enc?.field || !enc.scale) return undefined;
  const v = Number(row?.[enc.field]);
  if (Number.isNaN(v)) return undefined;
  const [d0 = 0, d1 = 1] = enc.scale.domain ?? [];
  const [r0 = 0, r1 = 1] = enc.scale.range ?? [];
  if (d1 === d0) return r0;
  const t = Math.max(0, Math.min(1, (v - d0) / (d1 - d0)));
  return r0 + t * (r1 - r0);
}

/** The single cross-kind selection state held view-side (not on the wire). */
export const EMPTY_SELECTION = {
  kind: /** @type {string | null} */ (null),
  ids: /** @type {string[]} */ ([]),
};

/**
 * Apply a select/deselect toggle to the one selection object (single-selection
 * rule: selecting any new target replaces the old; selecting the same target toggles it off).
 * @param {{ kind: string | null, ids: string[] }} sel
 * @param {string} kind
 * @param {string} id
 * @returns {{ kind: string | null, ids: string[] }}
 */
export function toggleSelection(sel, kind, id) {
  if (sel.kind !== kind) return { kind, ids: [id] };
  return sel.ids[0] === id ? { kind: null, ids: [] } : { kind, ids: [id] };
}

/** Is `id` of `kind` currently selected? */
export function isSelected(
  /** @type {any} */ sel,
  /** @type {string} */ kind,
  /** @type {string} */ id,
) {
  return sel.kind === kind && sel.ids.includes(id);
}

/**
 * Bundle the per-element render flags every view computes the same way — selection,
 * hover, coordination, and agent-fired shared effect stack on SEPARATE channels, so a
 * view reads all four to paint an element. `joinKey` (the coordination key `ref ?? path`)
 * stays at the CALL SITE — it's view-specific (node=`ref ?? node/id`, table cell=`cell/r/c`,
 * column=`col/id`) and it IS the coordination contract, so it must not be guessed here.
 * @param {{ sel: any, hover?: any, lit: Set<string>, applied?: Set<string> }} view
 * @param {string} kind
 * @param {string} id
 * @param {string} [joinKey] defaults to `<kind>/<id>` when the element carries no ref
 * @returns {{ selected: boolean, hovered: boolean, coordinated: boolean, sharedEffect: boolean }}
 */
export function elementFlags(view, kind, id, joinKey = `${kind}/${id}`) {
  const path = `${kind}/${id}`;
  return {
    selected: isSelected(view.sel, kind, id),
    hovered: view.hover?.kind === kind && view.hover.id === id,
    // lit by its coordination joinKey (ref-based fan-out) OR by its exact PATH — the latter
    // is how a chat chip lights just this element (path-precise, never its co-referents).
    coordinated: view.lit.has(joinKey) || (joinKey !== path && view.lit.has(path)),
    sharedEffect: !!view.applied?.has(joinKey),
  };
}
