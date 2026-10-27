import { chapterLabel } from '@book/shared';

import type { PendingStage } from './pending.ts';

/**
 * BOOK-DOC-43 §3 and §6 — the form of a placeholder and the one sentence it may say
 * (BOOK-66).
 *
 * A placeholder is a form with blank fields, not a grey block: hairlines on the book's own
 * paper, at the measure's width, ragged where writing is ragged. It imitates the *shape* of
 * the arriving thing and prints no word and no number it does not hold. The numbers here are
 * the spec's; the chapter's line box and paragraph gap are in `styles/skeleton.css`, because
 * they follow the prose size with no media query.
 */
export type SkeletonVariant = 'chapter' | 'register' | 'chronicle' | 'authors' | 'chain' | 'sheet';

/** Lines per paragraph (chapter, sheet) or rows per list (the rest). */
export const SKELETON_LINES: Readonly<Record<SkeletonVariant, readonly number[]>> = {
  chapter: [3, 3, 2],
  register: [3],
  chronicle: [3],
  authors: [3],
  chain: [3],
  sheet: [2, 2],
};

/**
 * The eight chapter widths in order, as percentages: 94 · 88 · 62 ‖ 97 · 91 · 55 ‖ 90 · 68.
 *
 * Ragged, never 100 %: a justified skeleton reads as a ruled form or a table, and the
 * register already owns that idiom. A placeholder marks *writing*, and writing ends
 * unevenly — the three paragraph endings 62 / 55 / 68 are the signature that this is prose.
 */
export const CHAPTER_WIDTHS: readonly number[] = [94, 88, 62, 97, 91, 55, 90, 68];

/**
 * The height a row surface reserves while it loads, in px (§3). Boot, chapter and fb2 are
 * absent on purpose: boot has no placeholder, the chapter's reserve is the existing
 * `estimateChapterHeight` box (the placeholder adds 0), and fb2 does not exist in code yet.
 */
export const SKELETON_MIN_HEIGHT_PX: Readonly<
  Record<'register' | 'chronicle' | 'authors' | 'chain' | 'sheet', number>
> = {
  register: 236,
  chronicle: 150,
  authors: 132,
  chain: 220,
  sheet: 176,
};

/**
 * The chapter placeholder's floor, in px (§3, corrected 2026-10-27 — BOOK-66 review).
 *
 * The chapter form is 8 lines of 1.68em plus two paragraph gaps of 1.02em: 278.64 px at
 * `--fs-body: 18`. It lives *inside* the box `.ch-placeholder` reserves, so the box has to be
 * at least that tall — a short written chapter (49 chars) estimates 120 px, the form overruns
 * it, and the arriving text then moves the page: the CLS §3 forbids. The box therefore takes
 * `max(estimate, 279)`, the form's own worst case, not a new reserved height.
 */
export const CHAPTER_BOX_PX = 279;

/** A surface that can be waiting; `boot` and `chapter` carry their own frame. */
export type SkeletonSurface = 'boot' | 'chapter' | 'register' | 'chronicle' | 'authors' | 'chain' | 'sheet';

/** §6, the label register: the surface's verb, no percentage, no «осталось». */
const LOADING: Readonly<Record<Exclude<SkeletonSurface, 'chapter'>, string>> = {
  boot: 'опись читается',
  register: 'замечания читаются',
  chronicle: 'записи читаются',
  authors: 'доли считаются',
  chain: 'цепочка читается…',
  sheet: 'правка читается',
};

/** §6 — one sentence at 2 000 ms: the wait is longer than usual, the thing lands here. */
const SLOW: Readonly<Record<SkeletonSurface, string>> = {
  boot: 'опись идёт дольше обычного · книга откроется здесь же',
  chapter: 'глава идёт дольше обычного · текст появится здесь же',
  register: 'замечания идут дольше обычного · строки появятся здесь же',
  chronicle: 'записи идут дольше обычного · хроника появится здесь же',
  authors: 'доли считаются дольше обычного · цифры появятся здесь же',
  chain: 'цепочка идёт дольше обычного · история появится здесь же',
  sheet: 'правка идёт дольше обычного · лист заполнится здесь же',
};

/**
 * The one status line a surface prints, or `null` while the wait is still quiet.
 *
 * The `■` of «■ читаем главу 07» is the chapter's meta chrome, not part of this sentence:
 * the `role="status"` element carries exactly the text returned here.
 */
export function statusLine(surface: SkeletonSurface, stage: PendingStage, chapter?: number): string | null {
  if (stage === 'quiet') return null;
  if (stage === 'slow') return SLOW[surface];
  if (surface !== 'chapter') return LOADING[surface];
  // A chapter status names its field number; the app always passes `entry.n`, and the bare
  // verb is the honest minimum rather than a number invented for a slot nobody opened.
  return chapter === undefined ? 'читаем главу' : `читаем главу ${chapterLabel(chapter)}`;
}
