import { TOTAL_CHAPTERS, type StateSnapshot } from '@book/shared';
import { useEffect, useState } from 'react';

import type { EscalationMarker, Ribbon } from '../lib/cascade.ts';
import { engineChipCopy, chipCopy, queueLabel } from '../lib/format.ts';
import { liveChapter, revisingChapter } from '../lib/spine.ts';
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
 * Two label rows and the cascade ribbon (DESIGN §5.3, §7.1–7.2; BOOK-DOC-5 §5). The strip
 * sits below the annotation, so a book's opening has no status bar. The chip says
 * "пишется глава N" only when a lane lease exists; without the engine it falls back to what
 * the files prove («последняя запись · …»), never to a fake cursor (§7.3). The spine and the
 * 0/67 counter are gone: a ribbon with two carets where nobody writes is fake liveness.
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
        </div>
        <div className="top-row">
          <span className={chip.live ? 'live' : 'live idle'}>
            <i className="dot" aria-hidden="true" />
            {chip.text}
          </span>
          <span className="queue">{queueLabel(state.queue.depth)}</span>
        </div>
      </div>
      <CascadeRibbon ribbon={ribbon} markers={escalation} onOpenChange={onOpenChange} />
    </header>
  );
}
