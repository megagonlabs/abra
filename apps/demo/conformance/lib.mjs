// @ts-check
/** Conformance helpers — catalogue-driven classification + domain checks + wait-for-stable. */
import actionPresentation from '../../../packages/abra-views/src/views/shared/manifests/actionPresentation.json' with {
  type: 'json',
};
import catalogue from '../../../packages/abra-views/src/views/shared/manifests/catalogue.json' with {
  type: 'json',
};

const comps = /** @type {any} */ (catalogue).view?.canvas_components ?? {};
const ap = /** @type {any} */ (actionPresentation);

export function viewActions(/** @type {string} */ view) {
  return comps[view]?.actions ?? {};
}
export function presDomain(/** @type {string} */ view, /** @type {string} */ key) {
  return comps[view]?.presentation?.[key]?.domain ?? null;
}
export function isConsequence(/** @type {string} */ view, /** @type {string} */ action) {
  return viewActions(view)[action]?.consequence === true;
}

/** classify an action's declared outcome: consequence | presentation | coordination | local_effect | other */
export function outcome(/** @type {string} */ view, /** @type {string} */ action) {
  if (isConsequence(view, action)) return 'consequence';
  const row = ap[view]?.[action] ?? {};
  if (row.presentation) return 'presentation';
  if ((row.broadcasts ?? []).includes('coordination')) return 'coordination';
  if ((row.view_private ?? []).length) return 'local_effect';
  return 'other';
}

/** check a value against a catalogue domain spec (mirrors the reducer's validator). */
export function checkDomain(/** @type {any} */ val, /** @type {any} */ dom) {
  if (val == null || !dom) return null;
  switch (dom.kind) {
    case 'string':
      return typeof val === 'string' ? null : 'expected a string';
    case 'number':
      return typeof val === 'number' ? null : 'expected a number';
    case 'list':
      return Array.isArray(val) ? null : 'expected a list';
    case 'enum':
      return typeof val === 'string' && dom.values.includes(val)
        ? null
        : `expected one of ${dom.values.join('|')}`;
    case 'object': {
      if (typeof val !== 'object' || Array.isArray(val)) return 'expected an object';
      for (const [f, fd] of Object.entries(dom.fields ?? {})) {
        const e = checkDomain(val[f], fd);
        if (e) return `${f}: ${e}`;
      }
      return null;
    }
    default:
      return null;
  }
}

/** the members of a hover/select pair, or null if `a` isn't a pair onset. */
export function pairEnd(/** @type {string} */ a) {
  if (a.startsWith('highlight_')) return a.replace(/^highlight_/, 'dehighlight_');
  if (a.startsWith('select_')) return a.replace(/^select_/, 'deselect_');
  return null;
}

/** Wait until a locator's count stays constant for `idle` ms (agents finish building), capped at `timeout`. */
export async function waitForStable(page, selector, { idle = 8000, timeout = 120000 } = {}) {
  const start = Date.now();
  let last = -1;
  let lastChange = Date.now();
  while (Date.now() - start < timeout) {
    const n = await page.locator(selector).count();
    if (n !== last) {
      last = n;
      lastChange = Date.now();
    } else if (n > 0 && Date.now() - lastChange >= idle) {
      return n;
    }
    await page.waitForTimeout(1000);
  }
  return last;
}

/** Read the agents' authored CREATE_CANVAS frames from the in-page WS log (see wslog.js). */
export async function authoredCanvases(page) {
  return page.evaluate(() =>
    /** @type {any} */ (window.abraWsLog?.frames ?? [])
      .filter((/** @type {any} */ f) => f.dir === 'in' && f.frame?.type === 'CREATE_CANVAS')
      .map((/** @type {any} */ f) => f.frame),
  );
}

/** All frames from the in-page WS log (for post-interaction assertions). */
export async function wsFrames(page) {
  return page.evaluate(() => /** @type {any} */ (window).abraWsLog?.frames ?? []);
}
