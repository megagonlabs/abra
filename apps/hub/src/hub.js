// @ts-check
/**
 * ABRA demo hub — the WS transport shell around Session.
 *
 * Connection lifecycle: a new socket must first send JOIN; the hub validates the
 * connectToken, binds the unspoofable `source`, attaches the participant to its
 * session (replying SNAPSHOT), and from then on stamps `source` on every inbound
 * frame so a client can never spoof another identity. WS guards: maxPayload cap +
 * permessage-deflate off.
 *
 * Control channel (shell-level — NOT part of the abra-spec contract): a connection
 * that JOINs with `role:'control'` (the agent host) is not attached to a session.
 * It RECEIVES session-lifecycle frames (SESSION_OPENED when the first *user* enters a
 * session, SESSION_EMPTY when the last leaves, after a grace window) and relayed UI
 * intents (ADD_AGENT/REMOVE_AGENT, stamped with the UI's sessionId); it SENDS the
 * host's AGENT_STATUS + LIBRARY. The hub combines its own agent *presence* with the
 * host's status into a per-session PARTICIPANTS view, broadcast to the session's users
 * only (participant status is human-facing). Agents don't count as users, so a session
 * is "open" iff a human is present.
 */
import { WebSocket, WebSocketServer } from 'ws';
import { Session } from './session.js';

