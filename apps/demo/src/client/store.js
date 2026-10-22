// @ts-check
/**
 * Render replica store (Zustand vanilla). The WS client is the SOLE writer:
 * every hub frame goes through `applyFrame`. Canvas/chat frames flow through the
 * shared `applyDelta` (no speculative reduction — state changes only on
 * authoritative broadcasts). PARTICIPANTS / LIBRARY are *shell* frames (outside
 * the abra-spec contract, human-facing) — they are NOT canvas state, so
 * `applyDelta` does not handle them; they land in their own slices here.
 */
import { applyDelta } from 'abra-reducer/apply';
import { createStore } from 'zustand/vanilla';

/**
 * @typedef {{ name: string, present: boolean, phase: string, busy: boolean, lastError: string|null }} Participant
 * @typedef {{ name: string, type: string, blurb: string }} LibraryAgent
 */

export function createReplicaStore() {
  return createStore((set) => ({
    rev: 0,
    canvases: {},
    messages: [],
    /** @type {Participant[]} the session cast (shell frame, human-facing) */
    participants: [],
    /** @type {LibraryAgent[]} the addable agent library (shell frame) */
    library: [],
    /** @param {any} frame */
    applyFrame: (frame) =>
      set((/** @type {any} */ s) => {
        switch (frame?.type) {
          case 'PARTICIPANTS':
            return { ...s, participants: frame.agents ?? [] };
          case 'LIBRARY':
            return { ...s, library: frame.agents ?? [] };
          default:
            return applyDelta(s, frame);
        }
      }),
  }));
}
