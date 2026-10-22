/// <reference lib="dom" />
// @ts-check
// (client DOM code: pull in DOM types for this file only — the project lib stays
//  Node-oriented so stray browser globals can't leak into the shared contract.)
/**
 * Per-window session identity. A session is a `sessionId` carried in the URL (`?s=…`),
 * so each browser window/tab is its own isolated session — open a new tab for a
 * separate conversation, share the URL to collaborate in the same one. The user
 * `source` is per-tab (survives reload, differs across tabs). "Start fresh" mints
 * a new session and navigates to it — a clean slate; the old session is auto-reclaimed
 * once you leave it.
 */

const rand = () =>
  globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10);

/** The session id from `?s=`, minting + persisting one (no reload) if absent. @returns {string} */
export function readSessionId() {
  const url = new URL(window.location.href);
  let s = url.searchParams.get('s');
  if (!s) {
    s = rand();
    url.searchParams.set('s', s);
    window.history.replaceState({}, '', url); // stick it in the URL so reload keeps the session
  }
  return s;
}

/** A per-tab human identity (`user:<rand>`). @returns {string} */
export function userSource() {
  let src = window.sessionStorage.getItem('abra:source'); // per-tab: survives reload, unique per tab
  if (!src) {
    src = `user:${rand()}`;
    window.sessionStorage.setItem('abra:source', src);
  }
  return src;
}

/** Mint a brand-new session and navigate to it — a clean slate. */
export function startFresh() {
  const url = new URL(window.location.href);
  url.searchParams.set('s', rand());
  window.location.assign(url.toString());
}