const DEFAULT_PORT = Number(process.env.PORT ?? 8787);
// Loopback unless explicitly opted into LAN exposure (`ABRA_HUB_HOST=0.0.0.0`). Identity is
// not verified in this demo build (see `authenticate`), so every reachable client can join.
const DEFAULT_HOST = process.env.ABRA_HUB_HOST ?? '127.0.0.1';
const MAX_PAYLOAD = 4 * 1024 * 1024;
/** Loopback page origins (any port: the dev server may pick 5174 when 5173 is busy). */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Extra browser origins allowed to open a hub socket, e.g. a LAN-served UI (comma-separated). */
const EXTRA_ORIGINS = new Set(
  (process.env.ABRA_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
/**
 * Origin gate for the WebSocket upgrade: a browser page may open a hub socket only from a
 * loopback origin (the local dev server) or an explicitly allowed one, which blocks
 * cross-site WebSocket hijacking by any other page open in the browser. Non-browser
 * clients (the agent host, agents) send no Origin header and are not origin-gated.
 * @param {string | undefined} origin
 */
export function originAllowed(origin) {
  if (!origin) return true;
  if (EXTRA_ORIGINS.has(origin)) return true;
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}
const DEFAULT_GRACE_MS = Number(process.env.GRACE_MS ?? 30_000); // keep a session (+ its agents) alive this long after the last user leaves — long enough to ride out a temporary network drop (not a laptop sleep; that's a fresh session)
const CONTROL_RELAY = new Set(['ADD_AGENT', 'REMOVE_AGENT']); // UI → host intents the hub forwards

/**
 * Connect-token -> bound source. Demo-only: accepts any non-empty token and binds
 * the claimed source. Replace with a real token->identity check before any shared
 * deployment.
 * @param {any} frame @returns {string | null}
 */
function authenticate(frame) {
  if (!frame?.connectToken || typeof frame?.source !== 'string') return null;
  return frame.source;
}

/** A human participant (vs an `agent:*` or the `host`). @param {string} s */
const isUser = (s) => typeof s === 'string' && s.startsWith('user:');
/** The agent name from an `agent:<name>` source (lowercased key), else null. @param {string} s */
const agentName = (s) => (typeof s === 'string' && s.startsWith('agent:') ? s.slice(6) : null);

/**
 * @param {number} [port]
 * @param {{ graceMs?: number, host?: string }} [opts]
 */
export function startHub(port = DEFAULT_PORT, opts = {}) {
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  // A hub owns its sessions (per-instance, not module-global).
  /** @type {Map<string, Session>} */
  const sessions = new Map();
  /** @type {Set<(f:any)=>void>} control-channel listeners (the host) */
  const controlListeners = new Set();
  /** @type {Map<string, number>} sessionId -> live user count */
  const userCounts = new Map();
  /** @type {Map<string, any>} sessionId -> pending empty-grace timer */
  const graceTimers = new Map();
  /** @type {Map<string, Map<string, any>>} sid -> name-key -> {name,present,phase,busy,lastError} */
  const sessionParticipants = new Map();
  /** @type {Array<any>} the host's addable library (host-wide; same for every session) */
  let library = [];
  /** @type {Map<string, Map<string, number>>} sid -> source -> the live connId. A reconnect *replaces* the entry; an older socket for the same source is "stale". */
  const currentConn = new Map();
  let connSeq = 0;

  /** Mark `connId` the live connection for (sid, source); returns true if it *replaced* an existing one (i.e. a reconnect). @param {string} sid @param {string} source @param {number} connId */
  const adoptConn = (sid, source, connId) => {
    let m = currentConn.get(sid);
    if (!m) {
      m = new Map();
      currentConn.set(sid, m);
    }
    const reconnect = m.has(source);
    m.set(source, connId);
    return reconnect;
  };
  /** Is `connId` still the live connection for (sid, source)? A replaced/stale socket is not. @param {string} sid @param {string} source @param {number} connId */
  const isLiveConn = (sid, source, connId) => currentConn.get(sid)?.get(source) === connId;
  /** Forget the live-connection record for (sid, source). @param {string} sid @param {string} source */
  const dropConn = (sid, source) => currentConn.get(sid)?.delete(source);

  /** @param {string} id @returns {Session} */
  const getSession = (id) => {
    let s = sessions.get(id);
    if (!s) {
      s = new Session();
      sessions.set(id, s);
    }
    return s;
  };

  /** @param {any} f */
  const notify = (f) => {
    for (const send of controlListeners) send(f);
  };

  // --- participant state (presence ⊕ host status), broadcast to users only ---
  /** @param {string} sid @param {string} key */
  const partEntry = (sid, key) => {
    let m = sessionParticipants.get(sid);
    if (!m) {
      m = new Map();
      sessionParticipants.set(sid, m);
    }
    let e = m.get(key);
    if (!e) {
      e = { name: key, present: false, phase: 'starting', busy: false, lastError: null };
      m.set(key, e);
    }
    return e;
  };
  /** @param {string} sid */
  const participantsFrame = (sid) => ({
    type: 'PARTICIPANTS',
    sessionId: sid,
    agents: [...(sessionParticipants.get(sid)?.values() ?? [])],
  });
  const libraryFrame = () => ({ type: 'LIBRARY', agents: library });
  /** Participant status is human-facing → only the *user* connections of a session get it. @param {string} sid @param {any} frame */
  const sendToUsers = (sid, frame) => {
    const s = sessions.get(sid);
    if (!s) return;
    for (const [source, p] of s.participants) if (isUser(source)) p.send(frame);
  };
  /** @param {string} sid */
  const broadcastParticipants = (sid) => sendToUsers(sid, participantsFrame(sid));
  /** Apply a host AGENT_STATUS report (`removed` deletes the entry). @param {any} f */
  const applyStatus = (f) => {
    const sid = f.sessionId;
    const key = String(f.name).toLowerCase();
    if (f.phase === 'removed') {
      sessionParticipants.get(sid)?.delete(key);
    } else {
      const e = partEntry(sid, key);
      e.name = f.name;
      if (f.phase !== undefined) e.phase = f.phase;
      if (f.busy !== undefined) e.busy = f.busy;
      if (f.lastError !== undefined) e.lastError = f.lastError;
    }
    broadcastParticipants(sid);
  };

  // --- session lifecycle ---
  /** @param {string} sid */
  const cancelGrace = (sid) => {
    const t = graceTimers.get(sid);
    if (t) {
      clearTimeout(t);
      graceTimers.delete(sid);
    }
  };
  /** @param {string} sid */
  const onUserJoin = (sid) => {
    const reviving = graceTimers.has(sid); // a user returned within the empty-grace window
    cancelGrace(sid);
    const n = userCounts.get(sid) ?? 0;
    if (n === 0 && !reviving) notify({ type: 'SESSION_OPENED', sessionId: sid }); // a genuinely new session
    userCounts.set(sid, n + 1);
  };
  /** @param {string} sid */
  const onUserLeave = (sid) => {
    const n = (userCounts.get(sid) ?? 1) - 1;
    userCounts.set(sid, n);
    if (n <= 0) {
      cancelGrace(sid);
      const t = setTimeout(() => {
        graceTimers.delete(sid);
        if ((userCounts.get(sid) ?? 0) <= 0) {
          userCounts.delete(sid);
          sessions.delete(sid); // reclaim the empty session
          sessionParticipants.delete(sid); // and its participant state
          currentConn.delete(sid); // and any lingering (e.g. half-open) conn records
          notify({ type: 'SESSION_EMPTY', sessionId: sid });
        }
      }, graceMs);
      graceTimers.set(sid, t);
    }
  };

  const wss = new WebSocketServer({
    host: opts.host ?? DEFAULT_HOST,
    port,
    maxPayload: MAX_PAYLOAD,
    perMessageDeflate: false,
    /** @param {{ origin?: string }} info */
    verifyClient: (info) => originAllowed(info.origin), // rejects the upgrade with 401
  });

  wss.on('connection', (socket) => {
    const connId = ++connSeq; // identifies THIS socket so a stale one can be told from a live reconnect
    /** @type {{ control: true } | { source: string, sessionId: string, session: Session, connId: number } | null} */
    let bound = null;
    /** @param {any} f */
    const send = (f) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(f));
    };

    socket.on('message', (data) => {
      let frame;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return; // ignore non-JSON
      }
      if (!bound) {
        if (frame?.type !== 'JOIN') {
          send({ type: 'ERROR', code: 'VALIDATION', message: 'expected JOIN' });
          return;
        }
        const source = authenticate(frame);
        if (!source) {
          send({ type: 'ERROR', code: 'VALIDATION', message: 'bad connectToken' });
          socket.close();
          return;
        }
        if (frame.role === 'control') {
          controlListeners.add(send);
          bound = { control: true };
          // A (re)connecting host may have missed sessions opened while it was down —
          // replay an OPENED for each currently-open session so it (re)adopts/spawns them.
          for (const [sid, n] of userCounts)
            if (n > 0) send({ type: 'SESSION_OPENED', sessionId: sid });
          return;
        }
        const session = getSession(frame.sessionId);
        const reconnect = adoptConn(frame.sessionId, source, connId);
        bound = { source, sessionId: frame.sessionId, session, connId };
        session.join(source, send); // replies SNAPSHOT (and replaces any prior send fn for this source)
        if (isUser(source)) {
          if (!reconnect) onUserJoin(frame.sessionId); // a reconnect *replaces* — it must not re-count or re-OPEN
          send(libraryFrame()); // (re)seed the participant panel: what's addable…
          send(participantsFrame(frame.sessionId)); // …and who's here
        } else {
          const an = agentName(source);
          if (an) {
            partEntry(frame.sessionId, an).present = true;
            broadcastParticipants(frame.sessionId);
          }
        }
        return;
      }
      if ('control' in bound) {
        // the host reporting up the control connection
        if (frame.type === 'AGENT_STATUS') applyStatus(frame);
        else if (frame.type === 'LIBRARY') {
          library = frame.agents ?? [];
          for (const sid of sessions.keys()) sendToUsers(sid, libraryFrame());
        }
        return;
      }
      if (CONTROL_RELAY.has(frame.type)) {
        // a UI intent → forward to the host, stamped with this client's session
        notify({ type: frame.type, sessionId: bound.sessionId, name: frame.name });
        return;
      }
      frame.source = bound.source; // unspoofable: hub stamps identity
      bound.session.handle(frame);
    });

    socket.on('close', () => {
      if (!bound) return;
      if ('control' in bound) {
        controlListeners.delete(send);
        return;
      }
      // Only the *live* connection's close counts. A stale socket — one already replaced
      // by a reconnect (e.g. a half-open socket that finally times out) — is a no-op, so
      // it can't clobber the live participant, mis-count users, or false-flag a crash.
      if (!isLiveConn(bound.sessionId, bound.source, bound.connId)) return;
      dropConn(bound.sessionId, bound.source);
      bound.session.leave(bound.source);
      if (isUser(bound.source)) {
        onUserLeave(bound.sessionId);
      } else {
        const an = agentName(bound.source);
        const e = an && sessionParticipants.get(bound.sessionId)?.get(an);
        if (e && e.phase !== 'removed') {
          // presence dropped without a host 'removed' → it crashed
          e.present = false;
          e.phase = 'crashed';
          broadcastParticipants(bound.sessionId);
        }
      }
    });
  });

  return wss;
}

// Run directly: `node src/hub.js`
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  startHub();
  console.log(`ABRA hub listening on ws://${DEFAULT_HOST}:${DEFAULT_PORT}`);
  if (!LOOPBACK_HOSTS.has(DEFAULT_HOST) && DEFAULT_HOST !== '::1')
    console.warn(
      '[hub] WARNING: listening on a non-loopback address. Anyone who can reach this port can join any session as any participant (identity is not verified in this demo build).',
    );
}
