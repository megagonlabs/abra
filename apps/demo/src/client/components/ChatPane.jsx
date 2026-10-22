// @ts-check
/**
 * ChatPane — the base medium: always-present chat,
 * left pane. Renders the session message stream + an activity line ("{agent} is
 * working…", derived from the cast) + the composer. Props-in / callback-out; the
 * surrounding resizable Panel (in App) owns sizing + the not-collapsible rule.
 *
 * Composer is a multi-line textarea: Enter sends, Shift+Enter inserts a newline; it
 * auto-grows with its content (capped). The message list auto-scrolls to the latest
 * message, but only while the user is pinned to the bottom — scrolling up to read
 * history is not yanked back down.
 */
import { Spinner } from '@blueprintjs/core';
import { useEffect, useRef } from 'react';

/** A stable hue (0–359) per message source, so each agent keeps one consistent bubble color. */
function agentHue(/** @type {any} */ source) {
  const s = String(source ?? '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

/**
 * Render a message body, turning `{ref:key}` markers into hover-to-highlight coordination
 * chips (each `refs[key] = { canvasId, paths:[path], label }`). Hovering a chip lights the
 * exact element it points at (its `path`) across the canvas panel; a chip whose canvas is
 * gone renders as an "unavailable" pill.
 */
function MessageBody({ text, refs, onRefHover, liveIds, resolvePath }) {
  if (!text) return null;
  if (!refs) return <>{text}</>;
  const parts = String(text).split(/(\{ref:[^}]+\})/g);
  let pos = 0; // running char offset → a stable, non-index key per part
  return parts.map((part) => {
    const key = `p${pos}`;
    pos += part.length;
    const m = /^\{ref:([^}]+)\}$/.exec(part);
    const r = m && refs[m[1]];
    if (!r) return <span key={key}>{part}</span>;
    const path = r.paths?.[0];
    // A chip is live only when its canvas is open AND its path resolves to a REAL element —
    // a dangling path (e.g. cell/r1 with a missing colId, or item/0 on an empty display)
    // greys out instead of silently lighting nothing.
    const canvasLive = liveIds?.has(r.canvasId);
    const avail = canvasLive && (resolvePath ? resolvePath(r.canvasId, path) : true);
    return (
      <button
        key={key}
        type="button"
        className={`abra-refchip${avail ? '' : ' abra-refchip--gone'}`}
        title={
          avail ? path : canvasLive ? `no such element: ${path}` : 'unavailable — canvas closed'
        }
        onMouseEnter={() => avail && onRefHover?.({ canvasId: r.canvasId, path })}
        onMouseLeave={() => onRefHover?.(null)}
      >
        {r.label ?? m[1]}
      </button>
    );
  });
}

/**
 * @param {{
 *   messages: any[],
 *   label: (source: any) => string,
 *   working: string[],
 *   draft: string,
 *   onDraft: (v: string) => void,
 *   onSend: (e: any) => void,
 *   onRefHover?: (r: { canvasId: string, path: string } | null) => void,
 *   liveIds?: Set<string>,
 *   resolvePath?: (canvasId: string, path: string) => boolean,
 * }} props
 */
export function ChatPane({
  messages,
  label,
  working,
  draft,
  onDraft,
  onSend,
  onRefHover,
  liveIds,
  resolvePath,
}) {
  const listRef = useRef(/** @type {HTMLUListElement | null} */ (null));
  const pinnedRef = useRef(true); // is the user scrolled to (near) the bottom?

  // follow new messages only when pinned to the bottom (don't yank off scrollback).
  // biome-ignore lint/correctness/useExhaustiveDependencies: length deps are the trigger; body reads refs
  useEffect(() => {
    const el = listRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, working.length]);
  // (composer auto-grow is CSS `field-sizing: content` — see styles.css)

  const onScroll = () => {
    const el = listRef.current;
    if (el) pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  return (
    <div className="abra-chat">
      <ul className="abra-messages" ref={listRef} onScroll={onScroll}>
        {messages.map((m, i) => {
          const from = label(m.source);
          const isUser = from === 'you';
          // group a run from the same source: show the name only on the first of the run.
          const sameAsPrev = i > 0 && messages[i - 1].source === m.source;
          return (
            <li
              key={`${m.source ?? 'sys'}:${m.seq}`}
              className={`abra-msg abra-msg--${isUser ? 'u' : 'a'}${sameAsPrev ? ' abra-msg--cont' : ''}`}
              style={
                isUser ? undefined : /** @type {any} */ ({ '--agent-hue': agentHue(m.source) })
              }
            >
              {!isUser && !sameAsPrev ? <div className="abra-msg-from">{from}</div> : null}
              <div className="abra-msg-body">
                {m.text != null ? (
                  <MessageBody
                    text={m.text}
                    refs={m.refs}
                    onRefHover={onRefHover}
                    liveIds={liveIds}
                    resolvePath={resolvePath}
                  />
                ) : (
                  JSON.stringify(m)
                )}
              </div>
            </li>
          );
        })}
        {working.length ? (
          <li className="abra-typing">
            <Spinner size={12} intent="warning" />
            <span>
              {working.length === 1
                ? `${working[0]} is working…`
                : `${working.join(', ')} are working…`}
            </span>
          </li>
        ) : null}
      </ul>
      <form className="abra-composer" onSubmit={onSend}>
        <textarea
          className="abra-composer-input"
          value={draft}
          rows={1}
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSend(e);
            }
          }}
          placeholder="Type a message…"
        />
        <button type="submit">Send</button>
      </form>
    </div>
  );
}
