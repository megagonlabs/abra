// @ts-check
/**
 * Authoritative reducer — `reduce(state, msg, ctx) -> { state, effects }`.
 *
 * Pure: no I/O, no clock, no randomness. The hub injects `ctx.now` (epoch-ms)
 * and `ctx.mintId` (uuid factory) so the same call is deterministic and testable.
 * `effects` are intents the hub executes: broadcast a delta, send an ERROR to the
 * caller, or schedule a lease timeout (which re-enters as a synthetic LEASE_EXPIRED).
 *
 * VIEW-AGNOSTIC lifecycle + the published-binding write paths. NO ops — durable
 * change is declarative `content`/`presentation` patches (keyed-merged here). A
 * `CANVAS_EVENT` resolves its binding against `config.actions[action]`: a
 * STRUCTURAL consequence action (declared in the view manifest) arms a pending —
 * the classification is view-owned, not agent-authored; an agent's `effects` write the source-keyed
 * `appliedEffects` overlay (the agent has no view of its own); `broadcasts` kinds
 * (minus the transient `attention`) write the `highlight[joinKey][source][kind]`
 * coordination overlay. Generalized fire_action: an agent may invoke any
 * PUBLISHED action/control (one present in config.actions / config.controls).
 * Server->client broadcast/delta frames are a superset of the request schemas
 * (they carry server-maintained fields + rev); their wire schema is tightened later.
 */

import { ERROR_CODES, LOCK_LEASE_MS, PENDING_LEASE_MS } from 'abra-spec/constants';
import {
  actionBroadcasts,
  actionLocalEffects,
  coordinationPathsFor,
  isConsequenceAction,
  normalizeCreateConfig,
  onsetActionForBroadcast,
  validateCreateConfig,
  validatePresentation,
  validateValue,
  validateValueRefs,
} from './actionCatalogue.js';
import { mergeConfigPatch, mergeContent } from './apply.js';

/** @typedef {{ rev: number, canvases: Record<string, any>, messages: any[] }} State */
/** @typedef {{ now: number, mintId: () => string }} Ctx */
/** @typedef {{ state: State, effects: any[] }} Result */

/** @returns {State} */
export function initialState() {
  return { rev: 0, canvases: {}, messages: [] };
}

// --- effect builders -------------------------------------------------------
const broadcast = (/** @type {any} */ frame) => ({ kind: 'broadcast', frame });
const toCaller = (/** @type {string} */ source, /** @type {any} */ frame) => ({
  kind: 'toCaller',
  source,
  frame,
});
const schedule = (/** @type {any} */ lease) => ({ kind: 'schedule', lease });
const errorFrame = (
  /** @type {any} */ reqId,
  /** @type {string} */ code,
  /** @type {string} */ message,
  /** @type {string=} */ reason,
) => ({
  type: 'ERROR',
  reqId,
  code,
  message,
  // `reason` is a machine-readable sub-tag for the (otherwise coarse) VALIDATION code —
  // e.g. value.shape / value.ref / presentation.domain / create.config — so a caller can
  // count failure modes without parsing `message`. Omitted for codes that are self-explaining.
  ...(reason ? { reason } : {}),
});

/**
 * @param {State} state @param {any} msg @param {string} code @param {string} message
 * @param {string=} reason machine-readable VALIDATION sub-tag (optional)
 * @returns {Result}
 */
function reject(state, msg, code, message, reason) {
  return { state, effects: [toCaller(msg.source, errorFrame(msg.reqId, code, message, reason))] };
}

const isAgent = (/** @type {string} */ s) => /^agent:/.test(s);

/** Put one updated canvas back into state at a new rev. @returns {State} */
function withCanvas(
  /** @type {State} */ state,
  /** @type {string} */ canvasId,
  /** @type {any} */ canvas,
  /** @type {number} */ rev,
) {
  return { ...state, rev, canvases: { ...state.canvases, [canvasId]: canvas } };
}

/**
 * @param {State} state @param {any} msg @param {Ctx} ctx @returns {Result}
 */
