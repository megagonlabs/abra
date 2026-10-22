// @ts-check
/**
 * CONFORMANCE PROPERTIES — the spec of record for the "generated-interface conformance" suite.
 *
 * Unlike the deterministic e2e (mock hub, scripted frames), this suite drives the REAL agent
 * stack: it sends the same query N times and, for WHATEVER the agents author, asserts INVARIANTS
 * that must hold for any valid output. The assertions are catalogue-driven — ABRA's bounded,
 * typed substrate enumerates each action's outcome type, so "does every published affordance
 * actually work per its declared semantics?" is checkable for any generated interface.
 *
 * `scope`: static  = derivable from the authored CREATE frame + catalogue (no interaction)
 *          dynamic = requires driving the browser (hover/click) and observing the result
 * `status`: checked = exercised by conformance.spec.js today
 *           partial = exercised in a limited way (common affordances only)
 *           listed  = specified here, driver not yet built (needs per-action interaction)
 *
 * Review this list and edit freely — it's the contract the driver iterates.
 */

export const PROPERTIES = [
  // ---- render health -------------------------------------------------------
  {
    id: 'P0.render-health',
    scope: 'dynamic',
    status: 'checked',
    desc: 'Every authored canvas renders a LIVE view (its [data-view] panel is visible), never raw JSON or an empty/unknown pane; and no uncaught page error fires during the session.',
  },
  // ---- the published binding is well-formed (C1) ---------------------------
  {
    id: 'P1.actions-known',
    scope: 'static',
    status: 'checked',
    desc: 'Every key in config.actions is a real action of that view (present in catalogue.json). No invented actions.',
  },
  {
    id: 'P2.actions-have-meaning',
    scope: 'static',
    status: 'checked',
    desc: 'Every published action carries a non-empty `meaning`; hover/select pairs are published whole (highlight_+dehighlight_, select_+deselect_).',
  },
  {
    id: 'P3.presentation-in-domain',
    scope: 'static',
    status: 'checked',
    desc: 'Every config.presentation value conforms to its catalogue domain (e.g. graph.layout ∈ {force,dagre,group}). Catches ghost values like layout:"circle".',
  },
  // ---- controls ------------------------------------------------------------
  {
    id: 'P4.controls-render',
    scope: 'dynamic',
    status: 'checked',
    desc: 'Every config.controls widget actually renders in the header (count of .abra-ctrl* matches config.controls).',
  },
  {
    id: 'P5.control-options-valid',
    scope: 'static',
    status: 'checked',
    desc: 'Every `writes` control drives a real presentation key, and a select control\'s `options` are within that key\'s catalogue domain (no ghost option like a "circle" layout).',
  },
  {
    id: 'P6.presentation-control-works',
    scope: 'dynamic',
    status: 'checked',
    desc: 'Activating a `writes` presentation control emits a config.presentation patch, bumps rev, and re-renders the view (the value it wrote is reflected back).',
  },
  // ---- coordination (C2 substrate) -----------------------------------------
  {
    id: 'P7.coordination-hover',
    scope: 'dynamic',
    status: 'checked',
    desc: 'Hovering a ref-bearing element (a hover-published element) writes canvas.highlight for its joinKey — the coordination overlay actually turns on.',
  },
  {
    id: 'P8.cross-view-fanout',
    scope: 'dynamic',
    status: 'partial',
    desc: 'If two visible canvases share a `ref`, hovering the element in one lights its co-referent element (.abra-coord) in the other view.',
  },
  // ---- consequences (owner-resolved) ---------------------------------------
  {
    id: 'P9.consequence-round-trips',
    scope: 'dynamic',
    status: 'listed',
    desc: 'Triggering a consequence action (add_*/edit_*/delete/clear, or a control that fires one) mints a pending ("working…"), then the owner resolves it (content changes) within T seconds — or it times out without a stuck/duplicated state.',
  },
  {
    id: 'P10.no-dead-affordance',
    scope: 'dynamic',
    status: 'partial',
    desc: 'Every DOM-triggerable published action produces SOME observable effect (overlay / selection / presentation change / pending). Catches "published but does nothing" (e.g. a consequence action with no arming).',
  },
  // ---- media (Display) -----------------------------------------------------
  {
    id: 'P11.images-load',
    scope: 'dynamic',
    status: 'checked',
    desc: 'In a display canvas, every <img> actually loads (naturalWidth > 0) or a fallback element is shown — never a broken-image icon. Catches hallucinated / dead / hot-link-blocked image URLs.',
  },
  {
    id: 'P12.media-urls-reachable',
    scope: 'static',
    status: 'listed',
    desc: 'Display media URLs return 2xx (a HEAD/GET check). Complements P11 by attributing a failure to the URL vs the renderer.',
  },
];

/** The subset the driver exercises today (status === 'checked'). */
export const CHECKED = PROPERTIES.filter((p) => p.status === 'checked').map((p) => p.id);
