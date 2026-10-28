import { useEffect, useRef, type MouseEvent } from 'react';

import { MIDDOT } from '../lib/format.ts';
import { spanText } from '../lib/history.ts';
import type { PassRecordSession } from '../lib/usePassRecord.ts';
import type { PassRecordView } from '../lib/passRecord.ts';

/**
 * The pass record (BOOK-166): one page, two states, in the flow — a mode of the same page like
 * the chronicle, never a modal. It is framed like the colophon: lowercase, `--mono` 12 px for
 * facts, no product words, no `этап:`, no `цена`, no model id, no raw field name.
 *
 * The heading is rendered at once and the body only when the answer has landed, so the page is
 * mounted at its final height: nothing above the heading ever arrives later. The heading's own
 * `line-height`/`min-height` is the reserved slot, `overflow-anchor: none` keeps the browser
 * from re-anchoring the scroll, and exactly one `scrollTo` runs when the body lands — no second
 * one on a re-render.
 *
 * The links leave the mode by the hash the book already understands: `#ch-7` names the chapter
 * slot, `#toc` the contents, and `#pass` the live block (which falls back to the chapter's head
 * when the pass has not printed its paragraph yet). The reader's click is the only scroll this
 * component performs besides the landing.
 */

const FALLBACK_OFFSET = 64;

/** The head's own offset, from the sheet's token (the fallback is a test or an SSR page). */
function headOffset(): number {
  if (typeof getComputedStyle !== 'function') return FALLBACK_OFFSET;
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--offset-top'));
  return Number.isFinite(value) && value > 0 ? value : FALLBACK_OFFSET;
}

/** `requestAnimationFrame` in the browser; a macrotask in a harness that has none. */
function afterPaint(run: () => void): void {
  if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(run);
  else window.setTimeout(run, 0);
}

export type PassRecordProps = {
  state: PassRecordSession;
  /**
   * The page's own way into the book view (`App`'s `toChapter`). A record opened from the
   * chronicle has no `#ch-<n>` node when its link is clicked — this is what brings that view
   * back, so the scroll after paint has somewhere to land.
   */
  onOpenChapter?: (chapter: number) => void;
};

export function PassRecord({ state, onOpenChapter }: PassRecordProps) {
  const view = state.phase === 'ready' ? state.view : null;
  const heading = useRef<HTMLHeadingElement | null>(null);
  const landed = useRef(false);

  // One landing, once the data is ready: the browser's own hash jump cannot know this node.
  useEffect(() => {
    if (view === null || landed.current) return;
    const node = heading.current;
    if (node === null) return;
    landed.current = true;
    const top = node.getBoundingClientRect().top + window.scrollY - headOffset();
    window.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
  }, [view]);

  /**
   * A click on the record's own way back: the hash changes, the page leaves this mode, and the
   * chapter's own slot (or the contents) is brought into view once it exists. A chapter link is
   * also the page's book-view switch: the record may have been opened from the chronicle, where
   * no `#ch-<n>` exists until that view comes back.
   */
  const leave = (href: string, chapter: number | null) => (event: MouseEvent<HTMLAnchorElement>): void => {
    event.preventDefault();
    window.location.hash = href;
    if (chapter !== null && href === `#ch-${chapter}`) onOpenChapter?.(chapter);
    afterPaint(() => {
      const chapterNode = chapter === null ? null : document.getElementById(`ch-${chapter}`);
      const named = document.getElementById(href.slice(1));
      const target = href === '#pass' ? (named ?? chapterNode) : named;
      if (target === null) return;
      if (href === '#pass' && named === null && chapterNode !== null) {
        // The address keeps the truth: the block was not there, so the chapter's head is where
        // the reader landed.
        window.history.replaceState(null, '', `#ch-${chapter}`);
      }
      const extra = target.id === 'pass' ? 16 : 0;
      const top = target.getBoundingClientRect().top + window.scrollY - headOffset() - extra;
      window.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
    });
  };

  return (
    <section className="page sheet pass-record" aria-label="запись о главе" aria-busy={view === null ? 'true' : undefined}>
      <h2 className="pr-head" ref={heading}>
        {view?.head ?? null}
      </h2>
      {view === null ? null : <PassRecordBody view={view} onLeave={leave} />}
    </section>
  );
}

function PassRecordBody({
  view,
  onLeave,
}: {
  view: PassRecordView;
  onLeave: (href: string, chapter: number | null) => (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  if (view.phase === 'absent') {
    return (
      <p className="pr-absent">
        <a className="pr-jump" href={view.href} onClick={onLeave(view.href, view.chapter)}>
          {view.link}
        </a>
      </p>
    );
  }

  const facts =
    view.phase === 'live'
      ? [view.since, view.paragraph === null ? null : `абзац ${view.paragraph}`].filter((part) => part !== null).join(MIDDOT)
      : view.duration;
  const link = (
    <a className="pr-jump" href={view.href} onClick={onLeave(view.href, view.chapter)}>
      {view.link}
    </a>
  );

  return (
    <>
      <div className="pr-now">
        {view.phase === 'live' ? (
          <span className="pr-state">
            <span className="pr-square" aria-hidden="true" />
            {view.stageWord}
          </span>
        ) : (
          <span className="pr-final">{view.finalWord}</span>
        )}
        {facts === null || facts === '' ? null : <span className="pr-facts">{facts}</span>}
      </div>
      {view.timeline.length === 0 ? null : (
        <ol className="pr-timeline">
          {view.timeline.map((step, index) => (
            <li
              key={`${step.word}-${step.time}-${String(index)}`}
              className={step.current ? 'pr-step is-current' : 'pr-step'}
              aria-current={step.current ? 'step' : undefined}
            >
              <span className="pr-word">{step.word}</span>{' '}
              <span className="pr-time">{step.time}</span>
            </li>
          ))}
        </ol>
      )}
      {view.phase === 'live' ? (
        <p className="pr-next">{link}</p>
      ) : (
        <>
          {view.span === null ? null : <p className="pr-span">{spanText(view.span)}</p>}
          {view.cost === null ? null : <p className="pr-cost">{view.cost}</p>}
          <footer className="pr-foot">
            {view.chapterTitle === null ? null : <span className="pr-place">«{view.chapterTitle}»</span>}
            {link}
          </footer>
        </>
      )}
    </>
  );
}
