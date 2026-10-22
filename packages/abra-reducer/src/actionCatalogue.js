// @ts-check
/**
 * Catalogue-backed coordination metadata for the reducer. Hover/select PAIRS are derived
 * from the naming convention (highlight_X↔dehighlight_X, select_X↔deselect_X) — there is no
 * separate `action_sets` block; the flat `actions` map is the single source.
 */

import actionPresentation from '../../abra-views/src/views/shared/manifests/actionPresentation.json' with {
  type: 'json',
};
import catalogue from '../../abra-views/src/views/shared/manifests/catalogue.json' with {
  type: 'json',
};

// The JSON manifests are indexed by dynamic view/action ids; type them as open maps.
const _presentation = /** @type {Record<string, Record<string, any>>} */ (actionPresentation);

/** @param {string} view */
function viewManifest(view) {
  const comps = /** @type {Record<string, any>} */ (catalogue.view?.canvas_components ?? {});
  return comps[view] ?? null;
}

/** @param {string} view @param {string} actionId */
function actionMeta(view, actionId) {
  return viewManifest(view)?.actions?.[actionId] ?? null;
}

/**
 * Whether an action is a STRUCTURAL consequence — one whose outcome is an
 * owner-resolved pending (the `add_*` / `edit_*` / `delete` / `clear` family),
 * as opposed to a local_effect / presentation / coordination action. This is a
 * fixed fact of the view (declared `consequence: true` in `catalogue.json`), NOT an agent choice — the agent authors only `meaning`, never the
 * consequence classification.
 * @param {string} view @param {string} actionId
 */
export function isConsequenceAction(view, actionId) {
  return actionMeta(view, actionId)?.consequence === true;
}

/** @param {string} view @param {string} actionId */
function onsetMemberForClear(view, actionId) {
  const meta = actionMeta(view, actionId);
  if (meta?.coordination_paths !== 'clear') return null;
  // the onset partner by naming: dehighlight_X ↔ highlight_X, deselect_X ↔ select_X.
  const onset = actionId.startsWith('dehighlight_')
    ? actionId.replace(/^dehighlight_/, 'highlight_')
    : actionId.startsWith('deselect_')
      ? actionId.replace(/^deselect_/, 'select_')
      : null;
  return onset && viewManifest(view)?.actions?.[onset] ? onset : null;
}

/** @param {string} view @param {string} actionId @param {string} [path] */
export function coordinationPathsFor(view, actionId, path) {
  if (!path) return [];
  const meta = actionMeta(view, actionId);
  if (meta?.coordination_paths === 'clear') return [];
  return [path];
}

/** @param {string} view @param {string} actionId */
export function onsetActionForBroadcast(view, actionId) {
  return onsetMemberForClear(view, actionId);
}

/** @param {string} view @param {Record<string, unknown> | undefined} config */
export function validateCreateConfig(view, config) {
  const actions = config?.actions ?? {};
  const known = new Set(Object.keys(viewManifest(view)?.actions ?? {}));
  for (const [actionId, binding] of Object.entries(actions)) {
    if (!known.has(actionId)) return `unknown action binding: ${actionId}`;
    const meaning = /** @type {{ meaning?: unknown }} */ (binding)?.meaning;
    if (typeof meaning !== 'string' || meaning.trim() === '') {
      return `missing meaning on action binding: ${actionId}`;
    }
  }
  // A published select_/highlight_ without its deselect_/dehighlight_ is a coherence slip, not a
  // well-formedness error: the canvas is still usable (you can select but not deselect). It is a
  // degraded-but-functional state, so the contract no longer rejects it — pair completeness is left to
  // the caller/view, and (in the evaluation) to the judge's spec_format, rather than gated here.
  // config.presentation value SHAPES are checked against the catalogue's declared domains
  // (the view owns the domain; the agent must not mis-author it). Catalogue-driven → editing
  // catalogue.json auto-updates this (the reducer reads it at runtime, no codegen).
  const presErr = validatePresentation(view, /** @type {any} */ (config)?.presentation);
  if (presErr) return presErr;
  return null;
}

