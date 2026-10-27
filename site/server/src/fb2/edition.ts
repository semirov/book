/**
 * BOOK-60 — the edition number: the one name of one state of the manuscript (BOOK-DOC-41 §1).
 *
 * The number is a hash over the *stored file hashes* the ingest already wrote — `front.title`,
 * `front.about_sha256` and every chapter's `n`/`sha256`/`basis` — never over the paragraphs.
 * That is what lets `/api/front` and `/book.fb2` name the same edition for two indexed reads of
 * ≤ 68 rows, while a `304` costs no block read and no serializer.
 *
 * The hash moves when a chapter's bytes, a slot's basis flag, the published title or the
 * annotation change; it stands still on an export, on a non-text log fact, on a restart and on
 * a rebuild of the database over the same files. One-way invariant: the number always names the
 * same book, while the same book may be named by more than one number (a blank line that does
 * not change a paragraph is a new file hash) — the price of 68 rows instead of 1.5 MB.
 */

import type { Db } from '../db/db.ts';
import { listChapterRows, type ChapterRow } from '../db/repo/chapters.ts';
import { getFrontRow, type FrontRow } from '../db/repo/front.ts';
import { sha256Hex } from '../util/hash.ts';

export type Edition = { hash: string; revision: number };

/** The salt the spec names: `blank|<author>|…` (§1). */
const SALT = 'blank';

/**
 * The full 64-character lowercase hash of one edition. `chapters` must be in ascending `n`;
 * `listChapterRows` orders them, and the order is part of the input.
 */
export function editionHashOf(
  front: FrontRow | undefined,
  chapters: readonly ChapterRow[],
  author: string,
): string {
  const parts = [SALT, author, front?.title ?? '', front?.about_sha256 ?? ''];
  for (const row of chapters) parts.push(`${row.n}:${row.sha256}:${row.basis === 1 ? 1 : 0}`);
  return sha256Hex(parts.join('|'));
}

/**
 * The edition's decimal revision — the **low 52 bits** of the hash. BOOK-DOC-41 §1 and comment
 * #3613 both define it this way, so these are the **last** thirteen hex characters; §5's "its
 * first 13 hex in decimal" is a wording slip. 52 bits stay below 2^53, so the integer is exact
 * in JavaScript; FB2's `xs:float` accepts the decimal as a lexical value, but the schema's
 * binary32 carries it only approximately. The revision is the edition's *name*, not a measure,
 * and the untruncated hash on the ETag is what keeps that name unique.
 */
export function revisionOf(hash: string): number {
  return Number(BigInt(`0x${hash.slice(-13)}`));
}

/** Two indexed reads, no block: the name of the state the database is in right now. */
export function readEdition(db: Db, author: string): Edition {
  const hash = editionHashOf(getFrontRow(db), listChapterRows(db), author);
  return { hash, revision: revisionOf(hash) };
}
