/**
 * Which write mode a pass runs in (BOOK-173 §4). One decision, taken from facts the engine
 * already stated — never from what the prompt happens to look like:
 *
 *   draft · a slot with no text · a basis-only slot → `rewrite`
 *   `scopeHint === 'chapter'`                        → `rewrite`
 *   `scopeHint === 'phrase'` on a written chapter     → `patch`
 *   `scopeHint === null` (cascade, ending, front, sweep, old rows) → `rewrite`
 *
 * A rewrite silently downgraded to a patch would turn a filed change of outcome into cosmetics
 * and close it done (§7), so the default is the wider, safer mode: only a filing that says it
 * is about a phrase, on a chapter that exists, may patch. Gate-driven revisions (`reviseText`)
 * are never patched either: findings may name any part of the chapter, and a revision is not a
 * filing — that is `reason: 'revision'`, taken by the revision path itself.
 */

import type { ScopeHint } from '@book/shared';

export type WriteMode = 'patch' | 'rewrite';

/** Why the mode is what it is: the stage line and the transcript both print this, not a guess. */
export type ModeReason = 'slot-empty' | 'chapter-scope' | 'phrase-scope' | 'no-scope' | 'model' | 'revision';

export type ModeChoice = { mode: WriteMode; reason: ModeReason };

export type ModeInput = { pass: string; scopeHint: ScopeHint | null };

/** The table, in one place. `written` is the chapter's own fact, not the step's. */
export function chooseMode(input: ModeInput, written: boolean): ModeChoice {
  if (input.pass === 'draft' || !written) return { mode: 'rewrite', reason: 'slot-empty' };
  if (input.scopeHint === 'chapter') return { mode: 'rewrite', reason: 'chapter-scope' };
  if (input.scopeHint === 'phrase') return { mode: 'patch', reason: 'phrase-scope' };
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
