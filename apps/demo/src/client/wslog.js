// @ts-check
/**
 * WS frame log — an in-memory record of every frame the client exchanges with the hub
 * (inbound broadcasts + outbound participant writes), each tagged with a direction and a
 * timestamp. `exportLog()` downloads the whole buffer as JSON for manual review; the buffer
 * accumulates from connect until export/clear ("everything up to this point"). Also exposed
 * on `window.abraWsLog` for console use (`abraWsLog.export()` / `.frames` / `.clear()`).
 */

/** @typedef {{ n: number, t: number, iso: string, dir: 'in' | 'out', frame: any }} LogEntry */

/** @type {LogEntry[]} */
const buf = [];
let n = 0;

/** Record one frame. @param {'in' | 'out'} dir @param {any} frame */
export function logFrame(dir, frame) {
  const t = Date.now();
  buf.push({ n: n++, t, iso: new Date(t).toISOString(), dir, frame });
}

/** The raw buffer (live reference — read only). */
export function frames() {
  return buf;
}

/** Clear the buffer (start a fresh capture window). */
export function clearLog() {
  buf.length = 0;
  n = 0;
}

/** Download the buffered frames as a JSON file. @param {string} [filename] @returns {number} count */
export function exportLog(filename) {
  const t = Date.now();
  const payload = {
    exportedAt: new Date(t).toISOString(),
    count: buf.length,
    // frames in order, each: { n, t (epoch ms), iso, dir: 'in'|'out', frame }
    frames: buf,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename ?? `abra-ws-log-${t}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return buf.length;
}

// console access for manual review
if (typeof window !== 'undefined') {
  /** @type {any} */ (window).abraWsLog = {
    export: exportLog,
    clear: clearLog,
    get frames() {
      return buf;
    },
    get count() {
      return buf.length;
    },
  };
}