export function reduce(state, msg, ctx) {
  switch (msg.type) {
    case 'CREATE_CANVAS':
      return createCanvas(state, msg, ctx);
    case 'UPDATE_CANVAS':
      return updateCanvas(state, msg, ctx);
    case 'CLOSE_CANVAS':
      return closeCanvas(state, msg);
    case 'CANCEL_PENDING':
      return cancelPending(state, msg);
    case 'CANVAS_EVENT':
      return canvasEvent(state, msg, ctx);
    case 'LOCK':
      return lockMsg(state, msg, ctx);
    case 'LEASE_EXPIRED':
      return leaseExpired(state, msg);
    case 'CANVAS_MESSAGE':
    case 'USER_MESSAGE':
      return chat(state, msg);
    default:
      return { state, effects: [] };
  }
}

/** @returns {Result} */
function createCanvas(/** @type {State} */ state, /** @type {any} */ msg, /** @type {Ctx} */ ctx) {
  if (!isAgent(msg.source)) {
    return reject(state, msg, ERROR_CODES.VALIDATION, 'CREATE source must be an agent', 'source');
  }
  let config = msg.config;
  if (config) {
    const normalized = /** @type {{ config: any, error?: string }} */ (
      normalizeCreateConfig(msg.view, config)
    );
    if (normalized.error) {
      return reject(state, msg, ERROR_CODES.VALIDATION, normalized.error, 'create.config');
    }
    config = normalized.config;
    const err = validateCreateConfig(msg.view, config);
    if (err) return reject(state, msg, ERROR_CODES.VALIDATION, err, 'create.config');
  }
  const canvasId = ctx.mintId();
  const rev = state.rev + 1;
  /** @type {Record<string, any>} */
  const canvas = {
    canvasId,
    owner: msg.source,
    view: msg.view,
    content: msg.content ?? {},
    mode: msg.mode ?? 'exclusive',
    display: msg.display ?? 'inline',
    closed: false,
    lock: null,
    pending: {},
    highlight: {},
    appliedEffects: {},
    rev,
  };
  // Optional metadata: include only when present, matching the replica builders
  // (apply.js / apply_delta.py) so the same canvas has one shape on every read path.
  for (const k of ['config', 'title', 'order']) {
    if (k === 'config' ? config !== undefined : msg[k] !== undefined) {
      canvas[k] = k === 'config' ? config : msg[k];
    }
  }
  const delta = { ...msg, canvasId, rev, ...(config !== undefined ? { config } : {}) };
  return { state: withCanvas(state, canvasId, canvas, rev), effects: [broadcast(delta)] };
}

