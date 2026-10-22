// @ts-check
/**
 * WS client — partysocket's reconnecting WebSocket (never replays buffered
 * writes). Resync is by re-snapshot, not delta-replay: every (re)open sends JOIN
 * and the hub answers with a full SNAPSHOT, so a dropped connection self-heals.
 * Explicit rev-gap detection is intentionally omitted — a gap implies a disconnect
 * (WS-over-TCP is in-order on a live socket), which the reconnect-snapshot already
 * covers. On open it sends JOIN; every inbound
 * frame is handed to `onFrame` (the store's sole writer). Outbound participant
 * frames get a per-client `seq`; the hub stamps `source`.
 */
import { WebSocket } from 'partysocket';
import { logFrame } from './wslog.js';

/**
 * @typedef {'connected' | 'reconnecting'} ConnStatus
 */

/**
 * @param {{ url: string, sessionId: string, source: string, connectToken?: string,
 *           onFrame: (frame: any) => void, onStatus?: (status: ConnStatus) => void }} opts
 */
export function connectHub({ url, sessionId, source, connectToken = 'dev', onFrame, onStatus }) {
  const ws = new WebSocket(url, [], { maxEnqueuedMessages: 0 });
  let seq = 0;

  // Connection dot reflects the live socket: green on open, amber while the
  // reconnecting socket is down (close fires per drop; partysocket retries).
  ws.addEventListener('open', () => {
    onStatus?.('connected');
    const join = { type: 'JOIN', sessionId, connectToken, source };
    logFrame('out', join);
    ws.send(JSON.stringify(join));
  });
  ws.addEventListener('close', () => onStatus?.('reconnecting'));
  ws.addEventListener('message', (/** @type {any} */ e) => {
    try {
      const frame = JSON.parse(e.data);
      logFrame('in', frame); // record every inbound frame for manual review (see wslog.js)
      onFrame(frame);
    } catch {
      /* ignore non-JSON */
    }
  });

  return {
    /** @param {any} frame */
    send: (frame) => {
      const stamped = { ...frame, seq: seq++ };
      logFrame('out', stamped); // record every outbound participant write
      ws.send(JSON.stringify(stamped));
    },
    close: () => ws.close(),
  };
}
