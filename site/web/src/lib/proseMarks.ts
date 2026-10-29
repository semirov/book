import type { CommentDto } from '@book/shared';

import { filingsForBlock, isAlive, type SentenceFilings } from './filings.ts';
import { sentenceAt } from './marginalia.ts';
import { clampQuote, splitSentences, type Sentence } from './seam.ts';

/**
 * BOOK-90 — what marks a paragraph's sentences, resolved away from the component.
 *
 * One sentence keeps one mark. Its own quote marks it when a filing was written for exactly
 * that sentence; when no sentence carries the quote any more (a landed change rewrites its
 * own sentence), the filing is drawn at the sentence its anchor's place points at — the same
 * resolution the revision object reads «стало» with, so the record stays reachable from the
 * text it changed. An unresolved anchor is not a place, and alive filings win the slot over
 * landed ones (the rule `FilingMark` states). Pure: text and comments in, maps out.
 */

export type ProseMarks = {
  /** The paragraph's sentences, in reading order. */
  sentences: Sentence[];
  /** The block's filings as the markup reads them (the seam's own lookup uses this). */
  groups: SentenceFilings[];
  /** The group that marks each sentence, by the sentence's start offset. */
  marks: Map<number, SentenceFilings>;
  /** Every alive filing, in reading order, each one **once**: the phone strip's rows. */
  alive: CommentDto[];
  /** `id:status` for the block — the margin pass's memo key. */
  key: string;
};

export function proseMarks(text: string, comments: readonly CommentDto[], blockId: string): ProseMarks {
  const groups = filingsForBlock(comments, blockId);
  const sentences = splitSentences(text);
  const exact = new Set(sentences.map((sentence) => clampQuote(sentence.text)));
  const moved = new Map<number, SentenceFilings>();
  // The sort is stable, so equal groups keep the order the block gave them.
  const byAlive = [...groups].sort(
    (left, right) => Number(right.all.some(isAlive)) - Number(left.all.some(isAlive)),
  );
  for (const group of byAlive) {
    if (group.quote === null || exact.has(group.quote)) continue;
    for (const comment of group.all) {
      const start = sentenceAt(text, comment.anchor);
      if (start === null || moved.has(start)) continue;
      moved.set(start, group);
      break;
    }
  }
  const marks = new Map<number, SentenceFilings>();
  const alive: CommentDto[] = [];
  /** BOOK-218 — one filing is one row: a repeated wording reaches the group twice. */
  const listed = new Set<string>();
  for (const sentence of sentences) {
    // The anchor quote is clamped to the server's bound, so a long sentence is matched by the
    // same clamp the filing was made with — not by its raw text (BOOK-33).
    const quote = clampQuote(sentence.text);
    const group = groups.find((item) => item.quote !== null && item.quote === quote) ?? moved.get(sentence.start);
    if (group === undefined) continue;
    marks.set(sentence.start, group);
    for (const comment of group.all.filter(isAlive)) {
      if (listed.has(comment.id)) continue;
      listed.add(comment.id);
      alive.push(comment);
    }
  }
  const key = groups.map((group) => group.all.map((comment) => `${comment.id}:${comment.status}`).join(',')).join('|');
  return { sentences, groups, marks, alive, key };
}
