// @ts-check
/**
 * Client apply-only half of the reducer (the `./apply` export) = the render replica.
 *
 * `mergeContent` is THE shared content keyed-merge rule;
 * `applyDelta` is the shared client-side frame reduction that rebuilds the replica
 * from hub broadcasts (SNAPSHOT / CREATE / UPDATE / CLOSE / CANCEL_PENDING / events).
 * Both are mirrored byte-for-byte by adapters/common/apply_delta.py and exercised
 * against it through adapters/common/fixtures (JS<->Py parity). Keep idiom-light so
 * the Python port stays mechanical. No speculative reduction — the replica only ever
 * reflects authoritative broadcasts.
 */

/**
 * Merge a content patch into base content.
 * - Array value           => full replace.
 * - Keyed-map (object)     => merge by id; within an element, shallow-merge; null id deletes.
 * - Scalar / null at top   => replace (LWW; e.g. position keys like `rowOrder`).
 * @param {Record<string, any> | null | undefined} base
 * @param {Record<string, any> | null | undefined} patch
 * @returns {Record<string, any>}
 */
export function mergeContent(base, patch) {
  /** @type {Record<string, any>} */
  const out = { ...(base ?? {}) };
  for (const [key, val] of Object.entries(patch ?? {})) {
    if (Array.isArray(val)) {
      out[key] = val;
    } else if (val !== null && typeof val === 'object') {
      /** @type {Record<string, any>} */
      const cur = { ...(out[key] ?? {}) };
      for (const [id, elem] of Object.entries(val)) {
        if (elem === null) {
          delete cur[id];
        } else if (typeof elem === 'object' && !Array.isArray(elem)) {
          cur[id] = { ...(cur[id] ?? {}), ...elem };
        } else {
          cur[id] = elem;
        }
      }
      out[key] = cur;
    } else {
      out[key] = val;
    }
  }
  return out;
}

/** Merge an UPDATE `config` patch (presentation keyed-merge; controls LWW).
 * @param {any} baseConfig @param {any} patch */
export function mergeConfigPatch(baseConfig, patch) {
  if (!patch) return baseConfig;
  const out = { ...(baseConfig ?? {}) };
  let changed = false;
  if (patch.presentation !== undefined) {
    out.presentation = mergeContent(baseConfig?.presentation, patch.presentation);
    changed = true;
  }
  if (patch.controls !== undefined) {
    out.controls = patch.controls;
    changed = true;
  }
  return changed ? out : baseConfig;
}

/** Build a replica canvas from a CREATE_CANVAS broadcast (defaults applied). */
function buildCanvas(/** @type {any} */ frame) {
  /** @type {Record<string, any>} */
  const cv = {
    canvasId: frame.canvasId,
    owner: frame.source,
    view: frame.view,
    content: frame.content ?? {},
    mode: frame.mode ?? 'exclusive',
    display: frame.display ?? 'inline',
    closed: false,
    lock: null,
    pending: {},
    highlight: {},
    appliedEffects: {},
    rev: frame.rev,
  };
  if (frame.config !== undefined) cv.config = frame.config;
  if (frame.title !== undefined) cv.title = frame.title;
  if (frame.order !== undefined) cv.order = frame.order;
  return cv;
}

/** Merge an UPDATE_CANVAS/server delta into an existing replica canvas. */
function mergeCanvas(/** @type {any} */ cur, /** @type {any} */ frame) {
  const next = { ...cur };
  if (frame.content !== undefined) next.content = mergeContent(cur.content, frame.content);
  if (frame.config !== undefined) next.config = mergeConfigPatch(cur.config, frame.config);
  if (frame.lock !== undefined) next.lock = frame.lock;
  if (frame.pending !== undefined) next.pending = frame.pending;
  if (frame.highlight !== undefined) next.highlight = frame.highlight;
  if (frame.appliedEffects !== undefined) next.appliedEffects = frame.appliedEffects;
  if (frame.mode !== undefined) next.mode = frame.mode;
  if (frame.title !== undefined) next.title = frame.title;
  if (frame.display !== undefined) next.display = frame.display;
  if (frame.order !== undefined) next.order = frame.order;
  return next;
}

