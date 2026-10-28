import type { CommentDto } from '@book/shared';
import { useEffect, useState } from 'react';

import type { ChapterFeed } from '../useReaderFeed.ts';

/**
 * BOOK-158 — the page's one clock for a refusal's cooldown.
 *
 * The server freezes `revise` into the DTO, so a page left open keeps reading the answer it
 * got at load: «можно повторить через 1 минуту» for as long as the tab lives, and a disabled
 * «исправить» that should have opened ten minutes after the refusal. One hook owns the two
 * timers that make the frozen answer move:
 *
 *   • a **tick** every 30 s while any filing is cooling down, so the printed minutes count
 *     down (the surfaces render `reviseView(comment, nowMs)` with this `nowMs`);
 *   • one **refresh** of the nearest cooling chapter just after its `revise.at`, so the DTO is
 *     re-read and the door really opens — the page cannot unlock itself on its own clock, the
 *     server's `allowed` is the only answer.
 *
 * No cooldown, no timer: an idle page schedules nothing. Unmount clears both.
 */

/** How often the printed countdown is recomputed while a cooldown is live. */
export const REVISE_TICK_MS = 30_000;
/** The wait after `revise.at` before the chapter is re-read: the server's clock, not ours. */
export const REVISE_REFRESH_LAG_MS = 1_000;

export type CoolingFiling = { chapter: number; at: number };

/** The feeds the hook reads: the register's list and every chapter already on screen. */
export type ReviseFeeds = {
  comments: readonly CommentDto[];
  chapterFeed: Readonly<Record<number, ChapterFeed>>;
};

/**
 * The nearest cooldown that is still in the future, or `null`. Pure, so the search is tested
 * apart from the timers: a row is a candidate only when the server says the cooldown is what
 * blocks it and `at` still lies ahead — a past `at` is a page waiting for its refresh, not a
 * row to schedule.
 */
export function nextCooldown(feeds: ReviseFeeds, nowMs: number): CoolingFiling | null {
  const rows = [
    ...feeds.comments,
    ...Object.values(feeds.chapterFeed).flatMap((feed) => feed.items),
  ];
  let next: CoolingFiling | null = null;
  for (const row of rows) {
    const revise = row.revise;
    if (revise === undefined || revise.allowed || revise.blocked !== 'cooldown' || revise.at === null) {
      continue;
    }
    const at = Date.parse(revise.at);
    if (!Number.isFinite(at) || at <= nowMs) continue;
    if (next === null || at < next.at) next = { chapter: row.chapter, at };
  }
  return next;
}

/**
 * The clock the revise surfaces render against. Returns `nowMs`, which re-renders the page
 * every tick; the surfaces pass it into `reviseView`, so the cooldown line is never frozen.
 */
export function useReviseTick(
  comments: readonly CommentDto[],
  chapterFeed: Readonly<Record<number, ChapterFeed>>,
  refreshComments: (chapter?: number) => Promise<void>,
): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const next = nextCooldown({ comments, chapterFeed }, nowMs);
  const at = next?.at ?? null;
  const chapter = next?.chapter ?? null;

  // A cooldown that arrived in a frame re-bases the clock at once: without this the first line
  // after an idle page would subtract from the last tick, hours ago, and print a huge minute
  // count for one frame.
  useEffect(() => {
    if (at === null) return;
    setNowMs(Date.now());
  }, [at]);

  useEffect(() => {
    if (at === null || chapter === null) return;
    const refresh = window.setTimeout(
      () => {
        void refreshComments(chapter);
        setNowMs(Date.now());
      },
      Math.max(0, at - Date.now()) + REVISE_REFRESH_LAG_MS,
    );
    const tick = window.setInterval(() => setNowMs(Date.now()), REVISE_TICK_MS);
    return () => {
      window.clearTimeout(refresh);
      window.clearInterval(tick);
    };
  }, [at, chapter, refreshComments]);

  return nowMs;
}
