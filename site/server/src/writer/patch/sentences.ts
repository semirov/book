/**
 * A block patch as a **character edit** of the sentence ledger (BOOK-173 §2, ADR-044 §2.2).
 *
 * The writer's answer names a block and two stretches of text; it never names a sentence, and it
 * never sees a sentence id (ADR-044: the writer emits no verb because it sees no id). But the
 * product anchors on sentences, so the landing has to carry enough for `sentences/transform.ts` to
 * keep every id the patch did not kill: which block, its text before and after, and where inside
 * it the replacement sits. That is exactly this module's output — the applier's own window, in the
 * unit the sentence rows are measured in (code points into the block's text).
 *
 * **Exactness is the whole point.** `from` is the offset of the first occurrence of `oldText` in
 * the block, and the caller only reaches this function after `patchCheck.resolveEdits` has found
 * that occurrence **byte for byte, exactly once**. A block whose `oldText` does not match is
 * refused before anything is written; nothing here normalises, trims or fuzzy-matches, because a
 * `.` added to a quote is a different span of text and a guessed offset would re-key the very
 * sentences the patch was filed about.
 *
 * A block that the patch names but does not change produces no entry: a re-land of the same bytes
 * must write no sentence row at all (`transform.ts` already returns early on an empty window).
 */

import { cpOffsetOf } from '../../ledger/spans.ts';
import { occurrenceIndices, type PatchEdit } from '../../ledger/patchCheck.ts';
import type { SentencePatchEdit } from '../../sentences/transform.ts';

export type SentenceEditInput = {
  /** The chapter's blocks **before** the patch, in order — the ids the sentence rows carry now. */
  before: ReadonlyArray<{ id: string; text: string }>;
  /** The same chapter parsed again **after** the patch: a block id is content-derived. */
  after: ReadonlyArray<{ id: string; text: string }>;
  edits: ReadonlyArray<PatchEdit>;
};

/**
 * The patch's edits, each resolved to the sentence layer's shape: the block it names, that block's
 * text on both sides of the write, and the smallest span the writer actually replaced.
 *
 * `newBlockId` is read from the post-image at the same position, not derived here: the applier has
 * already proven that a patch keeps the block count and every untouched block's bytes and order, so
 * index-by-index is the one mapping that cannot mistake a neighbour for the edited paragraph.
 */
export function sentenceEditsOf(input: SentenceEditInput): SentencePatchEdit[] {
  const out: SentencePatchEdit[] = [];
  const indexOf = new Map(input.before.map((block, index) => [block.id, index]));
  for (const edit of input.edits) {
    if (edit.oldText === edit.newText) continue;
    const index = indexOf.get(edit.blockId);
    if (index === undefined) continue;
    const before = input.before[index];
    const after = input.after[index];
    if (before === undefined || after === undefined) continue;
    // Exactly one occurrence was proven by the applier; `-1` cannot happen on that path, and if it
    // ever does the honest answer is «no sentence edit» rather than an offset nobody named.
    const at = occurrenceIndices(before.text, edit.oldText)[0];
    if (at === undefined) continue;
    out.push({
      blockId: before.id,
      newBlockId: after.id,
      oldText: before.text,
      newText: after.text,
      from: cpOffsetOf(before.text, at),
      oldFragment: edit.oldText,
      newFragment: edit.newText,
    });
  }
  return out;
}
