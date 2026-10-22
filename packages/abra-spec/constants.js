// @ts-check
/**
 * Runtime constants for the contract. The wire *types* are generated
 * (./gen/index.d.ts); these are the *values* the reducer/hub need.
 */

/** Lock lease (ms). Fires only on a crash. Renew = reset-to-full; heartbeat ~= half-lease. */
export const LOCK_LEASE_MS = 30_000;

/**
 * Pending-consequence lease (ms). `>> LOCK_LEASE_MS` so a resolver never times
 * out while waiting for the lock (no pending-pause, no lock queue).
 */
export const PENDING_LEASE_MS = 120_000;

/** Closed ERROR.code set (mirrors the schema enum). */
export const ERROR_CODES = Object.freeze({
  CANVAS_NOT_FOUND: 'CANVAS_NOT_FOUND',
  CANVAS_CLOSED: 'CANVAS_CLOSED',
  IMMUTABLE_FIELD: 'IMMUTABLE_FIELD',
  NOT_OWNER: 'NOT_OWNER',
  NOT_LOCK_HOLDER: 'NOT_LOCK_HOLDER',
  UNKNOWN_PENDING: 'UNKNOWN_PENDING',
  NOT_A_CONSEQUENCE: 'NOT_A_CONSEQUENCE',
  VALIDATION: 'VALIDATION',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
});