/** @returns {Result} */
function updateCanvas(/** @type {State} */ state, /** @type {any} */ msg, /** @type {Ctx} */ ctx) {
  const canvas = state.canvases[msg.canvasId];
  if (!canvas) return reject(state, msg, ERROR_CODES.CANVAS_NOT_FOUND, 'unknown canvas');
  if (canvas.closed) return reject(state, msg, ERROR_CODES.CANVAS_CLOSED, 'canvas is closed');

  // Immutable substrate: view / config.actions can't change after CREATE.
  if (msg.view !== undefined) {
    return reject(
      state,
      msg,
      ERROR_CODES.IMMUTABLE_FIELD,
      'view is immutable — create a new canvas',
    );
  }
  if (msg.config !== undefined) {
    if (msg.config.actions !== undefined) {
      return reject(
        state,
        msg,
        ERROR_CODES.IMMUTABLE_FIELD,
        'config.actions is immutable — create a new canvas',
      );
    }
  }

  const isOwner = msg.source === canvas.owner;
  const hasOwnerField =
    msg.config?.controls !== undefined || msg.mode !== undefined || msg.title !== undefined;
  // `content` is collaborative (lock-gated / owner-only). `config.presentation` is NOT:
  // render params (positions / layout / colorBy / filter) are client-computed and
  // LWW per D7 — any participant may patch them (even on an exclusive canvas, which
  // gates the DATA, not the view state). So presentation is outside the gate below.
  const hasAuthoring = msg.content !== undefined || msg.resolves !== undefined;

  // --- permissions --------------------------------------------------------
  if ((hasOwnerField || msg.resolves !== undefined) && !isOwner) {
    return reject(state, msg, ERROR_CODES.NOT_OWNER, 'owner-only field');
  }
  if (hasAuthoring) {
    if (canvas.mode === 'collaborative') {
      const holds = !!canvas.lock && canvas.lock.holder === msg.source;
      if (!holds) return reject(state, msg, ERROR_CODES.NOT_LOCK_HOLDER, 'must hold the lock');
    } else if (!isOwner) {
      return reject(state, msg, ERROR_CODES.NOT_OWNER, 'exclusive mode: owner only');
    }
  }

  // config.presentation value SHAPES are validated on EVERY authoring path, not just CREATE:
  // a mis-authored presentation arriving via UPDATE (e.g. layout:"circle") is rejected the
  // same way it would be at CREATE. Same catalogue-driven domains (validatePresentation).
  if (msg.config?.presentation !== undefined) {
    const presErr = validatePresentation(canvas.view, msg.config.presentation);
    if (presErr) return reject(state, msg, ERROR_CODES.VALIDATION, presErr, 'presentation.domain');
  }

  // --- resolve bookkeeping (validate before applying anything) -------------
  let pending = canvas.pending;
  if (msg.resolves !== undefined) {
    if (!canvas.pending[msg.resolves]) {
      return reject(state, msg, ERROR_CODES.UNKNOWN_PENDING, 'no such open pending');
    }
    pending = { ...canvas.pending };
    delete pending[msg.resolves];
  }

  // --- apply (atomic) ------------------------------------------------------
  const next = { ...canvas };
  let changed = false;
  if (msg.resolves !== undefined) {
    next.pending = pending;
    changed = true;
  }
  if (msg.content !== undefined) {
    next.content = mergeContent(canvas.content, msg.content);
    changed = true;
  }
  // Presentation is the durable replacement for ops: a declarative render-param
  // patch (positions / layout / colorBy / filter), keyed-merged like content.
  if (msg.config !== undefined) {
    const merged = mergeConfigPatch(canvas.config, msg.config);
    if (merged !== canvas.config) {
      next.config = merged;
      changed = true;
    }
  }
  if (msg.mode !== undefined) {
    next.mode = msg.mode;
    changed = true;
  }
  if (msg.title !== undefined) {
    next.title = msg.title;
    changed = true;
  }
  if (msg.display !== undefined) {
    next.display = msg.display;
    changed = true;
  }
  if (msg.order !== undefined) {
    next.order = msg.order;
    changed = true;
  }

  const effects = [];
  // Holder authoring write refreshes the lock lease.
  let leaseRefreshed = false;
  if (hasAuthoring && canvas.mode === 'collaborative' && next.lock) {
    const expires = ctx.now + LOCK_LEASE_MS;
    next.lock = { ...next.lock, expires };
    effects.push(schedule({ kind: 'lock', canvasId: msg.canvasId, expires }));
    leaseRefreshed = true;
  }

  const rev = changed ? state.rev + 1 : state.rev;
  next.rev = rev;
  // UPDATE_CANVAS carries no lock field; on a lease refresh, carry it so replicas
  // don't reconstruct a stale (closer-to-expiry) lease until a re-snapshot.
  const delta = leaseRefreshed ? { ...msg, rev, lock: next.lock } : { ...msg, rev };
  // A `resolves` removes a pending server-side; carry the updated map so replicas
  // clear it too (the request frame has `resolves` but not the new pending map).
  if (msg.resolves !== undefined) delta.pending = next.pending;
  effects.unshift(broadcast(delta));
  return { state: changed ? withCanvas(state, msg.canvasId, next, rev) : state, effects };
}

/** @returns {Result} */
function closeCanvas(/** @type {State} */ state, /** @type {any} */ msg) {
  const canvas = state.canvases[msg.canvasId];
  if (!canvas) return reject(state, msg, ERROR_CODES.CANVAS_NOT_FOUND, 'unknown canvas');
  if (canvas.closed) return reject(state, msg, ERROR_CODES.CANVAS_CLOSED, 'already closed');
  if (isAgent(msg.source) && msg.source !== canvas.owner) {
    return reject(state, msg, ERROR_CODES.NOT_OWNER, 'only the owner agent may close'); // user may close any
  }
  const rev = state.rev + 1;
  const next = { ...canvas, closed: true, rev };
  return {
    state: withCanvas(state, msg.canvasId, next, rev),
    effects: [
      broadcast({
        type: 'CLOSE_CANVAS',
        canvasId: msg.canvasId,
        source: msg.source,
        reqId: msg.reqId,
        rev,
      }),
    ],
  };
}

