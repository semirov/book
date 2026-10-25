import { TOTAL_CHAPTERS, type StateSnapshot } from '@book/shared';
import { useEffect, useState } from 'react';

import type { EscalationMarker, Ribbon } from '../lib/cascade.ts';
import { engineChipCopy, chipCopy, queueLabel } from '../lib/format.ts';
import { liveChapter, revisingChapter, spineAriaLabel, spineMarkers } from '../lib/spine.ts';
import { CascadeRibbon } from './CascadeRibbon.tsx';

/** The chip speaks in minutes; refresh it once a minute so «14 минут назад» stays true. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/**
 * Two label rows, the spine and the cascade ribbon (DESIGN §5.3, §7.1–7.2). The chip says
 * "пишется глава N" only when a lane lease exists; without the engine it falls back to what
 * the files prove («последняя запись · …»), never to a fake cursor (§7.3).
 */
export function Header({
  state,
  ribbon,
  markers: escalation,
  onOpenChange,
}: {
  state: StateSnapshot;
  ribbon: Ribbon | null;
  markers: EscalationMarker[];
  onOpenChange: (changeId: string) => void;
}) {
  const now = useNow();
  const markers = spineMarkers(state);
  const current = liveChapter(state);
  const revising = revisingChapter(state);
  const engineChip = engineChipCopy(state.engine.status);
  const chip =
    engineChip ??
    (current !== null
      ? { text: `пишется глава ${current.n}`, live: true }
      : revising !== null
        ? { text: `правится глава ${revising}`, live: true }
        : chipCopy({ count: state.chapters.count, lastChangeAt: state.activity.lastFileChangeAt }, now));

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
        className={`spine${markers.empty ? ' is-empty' : ''}`}
        role="img"
        aria-label={spineAriaLabel(state)}
        data-written={state.chapters.written.join(',')}
      >
        {markers.forwardFill > 0 ? <span className="spine-l" style={{ width: `${markers.forwardFill}%` }} /> : null}
        {markers.backwardFill > 0 ? <span className="spine-r" style={{ width: `${markers.backwardFill}%` }} /> : null}
        <span className="spine-seam" style={{ left: `${markers.seamPercent}%` }} />
        {markers.empty ? (
          <>
            <i className="spine-caret l" />
            <i className="spine-caret r" />
          </>
        ) : null}
      </div>
      <CascadeRibbon ribbon={ribbon} markers={escalation} onOpenChange={onOpenChange} />
    </header>
  );
}
