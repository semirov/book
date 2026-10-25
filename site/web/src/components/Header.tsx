import { TOTAL_CHAPTERS, type StateSnapshot } from '@book/shared';
import { useEffect, useState } from 'react';

import { chipCopy, queueLabel } from '../lib/format.ts';

/** The chip speaks in minutes; refresh it once a minute so «14 минут назад» stays true. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** Two label rows, the spine, and only what the files can prove (DESIGN §5.3). */
export function Header({ state }: { state: StateSnapshot }) {
  const now = useNow();
  const chip = chipCopy({ count: state.chapters.count, lastChangeAt: state.activity.lastFileChangeAt }, now);
  const forward = state.meeting.forwardFront;
  const backward = state.meeting.backwardFront;
  const leftPercent = forward === null ? 0 : (forward / TOTAL_CHAPTERS) * 100;
  const rightPercent = backward === null ? 0 : ((TOTAL_CHAPTERS - backward + 1) / TOTAL_CHAPTERS) * 100;
  const empty = state.chapters.count === 0;

  return (
    <header className="top">
      <div className="page top-in">
        <div className="top-row">
          <span className="brand">Книга · {TOTAL_CHAPTERS} глав</span>
          <span className="count">
            {state.chapters.count} / {TOTAL_CHAPTERS}
          </span>
        </div>
        <div className="top-row">
          <span className={chip.live ? 'live' : 'live idle'}>
            <i className="dot" aria-hidden="true" />
            {chip.text}
          </span>
          <span className="queue">{queueLabel(state.queue.depth)}</span>
        </div>
      </div>
      <div
        className="spine"
        role="img"
        aria-label={`написано ${state.chapters.count} из ${TOTAL_CHAPTERS} глав`}
      >
        {leftPercent > 0 ? <span className="spine-l" style={{ width: `${leftPercent}%` }} /> : null}
        {rightPercent > 0 ? <span className="spine-r" style={{ width: `${rightPercent}%` }} /> : null}
        <span className="spine-seam" />
        {empty ? (
          <>
            <i className="spine-caret l" />
            <i className="spine-caret r" />
          </>
        ) : null}
      </div>
    </header>
  );
}