/** @returns {Result} */
function cancelPending(/** @type {State} */ state, /** @type {any} */ msg) {
  const canvas = state.canvases[msg.canvasId];
  if (!canvas) return reject(state, msg, ERROR_CODES.CANVAS_NOT_FOUND, 'unknown canvas');
  if (!canvas.pending[msg.pendingId]) return { state, effects: [] }; // already gone -> no-op
  const pending = { ...canvas.pending };
  delete pending[msg.pendingId];
  const rev = state.rev + 1;
  const next = { ...canvas, pending, rev };
  return {
    state: withCanvas(state, msg.canvasId, next, rev),
    effects: [
      broadcast({
        type: 'CANCEL_PENDING',
        canvasId: msg.canvasId,
        pendingId: msg.pendingId,
        pending,
        reqId: msg.reqId,
        rev,
      }),
    ],
  };
}

const dedupKeyOf = (/** @type {any} */ p) =>
  p.action ? `a:${p.action}|${p.path ?? ''}` : `c:${p.control}`;

/** Coordination overlay paths — catalogue `coordination_paths`, not action-id suffixes. */
function coordinationPaths(/** @type {any} */ msg, /** @type {any} */ canvas) {
  return coordinationPathsFor(canvas.view, msg.action ?? '', msg.path);
}

/** Onset action whose broadcasts apply when an end/deselect action fires. */
function pairedOnsetAction(/** @type {any} */ msg, /** @type {any} */ canvas) {
  return onsetActionForBroadcast(canvas.view, msg.action ?? '');
}

