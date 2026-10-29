/**
 * The printing reveal's state machine as a hook (ARCHITECTURE §11.3–11.5, BOOK-DOC-49;
 * BOOK-220 §11.2): the queue, the frame loop, the first-paint window, and the one place a
 * change is brought to the reading line (BOOK-117).
 *
 * It owns nothing about the chapter's text: the caller hands it a plan (`startReveal`) and the
 * chapter that is now on screen, and it prints. The schedule is the print engine's
 * (`lib/printPlan.ts` via `lib/reveal.ts`) — one clock for a chapter being written and for the
 * clip renderer's edit — at the device's rate, with the seed carried by the block's own id.
 *
 * `startReveal(loaded, changed, clock)`'s third argument is the print's own start: a chapter
 * written by a pass is clocked from `chapter:applied.appliedAt`, so a page that mounts inside
 * the print joins the current frame instead of replaying it. With no clock the reveal starts
 * now — that is a page load, and only a young chapter's tail prints there.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { BlockDto, ChapterDto } from '@book/shared';

import { reducedMotion } from '../dom.ts';
import {
  createReveal,
  planReveal,
  revealComplete,
  revealCps,
  skipBlocks,
  tickReveal,
  type RevealState,
} from './reveal.ts';

export type PrintingReveal = {
  article: React.RefObject<HTMLElement | null>;
  reveal: RevealState | null;
  setReveal: React.Dispatch<React.SetStateAction<RevealState | null>>;
  printing: boolean;
  /** The first block of the change that just landed, for the reading-line move. */
  line: React.MutableRefObject<string | null>;
  /** Plan the chapter's print. `clock` is the print's own start (`appliedAt`), when there is one. */
  startReveal: (loaded: ChapterDto, changed: ReadonlySet<string> | null, clock?: number) => void;
};

export function usePrintingReveal(input: {
  chapter: { blocks: readonly BlockDto[] } | null;
  fresh: boolean;
}): PrintingReveal {
  const [reveal, setReveal] = useState<RevealState | null>(null);
  const article = useRef<HTMLElement | null>(null);
  const measured = useRef(false);
  const line = useRef<string | null>(null);

  const printing = reveal !== null && !revealComplete(reveal);

  const startReveal = useCallback(
    (loaded: ChapterDto, changed: ReadonlySet<string> | null, clock?: number) => {
      const reduce = reducedMotion();
      // The clock is the write's own moment; a page load has none and starts now.
      const startAt = clock !== undefined && Number.isFinite(clock) ? clock : undefined;
      // `null` for a basis slot served before its chapter exists (BOOK-187 AC3): just written.
      const writtenAt = loaded.writtenAt === null ? Number.NaN : Date.parse(loaded.writtenAt);
      const ageMs = Number.isNaN(writtenAt) ? 0 : Date.now() - writtenAt;
      const plan = planReveal({
        blocks: loaded.blocks,
        mode: changed === null ? (input.fresh || startAt !== undefined ? 'live' : 'join') : 'change',
        changedIds: changed ?? undefined,
        chapterAgeMs: Math.max(0, ageMs),
        reducedMotion: reduce,
      });
      const queued = loaded.blocks.filter((block) => plan.queued.includes(block.id));
      setReveal(
        createReveal(queued, {
          reducedMotion: reduce,
          cps: revealCps(typeof window === 'undefined' ? 390 : window.innerWidth),
          startAt,
          now: Date.now(),
        }),
      );
      measured.current = false;
    },
    [input.fresh],
  );

  // One frame loop while the queue prints; it stops when the queue is empty. No speed factor:
  // the owner's rule is one pace, and a drain at 8× is a speed control.
  useEffect(() => {
    if (!printing) return;
    let frame = 0;
    let last = performance.now();
    const step = (now: number): void => {
      const delta = Math.min(250, now - last);
      last = now;
      setReveal((current) => (current === null ? current : tickReveal(current, delta)));
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [printing]);

  // Only blocks inside the reveal window print; after the first paint the rest is set. A block
  // the reader cannot see is already text — that is the design's own viewport rule (§11.5).
  useEffect(() => {
    if (input.chapter === null || reveal === null || measured.current) return;
    // A chapter being written prints whole (BOOK-220 §11.2): the viewport economy is a page
    // load's rule, not a print's.
    if (reveal.print) {
      measured.current = true;
      return;
    }
    measured.current = true;
    const node = article.current;
    if (node === null) return;
    const height = window.innerHeight || 800;
    const skipped = new Set<string>();
    for (const element of node.querySelectorAll('[data-block-id]')) {
      const id = element.getAttribute('data-block-id');
      if (id === null) continue;
      const rect = element.getBoundingClientRect();
      if (rect.bottom < -1.5 * height || rect.top > 2.5 * height) skipped.add(id);
    }
    if (skipped.size > 0) setReveal((current) => (current === null ? current : skipBlocks(current, skipped)));
  }, [input.chapter, reveal]);

  // BOOK-117: the change is brought to the reading line, and only when it is off-screen.
  useEffect(() => {
    const id = line.current;
    line.current = null;
    const node = id === null ? null : article.current?.querySelector<HTMLElement>(`[data-block-id="${id}"]`);
    if (node === null || node === undefined) return;
    const rect = node.getBoundingClientRect();
    if (rect.top >= 0 && rect.bottom <= (window.innerHeight || 800)) return;
    node.scrollIntoView?.({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
  }, [input.chapter, reveal]);

  return { article, reveal, setReveal, printing, line, startReveal };
}
