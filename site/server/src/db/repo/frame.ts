/**
 * `book_frame` — the two canon sentences, as the volume holds them (BOOK-187, ADR-043 G6).
 *
 * The table is seeded by migration v28 from the constants the image compiles in, so a reader of
 * this module never types a sentence and never reads a file: the row is what the site serves, and
 * the constant is the witness the frame check compares it with. `position` says which end of
 * which chapter the row belongs to — `ch01/first` opens the book, `ch42/last` closes it.
 *
 * Read-only here on purpose: the only writer is the migration, and a pass may not rewrite the
 * canon (BOOK-137 — a filing that touches the frame is paperwork, not an edit).
 */

import type { Db } from '../db.ts';
import { sha256Hex } from '../../util/hash.ts';

/** Which end of the chapter the row is: the opening sentence or the closing one. */
export type FramePosition = 'first' | 'last';

export type FrameRow = {
  chapter: number;
  position: FramePosition;
  /** The sentence exactly as the image compiled it into the row. */
  text: string;
  /** `sha256(text)`; a check can compare hashes without shipping the letters. */
  sha256: string;
  /** The migration moment that wrote the row. */
  seeded_at: string;
};

/** The sentence a chapter holds at one end, or null when the row is not there. */
export function frameOf(db: Db, chapter: number, position: FramePosition): string | null {
  const row = db.prepare('SELECT text FROM book_frame WHERE chapter = ? AND position = ?').get(chapter, position) as
    | { text: string }
    | undefined;
  return row?.text ?? null;
}

/** The stored hash of one frame row, or null when the row is not there (health reads this). */
export function frameSha(db: Db, chapter: number, position: FramePosition): string | null {
  const row = db.prepare('SELECT sha256 FROM book_frame WHERE chapter = ? AND position = ?').get(chapter, position) as
    | { sha256: string }
    | undefined;
  return row?.sha256 ?? null;
}

/** One frame as the wire's paragraph: the text plus the id and hash `BlockDto` carries. */
export type FrameBlock = { id: string; text: string; hash: string };

/**
 * The frame row as a served paragraph (BOOK-187 AC3): a fresh volume has no `chapters` row, so
 * the frame's own row is the slot's one basis block — the volume is what the reader is given,
 * not a constant compiled into the image. The id and hash are derived from the served text, so
 * two answers of the same row carry the same identity; `null` when the slot has no row.
 */
export function frameBlockOf(db: Db, chapter: number, position: FramePosition): FrameBlock | null {
  const text = frameOf(db, chapter, position);
  if (text === null) return null;
  const hash = sha256Hex(text).slice(0, 8);
  return { id: `ch${String(chapter).padStart(2, '0')}#${hash}`, text, hash };
}
