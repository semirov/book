import { TOTAL_CHAPTERS, type StateSnapshot } from '@book/shared';

import type { EscalationMarker, Ribbon } from '../lib/cascade.ts';
import { engineChipCopy, chipCopy } from '../lib/format.ts';
import { liveChapter, revisingChapter } from '../lib/spine.ts';
import { CascadeRibbon } from './CascadeRibbon.tsx';

/**
 * Two label rows and the cascade ribbon (DESIGN §5.3, §7.1–7.2; BOOK-DOC-5 §5). The strip
 * sits below the annotation, so a book's opening has no status bar. The chip says
 * "пишется глава N" only when a lane lease exists; without the engine it falls back to what
 * the files prove («последняя запись · 25.10», «12 глав с текстом»), never to a fake cursor
 * nor to a recency clock (§7.3). The spine and the 0/67 counter are gone: a ribbon with two
 * carets where nobody writes is fake liveness.
 *
 * BOOK-70 removed the second chip of the bottom row — «замечания» had already moved to the
 * register, where its noun is the number's own (Discussion). One row, one chip.
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
  const current = liveChapter(state);
  const revising = revisingChapter(state);
  const engineChip = engineChipCopy(state.engine.status);
  const chip =
    engineChip ??
    (current !== null
      ? { text: `пишется глава ${current.n}`, live: true }
      : revising !== null
        ? { text: `правится глава ${revising}`, live: true }
        : chipCopy({ count: state.chapters.count, lastChangeAt: state.activity.lastFileChangeAt }));

  return (
    <header className="top">
      <div className="page sheet top-in">
        <div className="top-row">
          <span className="brand">Книга · {TOTAL_CHAPTERS} глав</span>
        </div>
        <div className="top-row">
          <span className={chip.live ? 'live' : 'live idle'}>
            <i className="dot" aria-hidden="true" />
            {chip.text}
          </span>
        </div>
      </div>
      <CascadeRibbon ribbon={ribbon} markers={escalation} onOpenChange={onOpenChange} />
    </header>
  );
}