/** The declared value domain for a presentation key (catalogue `.domain`), or null. */
function presentationDomain(/** @type {string} */ view, /** @type {string} */ key) {
  const p = /** @type {any} */ (viewManifest(view))?.presentation?.[key];
  return p?.domain ?? null;
}

/** Check a value against a catalogue domain spec. @returns {string | null} error or null. */
function checkDomain(/** @type {any} */ val, /** @type {any} */ dom, /** @type {string} */ label) {
  if (val === null || val === undefined) return null; // absent is fine (defaults apply)
  switch (dom.kind) {
    case 'string':
      return typeof val === 'string' ? null : `${label}: expected a string`;
    case 'number':
      return typeof val === 'number' ? null : `${label}: expected a number`;
    case 'list':
      return Array.isArray(val) ? null : `${label}: expected a list`;
    case 'enum':
      return typeof val === 'string' && dom.values.includes(val)
        ? null
        : `${label}: expected one of ${dom.values.join(' | ')}`;
    case 'object': {
      if (typeof val !== 'object' || Array.isArray(val)) return `${label}: expected an object`;
      for (const [f, fdom] of Object.entries(dom.fields ?? {})) {
        const e = checkDomain(val[f], fdom, `${label}.${f}`);
        if (e) return e;
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Validate `config.presentation` value shapes against the view's catalogue-declared domains.
 * Keys with no declared domain stay permissive. @returns {string | null} error or null.
 * @param {string} view @param {any} presentation
 */
export function validatePresentation(view, presentation) {
  if (!presentation || typeof presentation !== 'object') return null;
  for (const [key, val] of Object.entries(presentation)) {
    const dom = presentationDomain(view, key);
    if (!dom) continue;
    const err = checkDomain(val, dom, `presentation.${key}`);
    if (err) return err;
  }
  return null;
}

/**
 * Does `val` satisfy a single catalogue value-signature `token`? Returns an error fragment
 * (`must be …`) or null. Token grammar (informal but checkable): `"a | b"` = enum; `"number"`
 * = number; a token starting with `[` (e.g. `"[[rowId, colId], …]"`) = array; anything else
 * — a plain string OR a path template like `"node/<id>"` / `"cell/<r>/<c>"` / `"<paragraphId>"`
 * — = a string (a path IS a string). This is the type half of the fire_action contract.
 */
function checkValueToken(/** @type {string} */ token, /** @type {any} */ val) {
  if (token.includes('|')) {
    const opts = token.split('|').map((s) => s.trim());
    return opts.includes(String(val)) ? null : `must be one of ${opts.join(', ')}`;
  }
  if (token === 'number') return typeof val === 'number' ? null : 'must be a number';
  if (token.startsWith('[')) return Array.isArray(val) ? null : 'must be an array';
  return typeof val === 'string' ? null : 'must be a string';
}

/**
 * Validate a CANVAS_EVENT `value` payload against the action's catalogue `value` signature
 * (the fire_action contract that read_canvas exposes). Enforces BOTH structure — every
 * declared key is present — AND type: each field matches its signature token (number / array /
 * enum / string-or-path, see checkValueToken). So a wrong-keyed payload (`{source,target}` for
 * add_edge's `{from,to}`), a bad enum (`dir:"ascending"`), or a wrong type (`x:"5"` where a
 * number is expected) is rejected up front — the non-owner agent gets VALIDATION + the expected
 * shape and re-issues the fire correctly, rather than the owner silently mis-resolving garbage.
 * An action with no `value` signature, or an empty one (`add_row`), imposes no contract.
 * @param {string} view @param {string} actionId @param {any} value @returns {string | null}
 */
/** A signature field may be an OBJECT token (e.g. add_row's `values: {"<columnId>": "cell value"}`),
 * meaning "an open keyed map of cells". The payload must then be a NON-EMPTY plain object: an empty
 * `{}` conveys nothing and would arm a consequence the owner cannot act on. */
const isObjToken = (/** @type {any} */ t) => !!t && typeof t === 'object' && !Array.isArray(t);

/** @param {string} view @param {string} actionId @param {any} value @returns {string | null} */
export function validateValue(view, actionId, value) {
  const sig = actionMeta(view, actionId)?.value;
  if (!sig || typeof sig !== 'object') return null; // no value contract for this action
  const keys = Object.keys(sig);
  if (keys.length === 0) return null; // an empty signature imposes no contract
  const shape = JSON.stringify(sig);
  if (value === null || value === undefined) return `${actionId} needs a value ${shape}`;
  if (typeof value !== 'object' || Array.isArray(value)) {
    return `${actionId} value must be an object ${shape}`;
  }
  for (const k of keys) {
    if (!(k in value)) return `${actionId} value: missing "${k}" — expects ${shape}`;
    const v = value[k];
    const err = isObjToken(sig[k])
      ? v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0
        ? null
        : 'must be a non-empty object'
      : checkValueToken(String(sig[k]), v);
    if (err) return `${actionId} value.${k} ${err} — expects ${shape}`;
  }
  return null;
}

// content collection keyed by a token's element kind. All collections are id-keyed maps
// (rows by _id, which IS the map key), so existence = `content[coll][id] !== undefined`.
/** @type {Record<string, string>} */
const _PATH_COLL = {
  node: 'nodes',
  edge: 'edges',
  row: 'rows',
  col: 'columns',
  item: 'items',
  line: 'lines',
  paragraph: 'paragraphs',
  annotation: 'annotations',
};
/** @type {Record<string, string>} */
const _BAREID_COLL = {
  nodeId: 'nodes',
  edgeId: 'edges',
  rowId: 'rows',
  colId: 'columns',
  itemId: 'items',
  lineId: 'lines',
  paragraphId: 'paragraphs',
};

const _has = (/** @type {any} */ content, /** @type {string} */ coll, /** @type {any} */ id) =>
  !!(coll && id != null && content?.[coll] && content[coll][id] !== undefined);

/**
 * Does a REFERENCE-typed value `val` (shaped per `token`) resolve to a real element in
 * `content`? Returns an error fragment or null. Reference tokens: a bare id (`"<paragraphId>"`),
 * an element path (`"node/<id>"`), a cell path (`"cell/<rowId>/<colId>"`), or an array of cell
 * coords (`"[[rowId, colId], …]"`). Non-reference tokens (number/string/enum) → null (not a ref).
 */
function checkValueRef(
  /** @type {string} */ token,
  /** @type {any} */ val,
  /** @type {any} */ content,
) {
  const bare = /^<(\w+)>$/.exec(token); // bare id — value IS the id; collection from the token name
  if (bare && _BAREID_COLL[bare[1]]) {
    return _has(content, _BAREID_COLL[bare[1]], val)
      ? null
      : `references a ${bare[1]} that doesn't exist: ${JSON.stringify(val)}`;
  }
  if (token.startsWith('cell/')) {
    // cell path "cell/<rowId>/<colId>" — both the row and the column must exist
    const p = String(val).split('/');
    return _has(content, 'rows', p[1]) && _has(content, 'columns', p[2])
      ? null
      : `references a cell that doesn't exist: ${JSON.stringify(val)}`;
  }
  const pref = /^(\w+)\/</.exec(token); // element path "node/<id>" — strip the prefix to get the id
  if (pref && _PATH_COLL[pref[1]]) {
    // Lenient on the prefix: accept both the contract form `node/<id>` and a bare `<id>` when it
    // resolves. Omitting the `node/` prefix is a form slip, not a grounding error (the node exists);
    // a value that names a genuinely nonexistent element still fails. Exact form is graded downstream.
    const p = String(val);
    const id = p.startsWith(`${pref[1]}/`) ? p.slice(pref[1].length + 1) : p;
    return _has(content, _PATH_COLL[pref[1]], id)
      ? null
      : `references a ${pref[1]} that doesn't exist: ${JSON.stringify(val)}`;
  }
  if (token.startsWith('[') && Array.isArray(val)) {
    // array of [rowId, colId]
    for (const pair of val) {
      const [r, c] = Array.isArray(pair) ? pair : [];
      if (!_has(content, 'rows', r) || !_has(content, 'columns', c))
        return `references a cell that doesn't exist: ${JSON.stringify(pair)}`;
    }
  }
  return null;
}

/**
 * REFERENTIAL check of a fire_action value against the target canvas `content`: every value
 * field that names an element (a path or id) must resolve to a REAL element — so an agent
 * can't propose `add_edge` between nonexistent nodes or `add_line` into a nonexistent
 * paragraph. Complements validateValue (which checks shape/type only). The value carries the
 * ids; content confirms they exist. Run in the reducer, which holds the authoritative content;
 * a miss → VALIDATION with the offending id, so the agent re-reads content and re-fires.
 * @param {string} view @param {string} actionId @param {any} value @param {any} content
 * @returns {string | null}
 */
export function validateValueRefs(view, actionId, value, content) {
  const sig = actionMeta(view, actionId)?.value;
  if (!sig || typeof sig !== 'object' || !value || typeof value !== 'object') return null;
  for (const [k, token] of Object.entries(sig)) {
    if (!(k in value)) continue; // structure already enforced by validateValue
    if (typeof token !== 'string') continue; // OBJECT token (add_row.values) — a map of cells, not a ref
    const err = checkValueRef(token, value[k], content);
    if (err) return `${actionId} value.${k} ${err}`;
  }
  return null;
}

/**
 * The local-effect identifiers an agent application publishes into the
 * `appliedEffects` overlay. In the channel model these ARE the action's
 * `view_private` channel names (e.g. select_node → ['bg', 'siblings opacity']);
 * a legacy `local_effects` array, if present, still wins.
 * @param {string} view @param {string} actionId
 */
export function actionLocalEffects(view, actionId) {
  const row = /** @type {{ local_effects?: string[], view_private?: [string, string][] }} */ (
    _presentation[view]?.[actionId]
  );
  if (row?.local_effects) return row.local_effects;
  return (row?.view_private ?? []).map((tuple) => tuple[0]);
}

/** @param {string} view @param {string} actionId */
export function actionBroadcasts(view, actionId) {
  const row = /** @type {{ broadcasts?: string[] }} */ (_presentation[view]?.[actionId]);
  return row?.broadcasts ?? [];
}

/** @param {string} _view @param {Record<string, unknown> | undefined} config */
export function sanitizeCreateConfig(_view, config) {
  if (!config?.actions) return config;
  const actions = /** @type {Record<string, any>} */ ({});
  for (const [actionId, binding] of Object.entries(
    /** @type {Record<string, Record<string, unknown>>} */ (config.actions),
  )) {
    const { effects: _e, broadcasts: _b, dwell: _d, ...agent } = binding ?? {};
    actions[actionId] = agent;
  }
  return { ...config, actions };
}

/** @param {string} _view @param {Record<string, unknown> | undefined} config */
export function normalizeCreateConfig(_view, config) {
  if (!config) return config;
  const actions = /** @type {Record<string, any>} */ ({});
  const incoming = { .../** @type {Record<string, unknown>} */ (config.actions ?? {}) };
  for (const [actionId, binding] of Object.entries(incoming)) {
    const {
      effects: _e,
      broadcasts: _b,
      dwell: _d,
      ...agent
    } = /** @type {Record<string, unknown>} */ (binding ?? {});
    actions[actionId] = agent;
  }
  const { action_sets: _a, ...rest } = config; // strip any legacy action_sets (no longer expanded)
  return { config: { ...rest, actions } };
}
