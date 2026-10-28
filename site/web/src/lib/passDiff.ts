/**
 * BOOK-121 — where a pass wrote.
 *
 * `passMotion.ts` times a change it is handed; this module finds one: the minimal grapheme span
 * between the text the reader saw and the text the pass left, plus the place that span holds in
 * the final block. Both are grapheme-level, never code-unit-level: half a surrogate pair or a
 * stranded combining mark would be painted as a character that exists in neither text.
 *
 * `offset` is what makes the span placeable. The span itself is the stripped middle (only what
 * changed), so the renderer cannot find it inside the final block by searching for `after` —
 * the same word occurs elsewhere, and a deletion's text is not in the final block at all. The
 * caller gets the start with the span, and `passRunOf` cuts the final text with it.
 */

import type { PassKind } from './passMotion.ts';
import { graphemes } from './reveal.ts';

export type PassSpan = {
  /** What the pass removed: `''` for an insertion. */
  before: string;
  /** What it wrote: `''` for a deletion. */
  after: string;
  kind: PassKind;
  /** The run's start in the final text, in graphemes — the common prefix's length. */
  offset: number;
};

/** The final block cut around the run: the settled text before it, the run, the settled tail. */
export type PassRun = { prefix: string; run: string; suffix: string };

/** How many graphemes the two texts share at the start and at the end; the edges never overlap. */
function edges(old: readonly string[], next: readonly string[]): { prefix: number; suffix: number } {
  const shortest = Math.min(old.length, next.length);
  let prefix = 0;
  while (prefix < shortest && old[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    old[old.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return { prefix, suffix };
}

/**
 * The changed span, or `null` when nothing changed. An empty side decides the kind: text that
 * only arrived is an insertion, text that only left is a deletion, both is a replacement.
 */
export function passSpanOf(before: string, after: string): PassSpan | null {
  const old = graphemes(before);
  const next = graphemes(after);
  const { prefix, suffix } = edges(old, next);
  const removed = old.slice(prefix, old.length - suffix).join('');
  const added = next.slice(prefix, next.length - suffix).join('');
  if (removed === '' && added === '') return null;
  const kind: PassKind = removed === '' ? 'insertion' : added === '' ? 'deletion' : 'replacement';
  return { before: removed, after: added, kind, offset: prefix };
}

/**
 * The final block cut around the span. `null` when the span cannot describe this text — a caller
 * that patched something else — so the renderer can settle instead of painting a guess.
 */
export function passRunOf(text: string, span: PassSpan): PassRun | null {
  const whole = graphemes(text);
  const start = span.offset;
  const end = start + graphemes(span.after).length;
  if (!Number.isInteger(start) || start < 0 || end > whole.length) return null;
  const run = whole.slice(start, end).join('');
  // The run the caller hands us must be the text's own run, grapheme for grapheme.
  if (run !== span.after) return null;
  return { prefix: whole.slice(0, start).join(''), run, suffix: whole.slice(end).join('') };
}
