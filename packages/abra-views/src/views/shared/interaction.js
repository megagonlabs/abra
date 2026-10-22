import { useRef, useState } from 'react';

const IDLE = { kind: 'idle' };

/**
 * Tiny view-local interaction manager. It is deliberately small: views use it to
 * suppress hover/select while a drag, edit, or pending-like local operation owns
 * the pointer/keyboard.
 */
export function useInteractionManager() {
  const [active, setActive] = useState(IDLE);
  const activeRef = useRef(IDLE);

  const set = (next) => {
    activeRef.current = next;
    setActive(next);
  };

  return {
    active,
    isIdle: () => activeRef.current.kind === 'idle',
    is: (kind) => activeRef.current.kind === kind,
    begin: (kind, meta = {}) => {
      if (activeRef.current.kind !== 'idle') return false;
      set({ kind, ...meta });
      return true;
    },
    end: (kind) => {
      if (kind && activeRef.current.kind !== kind) return false;
      set(IDLE);
      return true;
    },
    reset: () => set(IDLE),
  };
}
