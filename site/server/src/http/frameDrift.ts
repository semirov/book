/**
 * BOOK-109 / BOOK-187 — `FRAME_DRIFT`: the served frame against the row the volume holds.
 *
 * The frozen frame has one witness (`FRAME_FIRST_SENTENCE` / `FRAME_LAST_SENTENCE`, BOOK-107) and
 * the book keeps its own copy in `book_frame` (v28, ADR-043 G6). The owner twice read text in
 * ch01/ch42 that no source contained, and neither `/healthz` nor the frame smoke check could say
 * *which* side a request had just served. This comparison answers that, per request, for the only
 * two chapters whose text is the frame — and since v28 it reads no file: the served block is
 * compared with the seeded row, because the volume is the book (ADR-043 G2).
 *
 * It is deliberately cheap: one indexed row and nothing for the other chapters. A drift is logged
 * by the route (the same strings, both of them); a database with no row at all is reported once per
 * process, because a pre-v28 volume must not become a log flood.
 */

import { TOTAL_CHAPTERS, OPENING_CHAPTER } from '@book/shared';

import type { FramePosition } from '../db/repo/frame.ts';

/** The served block, as much of it as the comparison needs. */
export type ServedBlock = { text: string };

export type FrameDrift = {
  /** The row the comparison read: `book_frame/1/first`. */
  source: string;
  /** The block the request served, whitespace flattened — a log line is one line. */
  served: string;
  /** The sentence the volume holds for the same position, flattened the same way. */
  stored: string;
};

/** The row is not there (a pre-v28 volume, a wiped table): not drift, an unanswerable check. */
export type FrameUnreadable = { source: string; unreadable: string };

/** `null` — the two agree, or the chapter carries no frame (the other 40). */
export type FrameCheck = FrameDrift | FrameUnreadable | null;

/** The one reader the route hands over: `(chapter, position) => the stored sentence or null`. */
export type FrameReader = (chapter: number, position: FramePosition) => string | null;

export type FrameDriftOptions = { frameOf: FrameReader };

/** `book_frame/1/first` — the row this comparison is about, for the log line and the dedupe key. */
export function frameSource(chapter: number, position: FramePosition): string {
  return `book_frame/${String(chapter)}/${position}`;
}

/** `first` for ch01, `last` for the finale, null for the chapters no frame belongs to. */
export function framePositionOf(n: number): FramePosition | null {
  if (n === OPENING_CHAPTER) return 'first';
  if (n === TOTAL_CHAPTERS) return 'last';
  return null;
}

/** Whitespace is not identity: a re-wrapped paragraph is the same paragraph (the ingest agrees). */
function flatten(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/**
 * Compare ch01's first served block and ch42's last one with the sentence `book_frame` holds.
 *
 * The row is the sentence, the block is the paragraph that carries it: ch01's first block must
 * **open** with it and ch42's last block must **close** with it, whitespace flattened on both
 * sides. A block that lost the sentence — the owner's report — is drift, and both strings travel
 * in one log line so the line itself says which side is wrong.
 */
export function checkFrameDrift(options: FrameDriftOptions, n: number, blocks: readonly ServedBlock[]): FrameCheck {
  const position = framePositionOf(n);
  // Not a frame chapter: no row is read at all.
  if (position === null) return null;

  const source = frameSource(n, position);
  const stored = options.frameOf(n, position);
  if (stored === null) {
    return { source, unreadable: `no book_frame row for ${String(n)}/${position} (the v28 seed never ran)` };
  }

  const served = flatten(position === 'first' ? (blocks[0]?.text ?? '') : (blocks[blocks.length - 1]?.text ?? ''));
  const expected = flatten(stored);
  const carries = position === 'first' ? served.startsWith(expected) : served.endsWith(expected);
  // A readable but empty slot is drift too: the chapter claims the frame and holds nothing.
  if (expected.length > 0 && carries) return null;
  return { source, served, stored };
}
