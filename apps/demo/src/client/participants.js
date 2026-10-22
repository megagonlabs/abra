// @ts-check
/**
 * Participant status derivation — the single source for the strip + popover
 * status dot/label. A participant arrives as `{ present, phase, busy, lastError }`
 * (the hub's combined presence + host report); we collapse that to one of the
 * four agreed shell labels. `crashed` wins (a crash is terminal until restart);
 * a not-yet-present / `starting` agent is `starting`; a busy online agent is
 * `working`; otherwise `online`. (Status is human-facing — never an agent input.)
 *
 * @typedef {'online' | 'working' | 'starting' | 'crashed'} Status
 */

/**
 * @param {{ present?: boolean, phase?: string, busy?: boolean }} p
 * @returns {Status}
 */
export function statusOf(p) {
  if (p.phase === 'crashed') return 'crashed';
  if (!p.present || p.phase === 'starting') return 'starting';
  if (p.busy) return 'working';
  return 'online';
}
