/**
 * The printing reveal's state machine as a hook (ARCHITECTURE §11.3–11.5, BOOK-DOC-49):
 * the queue, the animation loop, the off-screen speed-up, the first-paint window, and the one
 * place a change is brought to the reading line (BOOK-117).
 *
 * It owns nothing about the chapter's text: the caller hands it a plan (`startReveal`) and the
 * chapter that is now on screen, and it prints. Extracted from `ChapterArticle` so that
 * component stays the layout and not the clock.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { nearViewport, reducedMotion } from '../dom.ts';
import { REVEAL, blockText as _unused, createReveal, planReveal, revealComplete, skipBlocks, tickReveal, type RevealState } from './reveal.ts';
import type { BlockDto, ChapterDto } from '@book/shared';

void _unused;

export type PrintingReveal = {
  article: React.RefObject<HTMLElement | null>;
  reveal: RevealState | null;
  setReveal: React.Dispatch<React.SetStateAction<RevealState | null>>;
  printing: boolean;
  /** The first block of the change that just landed, for the reading-line move. */
  line: React.MutableRefObject<string | null>;
  startReveal: (loaded: ChapterDto, changed: ReadonlySet<string> | null) => void;
};

export function usePrintingReveal(input: {
  chapter: { blocks: readonly BlockDto[] } | null;
  fresh: boolean;
}): PrintingReveal {
  const [reveal, setReveal] = useState<RevealState | null>(null);
  const article = useRef<HTMLElement | null>(null);
  const measured = useRef(false);
  const speed = useRef(1);
  const line = useRef<string | null>(null);

  const printing = reveal !== null && !revealComplete(reveal);

  const startReveal = useCallback(
    (loaded: ChapterDto, changed: ReadonlySet<string> | null) => {
      const reduce = reducedMotion();
      // `null` for a basis slot served before its chapter exists (BOOK-187 AC3): just written.
      const writtenAt = loaded.writtenAt === null ? Number.NaN : Date.parse(loaded.writtenAt);
      const ageMs = Number.isNaN(writtenAt) ? 0 : Date.now() - writtenAt;
      const plan = planReveal({
        blocks: loaded.blocks,
        mode: changed === null ? (input.fresh ? 'live' : 'join') : 'change',
        changedIds: changed ?? undefined,
        chapterAgeMs: Math.max(0, ageMs),
        reducedMotion: reduce,
      });
      const queued = loaded.blocks.filter((block) => plan.queued.includes(block.id));
      setReveal(createReveal(queued, { reducedMotion: reduce }));
      measured.current = false;
    },
    [input.fresh],
  );

  // One animation loop while the queue prints; it stops when the queue is empty.
  useEffect(() => {
    if (!printing) return;
    let frame = 0;
    let last = performance.now();
    const step = (now: number): void => {
      const delta = Math.min(250, now - last);
      last = now;
      setReveal((current) => (current === null ? current : tickReveal(current, delta, speed.current)));
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [printing]);

  // Scrolling away drains the queue at 8× rather than holding a chapter hostage.
  useEffect(() => {
    const update = (): void => {
      const node = article.current;
      speed.current = node !== null && !nearViewport(node, 0.5) ? REVEAL.offscreenSpeedUp : 1;
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, []);

  // Only blocks inside the reveal window print; after the first paint the rest is set.
  useEffect(() => {
    if (input.chapter === null || reveal === null || measured.current) return;
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