function canvasEvent(/** @type {State} */ state, /** @type {any} */ msg, /** @type {Ctx} */ ctx) {
  const canvas = state.canvases[msg.canvasId];
  if (!canvas) return reject(state, msg, ERROR_CODES.CANVAS_NOT_FOUND, 'unknown canvas');
  if (canvas.closed) return reject(state, msg, ERROR_CODES.CANVAS_CLOSED, 'canvas is closed');

  // Resolve the published binding. An action binds against config.actions;
  // a control against the controls list.
  const entry = msg.action ? canvas.config?.actions?.[msg.action] : undefined;
  const ctrl = msg.control
    ? (canvas.config?.controls ?? []).find((/** @type {any} */ c) => c.id === msg.control)
    : undefined;
  // Generalized fire_action: an agent may invoke any PUBLISHED action/control
  // (one the owner declared). A bare gesture the owner never published is rejected.
  if (isAgent(msg.source)) {
    if (msg.action && !entry) {
      return reject(state, msg, ERROR_CODES.NOT_A_CONSEQUENCE, 'action is not published');
    }
    if (msg.control && !ctrl) {
      return reject(state, msg, ERROR_CODES.NOT_A_CONSEQUENCE, 'no such control');
    }
    // fire_action value CONTRACT (catalogue-driven, the same signature read_canvas exposes):
    // (1) SHAPE/TYPE — the value carries the declared keys with the declared types (a wrong-keyed
    // {source,target} for add_edge's {from,to}, or a mistyped x:"5", is rejected up front); and
    // (2) REFERENTIAL — any id/path the value names must resolve to a REAL element in THIS canvas
    // (add_edge between nonexistent nodes / add_line into a nonexistent paragraph is rejected).
    // Both fail with VALIDATION so the owner never mis-resolves garbage and the agent re-fires.
    // Gestured user values are view-built (trusted) — this is the agent-fire path only.
    if (msg.action) {
      const valErr = validateValue(canvas.view, msg.action, msg.value);
      if (valErr) return reject(state, msg, ERROR_CODES.VALIDATION, valErr, 'value.shape');
      const refErr = validateValueRefs(canvas.view, msg.action, msg.value, canvas.content);
      if (refErr) return reject(state, msg, ERROR_CODES.VALIDATION, refErr, 'value.ref');
    }
  }

  // Consequence-ness is a STRUCTURAL fact of the view (catalogue.json), not an agent
  // choice. A control that `fires` a consequence action carries that action id, so it
  // arms the SAME pending as the built-in chrome — the two paths are identical.
  const consequence = msg.action ? isConsequenceAction(canvas.view, msg.action) : false;
  const effectNames = msg.action ? actionLocalEffects(canvas.view, msg.action) : [];
  const onsetAction = msg.action ? pairedOnsetAction(msg, canvas) : null;
  const highlightKinds = msg.action
    ? (actionBroadcasts(canvas.view, msg.action).length
        ? actionBroadcasts(canvas.view, msg.action)
        : onsetAction
          ? actionBroadcasts(canvas.view, onsetAction)
          : []
      ).filter((/** @type {string} */ k) => k !== 'attention')
    : [];
  const joinKey = msg.ref ?? msg.path; // ref joins across views; else the element address
  const paths = coordinationPaths(msg, canvas);

  let next = canvas;
  let pendingId;
  const effects = [];

  // 1) consequence -> mint a pending (deduped on the open (action|path)/control set).
  if (consequence) {
    const dedupKey = dedupKeyOf(msg); // one canonicalization site (same helper the scan uses)
    const dup = Object.values(canvas.pending).some((p) => dedupKeyOf(p) === dedupKey);
    if (!dup) {
      pendingId = ctx.mintId();
      const pendingEntry = {
        pendingId,
        action: msg.action,
        control: msg.control,
        path: msg.path,
        paths,
        value: msg.value,
        source: msg.source,
        expires: ctx.now + PENDING_LEASE_MS,
      };
      next = { ...next, pending: { ...next.pending, [pendingId]: pendingEntry } };
      effects.push(
        schedule({
          kind: 'pending',
          canvasId: msg.canvasId,
          pendingId,
          expires: pendingEntry.expires,
        }),
      );
    }
  }

  // 2) an AGENT firing a local-effect writes the source-keyed appliedEffects overlay
  // (the agent has no view of its own; a user's local_effect stays client-side).
  let wroteAppliedEffects = false;
  if (isAgent(msg.source) && effectNames.length && joinKey) {
    const ae = { ...(next.appliedEffects ?? {}) };
    ae[joinKey] = { ...(ae[joinKey] ?? {}), [msg.source]: { effects: effectNames } };
    next = { ...next, appliedEffects: ae };
    wroteAppliedEffects = true;
  }

  // 3) coordination/message-ref kinds write the highlight[joinKey][source][kind]
  // overlay. End/deselect/canvas-clear actions carry a path but write empty paths
  // (clears that source's entry); empty parents are pruned so the overlay never lingers.
  let wroteHighlight = false;
  if (highlightKinds.length && joinKey) {
    const cur = next.highlight?.[joinKey]?.[msg.source] ?? {};
    const same = (/** @type {string[]} */ a, /** @type {string[]} */ b) =>
      a.length === b.length && a.every((p, i) => p === b[i]);
    // Idempotent: setting the same paths (or clearing what's already absent) is a
    // no-op — so a re-fired hover doesn't bump rev / re-broadcast.
    const willChange = highlightKinds.some((/** @type {string} */ k) =>
      paths.length ? !cur[k] || !same(cur[k].paths ?? [], paths) : cur[k] !== undefined,
    );
    if (willChange) {
      const hl = { ...(next.highlight ?? {}) };
      const bySource = { ...(hl[joinKey] ?? {}) };
      const byKind = { ...(bySource[msg.source] ?? {}) };
      for (const k of highlightKinds) {
        if (paths.length) byKind[k] = { paths };
        else delete byKind[k];
      }
      if (Object.keys(byKind).length) bySource[msg.source] = byKind;
      else delete bySource[msg.source];
      if (Object.keys(bySource).length) hl[joinKey] = bySource;
      else delete hl[joinKey];
      next = { ...next, highlight: hl };
      wroteHighlight = true;
    }
  }

  // 4) presentation op — a presentation change is ALWAYS an explicit `config.presentation`
  // patch on the event, keyed-merged into `config.presentation` (UPDATE_CANVAS is agent-only,
  // so a USER's presentation rides the event). ONE mechanism for every presentation value,
  // scalar or compound: the SINGLE SOURCE OF TRUTH is `config.presentation[key]`, and every
  // writer addresses the same (possibly dotted) key path via a keyed-merge —
  //   - the built-in chrome/gesture computes the full value and sends `{ presentation: { <key>: <value> } }`
  //     (e.g. sort → `{ sort: { colId, dir } }`, collapse → `{ collapsed: [...] }`, focus → `{ focus }`);
  //   - an agent-composed control uses `writes: '<dotted key>'` → `{ presentation: patchPath(key, value) }`
  //     (e.g. `writes: 'sort.colId'` → `{ sort: { colId } }`), which keyed-merges into the SAME key.
  // So chrome and controller never diverge — no per-action `presentation` target, no scalar-over-
  // structured clobber. Controls that `fires` an action are for consequence/local_effect only;
  // presentation is driven exclusively through `writes`. ONLY presentation is honored on the event
  // (actions are immutable, controls owner-only).
  const presPatch = msg.config?.presentation;
  if (presPatch !== undefined) {
    const merged = mergeConfigPatch(next.config, { presentation: presPatch });
    if (merged !== next.config) next = { ...next, config: merged };
  }

  const changed = next !== canvas;
  const rev = changed ? state.rev + 1 : state.rev;
  if (changed) next = { ...next, rev };

  const deliver = { ...msg, pendingId: pendingId ?? msg.pendingId, rev };
  // carry the effective presentation patch so replicas merge the SAME thing (the declared
  // target write isn't in msg — it's computed from action+value here).
  if (presPatch !== undefined) deliver.config = { presentation: presPatch };
  if (pendingId) deliver.pending = next.pending; // carry the maps so replicas track them
  if (wroteAppliedEffects) deliver.appliedEffects = next.appliedEffects;
  if (wroteHighlight) deliver.highlight = next.highlight;
  effects.unshift(broadcast(deliver));
  return { state: changed ? withCanvas(state, msg.canvasId, next, rev) : state, effects };
}

