/**
 * BOOK-167 — the pass strip: the one plain sentence a reader gets while a chapter is written.
 *
 * It is a block, not an overlay: paper in the seam's place, the same two hairlines, no shadow,
 * no radius, no scrim. It used to carry the workshop's rail — five stage words, a duration, a
 * token and dollar receipt — and that was an engine report card on a reader's page. It is gone.
 * What stays is one sentence in the book's voice («глава 7 пишется» / «глава 7 писалась»), one
 * close, and the honest failure («не удалось прочитать ход») when the log cannot be read.
 *
 * The stage vocabulary, durations, tokens and money live only in the operator's console
 * (`bin/admin.mjs`, `bin/engine.mjs`), never in a reader page, tooltip or tap.
 */

import type { PassStageEvent } from '@book/shared';
import { useEffect, useState } from 'react';

import { getStages } from '../api.ts';
import { reducedMotion } from '../dom.ts';
import { closePassStrip, type PassStripTarget } from '../lib/usePassStrip.ts';

export type PassStripProps = {
  chapter: number;
  /** The page's log for the chapter (`useStages`); frames that arrived while the strip is open. */
  events: readonly PassStageEvent[];
  reduced?: boolean;
  onClose: () => void;
};

/**
 * The strip's slot: rendered by the prose under every paragraph, alive only for the block the
 * reader opened. One store, one position — two blocks can never show two strips.
 *
 * The open target is read once per chapter (`ChapterProse` subscribes, not every paragraph:
 * ~1 600 subscribers would be one per paragraph of the book) and handed down here.
 *
 * A refetch can replace the block that was opened (block ids are content-derived), so a target
 * the chapter no longer holds falls back to the last paragraph: the strip stays with the pass
 * it describes instead of vanishing mid-print.
 */
export function PassStripSlot({
  chapter,
  blockId,
  events,
  blocks,
  last = false,
  target,
}: {
  chapter: number;
  blockId: string;
  events: readonly PassStageEvent[];
  blocks?: readonly { id: string }[];
  /** The chapter's last paragraph: where a strip whose block is gone is placed. */
  last?: boolean;
  /** The open slot, read once by the prose (`usePassStrip`). */
  target: PassStripTarget | null;
}) {
  if (target === null || target.chapter !== chapter) return null;
  const held = blocks?.some((block) => block.id === target.blockId) ?? true;
  if (target.blockId !== blockId && (held || !last)) return null;
  return <PassStrip chapter={chapter} events={events} onClose={closePassStrip} />;
}

const NO_EVENTS: readonly PassStageEvent[] = [];

export function PassStrip({
  chapter,
  events,
  reduced = reducedMotion(),
  onClose,
}: PassStripProps) {
  /** The one stored answer for this open: earlier stages the page's log never saw. */
  const [stored, setStored] = useState<readonly PassStageEvent[]>(NO_EVENTS);
  /** The read failed: the strip says so instead of inventing a stage. */
  const [readFailed, setReadFailed] = useState(false);

  useEffect(() => {
    setStored(NO_EVENTS);
    setReadFailed(false);
    const seen = events.filter((event) => event.chapter === chapter);
    // The log already holds this pass's beginning: the sentence is complete without a read.
    if (seen.length > 0) return;
    let cancelled = false;
    void getStages(chapter, { limit: 40 })
      .then((list) => {
        if (!cancelled) setStored(list);
      })
      .catch(() => {
        if (!cancelled) setReadFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // One read per open: the component mounts on open, and a frame only changes the sentence.
  }, [chapter]);

  const all = [...stored, ...events].filter((event) => event.chapter === chapter);
  const refused = all.some((event) => event.stage === 'refused');
  const ended = all.some((event) => event.stage === 'landed' || event.stage === 'refused');
  const sentence = refused
    ? `глава ${chapter} не писалась`
    : ended
      ? `глава ${chapter} писалась`
      : `глава ${chapter} пишется`;

  return (
    <section className="pass-strip" data-motion={reduced ? 'still' : 'motion'} data-phase={readFailed ? 'unread' : ended ? 'ended' : 'live'}>
      <div className="pass-strip-head">
        <p className="pass-strip-heading" role="status">
          {readFailed ? 'не удалось прочитать ход' : sentence}
        </p>
      </div>
      <button type="button" className="pass-strip-close" aria-label="закрыть" onClick={onClose}>
        ✕
      </button>
    </section>
  );
}
