// @ts-check
/**
 * Session — the reducer-driver. Holds the authoritative reducer state for one
 * session and turns inbound frames into effects: broadcast deltas to all
 * participants, route ERRORs to the caller, and run lease timers (which re-enter
 * the reducer as synthetic LEASE_EXPIRED). The WS transport (hub.js) is a thin
 * shell around this; now/mintId/timers are injected so the session loop stays
 * deterministic and easy to exercise.
 */
import { randomUUID } from 'node:crypto';
import { initialState, reduce } from 'abra-reducer';

/** @typedef {{ send: (frame: any) => void }} Participant */

export class Session {
  /** @param {Partial<{ now:()=>number, mintId:()=>string, setTimer:Function, clearTimer:Function }>} [deps] */
  constructor(deps = {}) {
    this.deps = {
      now: deps.now ?? (() => Date.now()),
      mintId: deps.mintId ?? (() => randomUUID()),
      setTimer: deps.setTimer ?? setTimeout,
      clearTimer: deps.clearTimer ?? clearTimeout,
    };
    this.state = initialState();
    /** @type {Map<string, Participant>} */
    this.participants = new Map();
    /** @type {Map<string, number>} per-source seq high-water-mark */
    this.seqHi = new Map();
    /** @type {Map<string, any>} lease timers keyed by lock:cid / pending:cid:pid */
    this.timers = new Map();
  }

  snapshot() {
    return {
      type: 'SNAPSHOT',
      canvases: this.state.canvases,
      messages: this.state.messages,
      rev: this.state.rev,
    };
  }

  /** @param {string} source @param {(frame:any)=>void} send */
  join(source, send) {
    this.participants.set(source, { send });
    send(this.snapshot());
  }

  /** @param {string} source */
  leave(source) {
    this.participants.delete(source);
    // Drop the seq high-water-mark too: a same-source reconnect (the client's seq
    // resets to 0) within the hub's empty-grace window must not have its writes
    // dropped as "replays" against a stale max.
    this.seqHi.delete(source);
  }

  /** Handle an inbound participant frame (source already stamped by the hub). @param {any} frame */
  handle(frame) {
    const src = frame.source;
    if (typeof src === 'string' && typeof frame.seq === 'number') {
      const last = this.seqHi.get(src);
      if (last !== undefined && frame.seq <= last) return; // dedup / replay drop
      this.seqHi.set(src, frame.seq);
    }
    this.#apply(frame);
  }

  /** @param {any} frame */
  #apply(frame) {
    const { state, effects } = reduce(this.state, frame, {
      now: this.deps.now(),
      mintId: this.deps.mintId,
    });
    this.state = state;
    for (const e of effects) this.#runEffect(e);
  }

  /** @param {any} e */
  #runEffect(e) {
    switch (e.kind) {
      case 'broadcast':
        for (const p of this.participants.values()) p.send(e.frame);
        break;
      case 'toCaller':
        this.participants.get(e.source)?.send(e.frame);
        break;
      case 'schedule':
        this.#scheduleLease(e.lease);
        break;
    }
  }

  /** @param {any} lease */
  #scheduleLease(lease) {
    const key =
      lease.kind === 'lock'
        ? `lock:${lease.canvasId}`
        : `pending:${lease.canvasId}:${lease.pendingId}`;
    const prev = this.timers.get(key);
    if (prev) this.deps.clearTimer(prev); // renew = reset
    const delay = Math.max(0, lease.expires - this.deps.now());
    const handle = this.deps.setTimer(() => {
      this.timers.delete(key);
      this.#apply({
        type: 'LEASE_EXPIRED',
        kind: lease.kind,
        canvasId: lease.canvasId,
        pendingId: lease.pendingId,
        scheduledExpires: lease.expires,
      });
    }, delay);
    this.timers.set(key, handle);
  }
}
