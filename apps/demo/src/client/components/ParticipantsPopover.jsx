// @ts-check
/**
 * ParticipantsPanel — the participant-config UI body, rendered inside the TopBar's
 * Blueprint Popover (which owns the floating card + open/dismiss/Escape/click-outside).
 * "In this session" lists the cast (status Tag + blurb + Remove/Restart); "Add a
 * participant" lists the addable library. Immediate-apply (each action sends a live
 * frame); confirm on Remove. Human-facing only — the status shown is never an agent input.
 */
import { Button, Tag } from '@blueprintjs/core';
import { useState } from 'react';
import { statusOf } from '../participants.js';

/** participant status -> Blueprint intent. */
const STATUS_INTENT = {
  online: 'success',
  working: 'warning',
  starting: 'none',
  crashed: 'danger',
};
const STATUS_BADGE = new Set(['online', 'working']);

/**
 * @param {{
 *   participants: import('../store.js').Participant[],
 *   library: import('../store.js').LibraryAgent[],
 *   blurbOf: (name: string) => string,
 *   onAdd: (name: string) => void,
 *   onRemove: (name: string) => void,
 *   onRestart: (name: string) => void,
 * }} props
 */
export function ParticipantsPanel({ participants, library, blurbOf, onAdd, onRemove, onRestart }) {
  // which Remove is awaiting confirmation (name) — a second click confirms.
  const [confirming, setConfirming] = useState(/** @type {string | null} */ (null));

  const present = new Set(participants.map((p) => p.name.toLowerCase()));
  const addable = library.filter((a) => !present.has(a.name.toLowerCase()));

  return (
    <div className="abra-pop">
      <h4 className="abra-pop-h">In this session</h4>
      {participants.map((p) => {
        const status = statusOf(p);
        return (
          <div className="abra-prow" key={p.name}>
            <span className={`abra-sdot abra-sdot--${status}`} />
            <div className="abra-prow-meta">
              <div className="abra-prow-name">
                {p.name}
                {STATUS_BADGE.has(status) ? (
                  <Tag
                    minimal
                    round
                    intent={STATUS_INTENT[status] ?? 'none'}
                    className={status === 'working' ? 'abra-tag-working' : undefined}
                  >
                    {status}
                  </Tag>
                ) : null}
              </div>
              <div className="abra-prow-blurb">{blurbOf(p.name)}</div>
            </div>
            {status === 'crashed' ? (
              <Button
                variant="minimal"
                size="small"
                text="Restart"
                onClick={() => onRestart(p.name)}
              />
            ) : null}
            <Button
              variant="minimal"
              size="small"
              intent="danger"
              text={confirming === p.name ? 'Confirm' : 'Remove'}
              onClick={() => {
                if (confirming === p.name) {
                  onRemove(p.name);
                  setConfirming(null);
                } else {
                  setConfirming(p.name);
                }
              }}
            />
          </div>
        );
      })}
      {addable.length ? (
        <>
          <div className="abra-pop-sep" />
          <h4 className="abra-pop-h">Add a participant</h4>
          {addable.map((a) => (
            <div className="abra-prow" key={a.name}>
              <span className="abra-sdot abra-sdot--ghost" />
              <div className="abra-prow-meta">
                <div className="abra-prow-name">{a.name}</div>
                <div className="abra-prow-blurb">{a.blurb}</div>
              </div>
              <Button
                variant="minimal"
                size="small"
                intent="success"
                icon="add"
                text="Add"
                onClick={() => onAdd(a.name)}
              />
            </div>
          ))}
        </>
      ) : null}
    </div>
  );
}
