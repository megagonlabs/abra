// @ts-check
/**
 * TopBar — session chrome: brand + sessionId + a connection dot (green connected /
 * amber reconnecting), the participant strip (per agent: a status-intent Tag with a
 * hover Tooltip blurb), a Participants button (a Blueprint Popover owns its open/
 * dismiss), and Start fresh. Shell detail, outside the abra-spec contract.
 */
import { Button, Popover, Tag, Tooltip } from '@blueprintjs/core';
import { useState } from 'react';
import { statusOf } from '../participants.js';
import { exportLog } from '../wslog.js';
import { ParticipantsPanel } from './ParticipantsPopover.jsx';

/** participant status -> Blueprint intent (Tag colour). */
const STATUS_INTENT = {
  online: 'success',
  working: 'warning',
  starting: 'none',
  crashed: 'danger',
};

/**
 * @param {{
 *   sessionId: string,
 *   conn: 'connected' | 'reconnecting',
 *   participants: import('../store.js').Participant[],
 *   library: import('../store.js').LibraryAgent[],
 *   blurbOf: (name: string) => string,
 *   onAdd: (name: string) => void,
 *   onRemove: (name: string) => void,
 *   onRestart: (name: string) => void,
 *   onStartFresh: () => void,
 * }} props
 */
export function TopBar({
  sessionId,
  conn,
  participants,
  library,
  blurbOf,
  onAdd,
  onRemove,
  onRestart,
  onStartFresh,
}) {
  const [open, setOpen] = useState(false);
  const connLabel = conn === 'connected' ? 'connected' : 'reconnecting…';

  return (
    <header className="abra-topbar">
      <div className="abra-brand">
        ABRA
        <span className="abra-sess">· session {sessionId}</span>
        <span
          className={`abra-conn${conn === 'reconnecting' ? ' abra-conn--recon' : ''}`}
          title={connLabel}
        />
      </div>
      <div className="abra-spacer" />
      <div className="abra-strip">
        {participants.map((p) => {
          const status = statusOf(p);
          return (
            <Tooltip
              key={p.name}
              content={`${blurbOf(p.name)} (${status})`}
              placement="bottom"
              compact
            >
              <Tag
                minimal
                round
                intent={STATUS_INTENT[status] ?? 'none'}
                className={status === 'working' ? 'abra-tag-working' : undefined}
              >
                {p.name}
              </Tag>
            </Tooltip>
          );
        })}
      </div>
      <div className="abra-topbar-actions">
        <Popover
          isOpen={open}
          onInteraction={setOpen}
          placement="bottom-end"
          popoverClassName="abra-participants-pop"
          content={
            <ParticipantsPanel
              participants={participants}
              library={library}
              blurbOf={blurbOf}
              onAdd={onAdd}
              onRemove={onRemove}
              onRestart={onRestart}
            />
          }
        >
          <Button
            variant="minimal"
            size="small"
            icon="people"
            text="Participants"
            aria-haspopup="true"
            aria-expanded={open}
          />
        </Popover>
        <Tooltip content="Download all WS frames exchanged so far (JSON) for manual review">
          <Button
            variant="minimal"
            size="small"
            icon="download"
            text="WS log"
            onClick={() => exportLog()}
          />
        </Tooltip>
        <Button
          variant="minimal"
          size="small"
          icon="refresh"
          text="Start fresh"
          onClick={onStartFresh}
        />
      </div>
    </header>
  );
}