/** @returns {Record<string, any>} */
function setCanvas(
  /** @type {any} */ state,
  /** @type {string} */ id,
  /** @type {any} */ cv,
  /** @type {number|undefined} */ rev,
) {
  const r = rev ?? state.rev;
  return { ...state, rev: r, canvases: { ...state.canvases, [id]: { ...cv, rev: r } } };
}

/**
 * Apply a hub broadcast/frame to the render replica.
 * @param {Record<string, any>} state replica `{ rev, canvases, messages }`
 * @param {any} frame
 * @returns {Record<string, any>}
 */
export function applyDelta(state, frame) {
  switch (frame?.type) {
    case 'SNAPSHOT':
      return {
        rev: frame.rev ?? 0,
        canvases: { ...(frame.canvases ?? {}) },
        messages: [...(frame.messages ?? [])],
      };
    case 'CREATE_CANVAS':
      return setCanvas(state, frame.canvasId, buildCanvas(frame), frame.rev);
    case 'UPDATE_CANVAS': {
      const cur = state.canvases[frame.canvasId];
      if (!cur) return state;
      return setCanvas(state, frame.canvasId, mergeCanvas(cur, frame), frame.rev);
    }
    case 'CLOSE_CANVAS': {
      const cur = state.canvases[frame.canvasId];
      if (!cur) return state;
      return setCanvas(state, frame.canvasId, { ...cur, closed: true }, frame.rev);
    }
    case 'CANCEL_PENDING': {
      const cur = state.canvases[frame.canvasId];
      if (!cur) return state;
      return setCanvas(state, frame.canvasId, { ...cur, pending: frame.pending ?? {} }, frame.rev);
    }
    case 'CANVAS_EVENT': {
      const cur = state.canvases[frame.canvasId];
      if (!cur) return state;
      // A CANVAS_EVENT carries a server-maintained map only when the binding wrote
      // one: pending (consequence), appliedEffects (agent local-effect), highlight
      // (coordination). A pure attention / client-local event carries none -> no-op.
      let cv = cur;
      if (frame.pending !== undefined) cv = { ...cv, pending: frame.pending };
      if (frame.appliedEffects !== undefined) cv = { ...cv, appliedEffects: frame.appliedEffects };
      if (frame.highlight !== undefined) cv = { ...cv, highlight: frame.highlight };
      // A user's presentation op rides the event as a config.presentation patch; the
      // replica keyed-merges it (only presentation — never actions/controls).
      if (frame.config?.presentation !== undefined) {
        cv = {
          ...cv,
          config: mergeConfigPatch(cv.config, { presentation: frame.config.presentation }),
        };
      }
      if (cv === cur) return state;
      return setCanvas(state, frame.canvasId, cv, frame.rev);
    }
    case 'CANVAS_MESSAGE':
    case 'USER_MESSAGE':
      return { ...state, messages: [...state.messages, frame] };
    default:
      return state;
  }
}

/**
 * The coordination LINK-INDEX: a highlight fans out across visible canvases by
 * ref. The reducer writes the `highlight` overlay onto the ORIGINATING canvas; this
 * derives, per canvas, the overlay it should RENDER = the union of EVERY OTHER canvas's
 * overlay (keyed by `joinKey`). Self-exclusion is the point: the element you brushed
 * shows its own local highlight, not the animated coordination pulse — that pulse is
 * reserved for co-referents in OTHER views. Shared by every shell (playground loop +
 * hub client) so coordination behaves identically; it is NOT per-shell logic.
 * @param {Record<string, any>} canvases  canvasId -> canvas (each with `.highlight`)
 * @returns {Record<string, any>}  canvasId -> merged highlight overlay to render
 */
export function linkIndex(canvases) {
  const entries = Object.entries(canvases ?? {});
  /** @type {Record<string, any>} */
  const out = {};
  for (const [id] of entries) {
    /** @type {Record<string, any>} */
    const union = {};
    for (const [oid, oc] of entries) {
      if (oid === id) continue; // exclude self — you don't coordinate with yourself
      for (const [jk, bySource] of Object.entries(oc?.highlight ?? {})) {
        union[jk] = union[jk] ?? {};
        for (const [src, byKind] of Object.entries(bySource ?? {})) {
          union[jk][src] = { ...(union[jk][src] ?? {}), ...(byKind ?? {}) };
        }
      }
    }
    out[id] = union;
  }
  return out;
}
