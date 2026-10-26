/**
 * The chapter's current words, for the intent schema's new-entity rule (audit M4, §12.3).
 *
 * The rule needs to know what a chapter already talks about: a request may ask to change
 * the prose, never to introduce a thing the chapter does not have. The projection already
 * holds the text, so the vocabulary is one indexed read and never the manuscript file.
 *
 * An empty result is a real answer — a chapter that is not projected yet. `newEntityViolation`
 * treats an empty vocabulary as "cannot judge" and skips the rule, so a cold database
 * refuses nothing.
 */

import type { Db } from '../db/db.ts';

/** The current block texts of one chapter; empty when the chapter is not projected. */
export function chapterVocabulary(db: Db, chapter: number): string[] {
  const rows = db.prepare('SELECT text FROM blocks WHERE chapter = ?').all(chapter) as Array<{ text: string }>;
  return rows.map((row) => row.text);
}