/** @returns {Result} */
function lockMsg(/** @type {State} */ state, /** @type {any} */ msg, /** @type {Ctx} */ ctx) {
  const canvas = state.canvases[msg.canvasId];
  if (canvas?.mode !== 'collaborative') return { state, effects: [] }; // ignored
  if (!isAgent(msg.source)) return { state, effects: [] }; // the human never locks; agents only
  const cur = canvas.lock;
  const active = (cur?.expires ?? 0) > ctx.now;

  if (msg.op === 'claim' || msg.op === 'renew') {
    // held by another -> no-op. Possible refinement: emit a toCaller hint here so the
    // loser learns immediately (instead of the bridge blocking ~half a lease for a
    // broadcast that never comes). Reachable only under concurrent collaborative authoring.
    if (active && cur.holder !== msg.source) return { state, effects: [] };
    const expires = ctx.now + LOCK_LEASE_MS;
    const rev = state.rev + 1;
    const next = { ...canvas, lock: { holder: msg.source, expires }, rev };
    return {
      state: withCanvas(state, msg.canvasId, next, rev),
      effects: [
        broadcast({ type: 'UPDATE_CANVAS', canvasId: msg.canvasId, lock: next.lock, rev }),
        schedule({ kind: 'lock', canvasId: msg.canvasId, expires }),
      ],
    };
  }
  if (msg.op === 'release') {
    if (!active || cur.holder !== msg.source) return { state, effects: [] };
    const rev = state.rev + 1;
    const next = { ...canvas, lock: null, rev };
    return {
      state: withCanvas(state, msg.canvasId, next, rev),
      effects: [broadcast({ type: 'UPDATE_CANVAS', canvasId: msg.canvasId, lock: null, rev })],
    };
  }
  return { state, effects: [] };
}

/** @returns {Result} */
function leaseExpired(/** @type {State} */ state, /** @type {any} */ msg) {
  const canvas = state.canvases[msg.canvasId];
  if (!canvas) return { state, effects: [] };
  if (msg.kind === 'lock') {
    if (!canvas.lock || canvas.lock.expires !== msg.scheduledExpires) return { state, effects: [] }; // stale-after-renew
    const rev = state.rev + 1;
    const next = { ...canvas, lock: null, rev };
    return {
      state: withCanvas(state, msg.canvasId, next, rev),
      effects: [broadcast({ type: 'UPDATE_CANVAS', canvasId: msg.canvasId, lock: null, rev })],
    };
  }
  if (msg.kind === 'pending') {
    if (!canvas.pending[msg.pendingId]) return { state, effects: [] }; // entry gone
    const pending = { ...canvas.pending };
    delete pending[msg.pendingId];
    const rev = state.rev + 1;
    const next = { ...canvas, pending, rev };
    return {
      state: withCanvas(state, msg.canvasId, next, rev),
      effects: [broadcast({ type: 'UPDATE_CANVAS', canvasId: msg.canvasId, pending, rev })],
    };
  }
  return { state, effects: [] };
}

/** @returns {Result} */
function chat(/** @type {State} */ state, /** @type {any} */ msg) {
  return { state: { ...state, messages: [...state.messages, msg] }, effects: [broadcast(msg)] };
}
