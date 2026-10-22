// @ts-check
/**
 * The ≤2-pane panel split = a capped, ordered "visible set" (the decided UX:
 * tabs + a per-tab show-toggle). Pure + framework-agnostic so it can be unit-tested.
 *
 * @param {string[]} visible current ordered visible ids
 * @param {string} id the tab being toggled
 * @param {number} [cap] max simultaneously visible (V1 = 2; raise to reach the 2–4 bound)
 * @returns {string[]} the next visible set
 */
export function toggleVisible(visible, id, cap = 2) {
  const next = visible.filter((x) => x !== id);
  if (next.length === visible.length) {
    next.push(id); // wasn't shown -> add it
    while (next.length > cap) next.shift(); // drop the oldest beyond the cap
  }
  return next; // was shown -> now hidden
}
