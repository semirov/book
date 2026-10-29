/**
 * BOOK-167 — the pass strip: what the book is writing, under the paragraph it is writing.
 *
 * The strip is a block, not an overlay: 235 px of paper in the seam's place, the same two
 * hairlines, no shadow, no radius, no scrim. It says one sentence, five words and what the
 * pass spent — nothing else. Its facts are `passRail.ts`'s (pure); this file owns the mount,
 * the one read per open, and the one announcement per stage.
 *
 * IFACE — the data lifecycle, from the strip's side:
 *
 *   (a) states: closed (not rendered) · open on a live pass · open on an ended pass · open on
 *       an empty rail. The model's `phase` says `live`, `ended` or `absent` — the last for a
 *       rail with no row at all, which prints the absence instead of a pass; a refused pass is
 *       an ended one whose rail ends in a dash.
 *   (b) on each: opening the slot mounts this component, which reads the pass's earlier stages
 *       **once** (`getStages`) when the page's log lacks them; every `pass:stage` frame after
 *       that arrives as a new `events` prop and appends a row. Closing renders nothing and
 *       stops nothing.
 *   (c) bounds: one fetch per open, no polling, no timer, no clock of its own (`now` is the
 *       render's instant). The rail scrolls itself rather than growing the strip.
 *   (d) ownership: the store is `usePassStrip.ts` (a chapter and a block), the log is `App`'s
 *       `useStages`, and the only state here is the one fetched answer for this open.
 *
 * `aria-live` announces the stage, never a character: one status node whose text is the newest
 * word. Under `prefers-reduced-motion` the rows are a static list with their stored times.
 */

import type { PassStageEvent } from '@book/shared';
import { useEffect, useState } from 'react';

import { getStages } from '../api.ts';
import { reducedMotion } from '../dom.ts';
import { formatTime } from '../lib/format.ts';
import {
  RAIL_BROWSER,
  RAIL_PRINTING,
  eventsOfPass,
  factLines,
  latestPassId,
  mergeStages,
  passShortId,
  passStripModel,
  receiptTextOf,
  type RailRow,
} from '../lib/passRail.ts';
import { closePassStrip, type PassStripTarget } from '../lib/usePassStrip.ts';

/** One pass's display time: `11:18`, from the stored moment, never from a clock. */
const timeOf = (at: number): string => formatTime(new Date(at).toISOString());

export type PassStripProps = {
  chapter: number;
  /** The page's log for the chapter (`useStages`); frames that arrived while the strip is open. */
  events: readonly PassStageEvent[];
  /** The chapter's blocks as the page holds them: how a block id becomes «абзац 12». */
  blocks?: readonly { id: string }[];
  /** The block the strip was opened on. */
  blockId?: string | null;
  /** The render's instant. No timer: the strip is redrawn by the frames themselves. */
  now?: number;
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
  return (
    <PassStrip
      chapter={chapter}
      events={events}
      blocks={blocks}
      blockId={blockId}
      onClose={closePassStrip}
    />
  );
}

const NO_EVENTS: readonly PassStageEvent[] = [];

export function PassStrip({
  chapter,
  events,
  blocks,
  blockId = null,
  now = Date.now(),
  reduced = reducedMotion(),
  onClose,
}: PassStripProps) {
  /** The one stored answer for this open: earlier stages the page's log never saw. */
  const [stored, setStored] = useState<readonly PassStageEvent[]>(NO_EVENTS);

  useEffect(() => {
    setStored(NO_EVENTS);
    const seen = events.filter((event) => event.chapter === chapter);
    const passId = latestPassId(seen);
    // The log already holds the pass's beginning: the strip's story is complete without a read.
    if (passId !== null && eventsOfPass(seen, passId).some((event) => event.stage === 'queued' || event.stage === 'read')) {
      return;
    }
    let cancelled = false;
    const answer = passId === null ? getStages(chapter, { limit: 40 }) : getStages(chapter, { pass: passId });
    void answer
      .then((list) => {
        if (!cancelled) setStored(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // One read per open: the component mounts on open, and a frame appends a row without
    // re-asking the server for a story it already has.
  }, [chapter, blockId]);

  const seen = events.filter((event) => event.chapter === chapter);
  const merged = mergeStages(stored, seen);
  const passId = latestPassId(seen) ?? latestPassId(merged);
  const own = passId === null ? NO_EVENTS : eventsOfPass(merged, passId);
  const model = passStripModel({ chapter, events: own, nowMs: now, blocks, blockId });
  const handle = passId === null ? null : passShortId(passId);
  const receipt = receiptTextOf(model.receipt);
  const announced = announcedWord(model.rows);

  return (
    <section
      className="pass-strip"
      data-motion={reduced ? 'still' : 'motion'}
      data-phase={model.phase}
      aria-labelledby="pass-strip-heading"
    >
      <div className="pass-strip-head">
        {handle === null ? null : <span className="pass-strip-id">{handle}</span>}
        <p className="pass-strip-heading" id="pass-strip-heading">
          {model.heading}
        </p>
        {model.right === null ? null : <span className="pass-strip-right">{model.right}</span>}
      </div>
      <button type="button" className="pass-strip-close" aria-label="закрыть" onClick={onClose}>
        ✕
      </button>
      {/* One announcement per stage: the newest word, never a character and never a frame. */}
      <p className="visually-hidden" role="status" aria-live="polite">
        {announced}
      </p>
      <ol className="pass-strip-rail">
        {model.rows.map((row) => (
          <li key={row.key} className="pass-row" data-row={row.key} data-state={row.state}>
            {row.state === 'refused' ? (
              <span className="pass-row-dash" aria-hidden="true" />
            ) : (
              <span className="pass-row-node" aria-hidden="true" />
            )}
            <div className="pass-row-line">
              <span className="pass-row-word">{row.word}</span>
              <time className="pass-row-time">{timeOf(row.atMs)}</time>
            </div>
            {row.state === 'live' ? <LiveRow row={row} /> : null}
          </li>
        ))}
      </ol>
      {receipt === null ? null : <p className="pass-strip-receipt">{receipt}</p>}
    </section>
  );
}

/** The live row's three bounded fact lines and the paragraph, when the pass can name one. */
function LiveRow({ row }: { row: RailRow }) {
  // The row is 100 px: the word, then at most three fact lines — the actor-free line and the
  // paragraph take their place in that budget instead of pushing the rail taller.
  const reserved = (row.word === RAIL_PRINTING ? 1 : 0) + (row.paragraph === null ? 0 : 1);
  const facts = factLines(row.summary, 40, Math.max(1, 3 - reserved));
  return (
    <div className="pass-row-live">
      {facts.map((line, index) => (
        <span key={index} className="pass-fact">
          {line}
        </span>
      ))}
      {row.word === RAIL_PRINTING ? <span className="pass-fact">{RAIL_BROWSER}</span> : null}
      {row.paragraph === null ? null : <span className="pass-fact">абзац {row.paragraph}</span>}
    </div>
  );
}

/**
 * The word the status node prints: the last row's own word. Held in a ref-free way — a render
 * with the same word writes the same text, so the node speaks only when a stage changes.
 */
function announcedWord(rows: readonly RailRow[]): string {
  return rows.at(-1)?.word ?? '';
}
