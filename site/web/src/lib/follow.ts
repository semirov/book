/**
 * BOOK-207 — following a change, in memory, one state per change.
 *
 * The owner's verdict: «следить за любой из правок в любом направлении». One control, one
 * store, and no server state at all: a follow lives while the page does, and the control
 * promises exactly the in-flow notice at the chapter the reader is in.
 *
 * Three facts decide the word, and each lives here rather than in a component:
 *
 *   - **the direction** (`followDirection`) — the moving wings of the page's ribbon, `up` =
 *     «вперёд» and `down` = «назад», with the chapter the wing has reached. A wing with no
 *     reached chapter prints the direction alone; a change with no moving wing has no control;
 *   - **the freeze** — on a tap the store records the direction it printed, so a wave that
 *     later rewrites a chapter cannot reverse the word under the reader's thumb;
 *   - **the landing** — `change:decided` for a followed change is the only landing. The five
 *     outcome words are a closed set, and the notice takes the chapters the payload names.
 */

import type { CascadeWingsDto, ChangeDecidedPayload } from '@book/shared';

import { keepPlace } from './keepPlace.ts';

export type FollowSide = 'up' | 'down';

/** `up` is forward (toward 42), `down` is backward (toward 1) — the reader's words. */
export const FOLLOW_WORDS: Record<FollowSide, string> = { up: 'вперёд', down: 'назад' };

export type FollowDir = {
  side: FollowSide;
  /** The chapter the wing has reached, or `null` when it has reached none yet. */
  to: number | null;
  wave: number;
};

export type FollowDirection = { changeId: string; dirs: FollowDir[] };

/** What a tap froze: the change, the direction words and the moment. */
export type Follow = { changeId: string; dirs: FollowDir[]; at: number };

/** The in-flow notice a landing leaves: the chapter the reader was in, its word, its chapters. */
export type LandingNotice = { chapter: number; word: string; chapters: number[] };

/**
 * The direction a change is moving in, from the ribbon's wings: only a wing whose state is
 * `moving` counts, and only that wing's reached chapters give the number. `up` takes the
 * furthest one, `down` the nearest one — «до главы N» is a fact about what was reached, never
 * a forecast.
 */
export function followDirection(changeId: string, wings: CascadeWingsDto | null): FollowDirection | null {
  if (wings === null) return null;
  const dirs: FollowDir[] = [];
  for (const side of ['up', 'down'] as const) {
    const wing = wings[side];
    if (wing.state !== 'moving') continue;
    const reached = wing.reached.filter((chapter) => Number.isInteger(chapter) && chapter > 0);
    const to = reached.length === 0 ? null : side === 'up' ? Math.max(...reached) : Math.min(...reached);
    dirs.push({ side, to, wave: wing.wave });
  }
  return dirs.length === 0 ? null : { changeId, dirs };
}

/**
 * The one control's label: `следить · вперёд · до главы 21 · назад · до главы 8`, or `слежу`
 * while following. The frozen `dirs` are used when they exist; the live ribbon is never read
 * again until an unfollow, so the word cannot reverse mid-cascade.
 */
export function followLabel(direction: FollowDirection | null, following: Follow | null): string | null {
  const dirs = following?.dirs ?? direction?.dirs ?? null;
  if (dirs === null || dirs.length === 0) return null;
  const parts = [following === null ? 'следить' : 'слежу'];
  for (const dir of dirs) {
    parts.push(FOLLOW_WORDS[dir.side]);
    if (dir.to !== null) parts.push(`до главы ${dir.to}`);
  }
  return parts.join(' · ');
}

/** The five outcome words the notice may print; `null` for an outcome this copy has no word for. */
export function decidedWord(outcome: string): string | null {
  switch (outcome) {
    case 'applied':
      return 'правка внесена';
    case 'adapted':
      return 'правка внесена частично';
    case 'registered':
      return 'правка рассмотрена';
    case 'dropped':
    case 'superseded':
    case 'failed':
    case 'refused':
      return 'правка не внесена';
    case 'escalated':
      return 'правка остановлена';
    default:
      return null;
  }
}

// ── the store ────────────────────────────────────────────────────────────────

const follows = new Map<string, Follow>();
let notice: LandingNotice | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Follow a change with the direction printed at the tap; the label freezes here. */
export function follow(direction: FollowDirection, atMs: number): Follow {
  const held: Follow = { changeId: direction.changeId, dirs: direction.dirs.map((dir) => ({ ...dir })), at: atMs };
  follows.set(direction.changeId, held);
  emit();
  return held;
}

/** Unfollow one change — one tap, no dialog. */
export function unfollow(changeId: string): void {
  if (!follows.delete(changeId)) return;
  emit();
}

export function isFollowing(changeId: string): boolean {
  return follows.has(changeId);
}

export function currentFollow(changeId: string): Follow | null {
  return follows.get(changeId) ?? null;
}

/** The current landing notice, or `null`; one at a time, and only for the read chapter. */
export function currentNotice(): LandingNotice | null {
  return notice;
}

export function dismissNotice(): void {
  if (notice === null) return;
  notice = null;
  emit();
}

/**
 * A `change:decided` frame reached the page: if its change is followed, the follow is dropped
 * and the notice belongs to the chapter the reader is in. `false` for every other change —
 * `cascade:progress` moves the unfollowed label only, and a step is never a landing.
 *
 * `readChapter` is the head's own `useReading` number: a reader on the cover has no chapter to
 * print a line in, and the follow is still over.
 */
export function landFollowed(payload: ChangeDecidedPayload, readChapter: number | null): boolean {
  if (!follows.has(payload.id)) return false;
  follows.delete(payload.id);
  const word = decidedWord(payload.outcome);
  notice = readChapter === null || word === null ? null : { chapter: readChapter, word, chapters: payload.chapters };
  emit();
  return true;
}

export function subscribeFollow(listener: () => void): () => void {
  return subscribe(listener);
}

/**
 * The frame's one act: the notice takes its place at the chapter's first paragraph while
 * `keepPlace` keeps the prose under the reader's eye. `App` calls this from the socket; the
 * measuring (and `flushSync`) is `keepPlace`'s, so no caller has to know about layout.
 */
export function landFrame(payload: ChangeDecidedPayload, readChapter: number | null): void {
  const first =
    readChapter === null ? null : document.querySelector<HTMLElement>(`#ch-${readChapter} .p`);
  keepPlace(first, () => landFollowed(payload, readChapter));
}
