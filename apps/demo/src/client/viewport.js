// @ts-check
/**
 * useViewport — CLIENT-LOCAL viewport prefs for the canvas panel. NOT canvas state and
 * NOT on the wire: which live canvases the USER chooses to show, in what ORDER, plus an
 * experimental "state isolation" model (below). Every live canvas is the agent's intent
 * to display; this layer lets the human curate that set for their own window.
 *
 * State-isolation experiment (D). Each view owns LOCAL selected/hovered state (React
 * state inside GraphView/TableView/…). The only lever over that state from outside the
 * view is REMOUNT — bumping a canvas's client-local `epoch` (CanvasPanel keys the view on
 * `{canvasId}:{epoch}`) tears it down and clears its selection/hover. These toggles decide
 * WHEN that happens as the visible set changes, so the UX of "does a new-or-reactivated
 * view disturb my other views' selection?" can be felt both ways:
 *   - keepStateWhileHidden — a deactivated canvas stays MOUNTED (parked offscreen) so its
 *     selection survives being hidden; OFF unmounts it (state lost, fresh on return).
 *   - resetSelfOnReactivate — re-showing a canvas bumps ITS epoch (comes back cleared).
 *   - resetPeersOnAppear — a canvas appearing/activating bumps every OTHER visible
 *     canvas's epoch (their selection/hover clears — the "new view resets peers" model).
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/** @typedef {{ keepStateWhileHidden: boolean, resetSelfOnReactivate: boolean, resetPeersOnAppear: boolean }} Iso */

/** @type {Iso} */
export const DEFAULT_ISO = {
  keepStateWhileHidden: true,
  resetSelfOnReactivate: false,
  resetPeersOnAppear: false,
};

export const MAX_VISIBLE_CANVASES = 4;

/**
 * @param {string[]} order
 * @param {Set<string>} hidden
 * @returns {Set<string>}
 */
function capVisible(order, hidden) {
  const visible = order.filter((id) => !hidden.has(id));
  if (visible.length <= MAX_VISIBLE_CANVASES) return hidden;
  const next = new Set(hidden);
  for (const id of visible.slice(MAX_VISIBLE_CANVASES)) next.add(id);
  return next;
}

/**
 * @param {string[]} liveIds  ids of every live (non-closed) canvas, in creation order
 * @returns {{
 *   order: string[], hidden: Set<string>, iso: Iso,
 *   shown: string[], parked: string[], epochOf: (id: string) => number,
 *   setIso: (patch: Partial<Iso>) => void,
 *   toggleActive: (id: string) => void,
 *   move: (id: string, dir: -1 | 1) => void,
 * }}
 */
export function useViewport(liveIds) {
  const [order, setOrder] = useState(/** @type {string[]} */ ([]));
  const [hidden, setHidden] = useState(() => /** @type {Set<string>} */ (new Set()));
  const [gen, setGen] = useState(/** @type {Record<string, number>} */ ({}));
  const [iso, setIsoState] = useState(DEFAULT_ISO);

  // refs so the reconcile effect reads live values without re-subscribing
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const isoRef = useRef(iso);
  isoRef.current = iso;
  const prevLive = useRef(/** @type {string[]} */ ([]));

  const liveKey = liveIds.join('|');
  // Reconcile order/hidden/gen with the live set; a newly-appeared canvas may reset peers.
  useEffect(() => {
    const live = liveKey ? liveKey.split('|') : [];
    const liveSet = new Set(live);
    const prev = prevLive.current;
    const prevSet = new Set(prev);
    const appeared = live.filter((id) => !prevSet.has(id));
    const removed = prev.filter((id) => !liveSet.has(id));
    prevLive.current = live;
    if (!appeared.length && !removed.length) return;

    setOrder((o) => {
      const kept = o.filter((id) => liveSet.has(id));
      // Newest first: a freshly-created canvas lands at the TOP of the rail / layout so the
      // user naturally sees what the agent just opened (a batch is reversed → newest at 0).
      const add = appeared.filter((id) => !kept.includes(id));
      return add.length ? [...[...add].reverse(), ...kept] : kept;
    });
    if (removed.length) {
      setHidden((h) => {
        const n = new Set(h);
        for (const id of removed) n.delete(id);
        return n;
      });
      setGen((g) => {
        const n = { ...g };
        for (const id of removed) delete n[id];
        return n;
      });
    }
    if (appeared.length && isoRef.current.resetPeersOnAppear) {
      // clear every OTHER currently-visible canvas's local selection/hover
      setGen((g) => {
        const n = { ...g };
        for (const id of prev) if (!hiddenRef.current.has(id)) n[id] = (n[id] ?? 0) + 1;
        return n;
      });
    }
  }, [liveKey]);

  // The demo panel is intentionally capped to a 2×2 focus set. Extra live canvases
  // stay in the rail and can be brought back by reordering or showing them later.
  useEffect(() => {
    setHidden((/** @type {Set<string>} */ h) => {
      const capped = capVisible(order, h);
      return capped === h ? h : capped;
    });
  }, [order]);

  const setIso = useCallback((/** @type {Partial<Iso>} */ patch) => {
    setIsoState((s) => ({ ...s, ...patch }));
  }, []);

  const toggleActive = useCallback(
    (/** @type {string} */ id) => {
      setHidden((h) => {
        const n = new Set(h);
        const wasHidden = n.has(id);
        let nextOrder = order;
        if (wasHidden) {
          n.delete(id);
          nextOrder = [id, ...order.filter((/** @type {string} */ x) => x !== id)];
          setOrder(nextOrder);
        } else {
          n.add(id);
        }
        // reactivating (hidden -> visible)
        if (wasHidden) {
          if (isoRef.current.resetSelfOnReactivate) {
            setGen((g) => ({ ...g, [id]: (g[id] ?? 0) + 1 }));
          }
          if (isoRef.current.resetPeersOnAppear) {
            setGen((g) => {
              const nn = { ...g };
              for (const other of prevLive.current) {
                if (other !== id && !n.has(other)) nn[other] = (nn[other] ?? 0) + 1;
              }
              return nn;
            });
          }
        }
        return capVisible(nextOrder, n);
      });
    },
    [order],
  );

  const move = useCallback((/** @type {string} */ id, /** @type {-1 | 1} */ dir) => {
    setOrder((o) => {
      const i = o.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= o.length) return o;
      const n = [...o];
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });
  }, []);

  const epochOf = useCallback((/** @type {string} */ id) => gen[id] ?? 0, [gen]);
  const shown = order.filter((id) => !hidden.has(id));
  // parked = live but hidden; kept mounted (offscreen) only when keepStateWhileHidden
  const parked = iso.keepStateWhileHidden ? order.filter((id) => hidden.has(id)) : [];

  return { order, hidden, iso, shown, parked, epochOf, setIso, toggleActive, move };
}
