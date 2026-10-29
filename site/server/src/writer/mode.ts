/**
 * Which write mode a pass runs in (BOOK-173 §4). One decision, taken from facts the engine
 * already stated — never from what the prompt happens to look like:
 *
 *   draft · a slot with no text · a basis-only slot            → `rewrite`
 *   `scopeHint === 'chapter'`                                  → `rewrite`
 *   `scopeHint === 'phrase'` on a written chapter               → `patch`
 *   a **live sentence anchor** on a written chapter             → `patch`
 *   no anchor, no phrase scope (cascade, ending, front, sweep)  → `rewrite`
 *   the model answers `mode:"rewrite"`                          → `rewrite` (`MODEL_REWRITE`)
 *
 * The default, one line (§4 of BOOK-DOC-65): **patch for a filing on a sentence in a written
 * chapter; rewrite for a draft, an empty slot, chapter scope, or when the model asks.**
 *
 * The sentence anchor is the v25 fact the reader's filing already carries: a change whose anchor
 * names a sentence row that is still live is aimed at words the book holds, and a patch is what
 * keeps that sentence's identity (`sentences/transform.ts`) — the unit the product anchors on.
 * `scopeHint === 'phrase'` stays as the wider door for a filing stored before v25, whose anchor
 * names blocks only.
 *
 * A rewrite silently downgraded to a patch would turn a filed change of outcome into cosmetics
 * and close it done (§7), so the default stays the wider, safer mode wherever the evidence is
 * thin. Gate-driven revisions (`reviseText`) are never patched: findings may name any part of the
 * chapter, and a revision is not a filing — that is `reason: 'revision'`, taken by the revision
 * path itself.
 */

import type { ScopeHint, WriteMode } from '@book/shared';

/** The vocabulary is `shared`'s — the engine records the same word with the plan (`change_plans`). */
export type { WriteMode };

/** Why the mode is what it is: the stage line and the transcript both print this, not a guess. */
export type ModeReason =
  | 'slot-empty'
  | 'chapter-scope'
  | 'phrase-scope'
  | 'sentence-anchor'
  | 'no-scope'
  | 'model'
  | 'revision'
  /** `WRITER_MODE_DEFAULT=rewrite`: the owner's kill switch, before any other rule. */
  | 'default-rewrite'
  /**
   * BOOK-DOC-84 §10.8 — the ladder widened this attempt: the third failure widened the
   * requirement, so the attempt is a whole chapter whatever the filing asked for.
   */
  | 'widened';

export type ModeChoice = { mode: WriteMode; reason: ModeReason };

export type ModeInput = {
  pass: string;
  scopeHint: ScopeHint | null;
  /** BOOK-173 §3: `changes.anchor` names a sentence that is still live in the book. */
  sentenceAnchor?: boolean;
};

/**
 * The table, in one place. `written` is the chapter's own fact, not the step's; `defaultMode` is
 * `WRITER_MODE_DEFAULT` — `patch` unless the owner has flipped the kill switch, which forces the
 * whole-chapter path for every pass before any other rule is read.
 */
export function chooseMode(input: ModeInput, written: boolean, defaultMode: WriteMode = 'patch'): ModeChoice {
  if (defaultMode === 'rewrite') return { mode: 'rewrite', reason: 'default-rewrite' };
  if (input.pass === 'draft' || !written) return { mode: 'rewrite', reason: 'slot-empty' };
  if (input.scopeHint === 'chapter') return { mode: 'rewrite', reason: 'chapter-scope' };
  if (input.scopeHint === 'phrase') return { mode: 'patch', reason: 'phrase-scope' };
  if (input.sentenceAnchor === true) return { mode: 'patch', reason: 'sentence-anchor' };
  return { mode: 'rewrite', reason: 'no-scope' };
}

/**
 * BOOK-173 §7: a ripple chapter is a consequence, not a filing — it always patches, whatever the
 * origin change's scope was, because the closure named one claim to repair and a rewrite would
 * replace a whole chapter to fix a sentence.
 */
export const RIPPLE_MODE: ModeChoice = { mode: 'patch', reason: 'phrase-scope' };

/** A gate-driven revision: always a whole chapter, whatever the filing said (§4). */
export const REVISION_MODE: ModeChoice = { mode: 'rewrite', reason: 'revision' };

/** The model declined the patch and asked for the whole-chapter path: one step, no retry. */
export const MODEL_REWRITE: ModeChoice = { mode: 'rewrite', reason: 'model' };
