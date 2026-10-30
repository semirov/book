import { useEffect, useState } from 'react';

import { printFollowState, subscribePrintFollow, togglePrintFollow } from '../lib/printFollow.ts';

/**
 * BOOK-220 §11.2 — «следить»: one control in the head's status-line area, and nothing else.
 *
 * It is absent when nothing prints (the store counts the live renderers), and its word is a
 * state, not an action: «следить» while the page is left to the reader, «слежу» while it keeps
 * the caret on the 45 % line. A manual scroll switches it off and this control says so in the
 * same frame (`lib/printFollow.ts` owns the rule). Lowercase mono 12 in `head-status.css`, the
 * same register as the head's word, so the row cannot grow.
 */
export function PrintFollow() {
  const [state, setState] = useState(printFollowState);
  useEffect(() => {
    // The store may already know of a print that mounted before this effect ran: read it once,
    // then follow every change.
    setState(printFollowState());
    return subscribePrintFollow(() => setState(printFollowState()));
  }, []);

  if (state.active === 0) return null;
  return (
    <button
      type="button"
      className="print-follow"
      data-follow={state.on ? 'on' : 'off'}
      aria-pressed={state.on}
      onClick={() => togglePrintFollow()}
    >
      {state.on ? 'слежу' : 'следить'}
    </button>
  );
}
