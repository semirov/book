import type { CommentDto } from '@book/shared';

import { clampQuote, splitSentences } from './seam.ts';

/**
 * BOOK-90 — **where** a filing's sentence stands in the paragraph's current text, and what it
 * now says. The place arithmetic lives here, apart from the deck's words (`marginalia.ts`):
 * the mark, «стало» and the record's door all resolve their position through these functions,
 * so a row can never stand on a different sentence from the record it opens.
 *
 * The **place**, not the wording, is the anchor: a landed change rewrote its own sentence, so
 * the stored quote no longer equals any sentence's text, while the stored prefix/suffix still
 * points at it. `null` when neither context survives — the paragraph was rewritten under the
 * filing and no sentence may be claimed for it.
 */

export type RevisionStatus = 'same' | 'changed' | 'unresolved';

export type Revision = {
  /** `anchor.quote`: the sentence the filing was made on. */
  before: string | null;
  /** The sentence that stands at that place now — only when it differs from `before`. */
  after: string | null;
  /** `same`: nothing changed there; `unresolved`: the place cannot be found. */
  status: RevisionStatus;
};

/** How much context the stored prefix/suffix carries (the server's own bound). */
const CONTEXT = 40;
/** The shortest context match worth trusting; below it a coincidence decides the place. */
const MIN_CONTEXT = 8;

/**
 * The longest suffix of `want` that `text` ends with, 0 when it is too short. Edge whitespace
 * is not a fact about the place (a stored prefix ends with the space the sentence starts after).
 */
function tailMatch(text: string, want: string): number {
  const left = text.trimEnd();
  const right = want.trimEnd();
  for (let size = Math.min(right.length, CONTEXT); size >= MIN_CONTEXT; size -= 1) {
    if (left.endsWith(right.slice(-size))) return size;
  }
  return 0;
}

/** The longest prefix of `want` that `text` starts with (edge whitespace ignored). */
function headMatch(text: string, want: string): number {
  const left = text.trimStart();
  const right = want.trimStart();
  for (let size = Math.min(right.length, CONTEXT); size >= MIN_CONTEXT; size -= 1) {
    if (left.startsWith(right.slice(0, size))) return size;
  }
  return 0;
}

/** Every occurrence of `quote` in `text`, in order. */
function offsetsOf(text: string, quote: string): number[] {
  const out: number[] = [];
  for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) out.push(at);
  return out;
}

/**
 * The one occurrence of `needle`, or — when the context repeats — the single occurrence whose
 * stored context (`suffix` after, `prefix` before) matches best. `null` when the occurrence is
 * ambiguous (a repeated clause is not a place) or absent.
 */
function uniqueByContext(
  text: string,
  needle: string,
  context: string,
  side: 'after' | 'before',
): number | null {
  const first = text.indexOf(needle);
  if (first < 0) return null;
  if (first === text.lastIndexOf(needle)) return first;
  let best = -1;
  let bestScore = 0;
  let tie = false;
  for (let at = first; at >= 0; at = text.indexOf(needle, at + 1)) {
    const around =
      side === 'after'
        ? text.slice(at + needle.length, at + needle.length + CONTEXT)
        : text.slice(Math.max(0, at - CONTEXT), at);
    const score = side === 'after' ? headMatch(around, context) : tailMatch(around, context);
    if (score > bestScore) {
      bestScore = score;
      best = at;
      tie = false;
    } else if (score === bestScore && score > 0) {
      tie = true;
    }
  }
  return bestScore > 0 && !tie ? best : null;
}

/**
 * Where the anchored sentence starts in the current text: the stored quote (its first
 * occurrence, or the one whose stored prefix/suffix context matches when the wording repeats),
 * else the tail of the stored prefix, else the head of the stored suffix.
 */
function anchoredAt(text: string, anchor: CommentDto['anchor']): number | null {
  const quote = anchor.quote ?? '';
  const prefix = anchor.prefix ?? '';
  const suffix = anchor.suffix ?? '';
  if (quote.length > 0) {
    const offsets = offsetsOf(text, quote);
    if (offsets.length === 1) return offsets[0] ?? null;
    if (offsets.length > 1) {
      let best: { at: number; score: number } | null = null;
      let tie = false;
      for (const at of offsets) {
        const before = text.slice(Math.max(0, at - CONTEXT), at);
        const after = text.slice(at + quote.length, at + quote.length + CONTEXT);
        const score = tailMatch(before, prefix) + headMatch(after, suffix);
        if (best === null || score > best.score) {
          best = { at, score };
          tie = false;
        } else if (score === best.score && score > 0) {
          tie = true;
        }
      }
      // A repeated wording with no context to tell the occurrences apart is ambiguous.
      if (best !== null && best.score > 0 && !tie) return best.at;
      if (prefix.length === 0 && suffix.length === 0) return null;
    }
  }
  if (prefix.length > 0) {
    for (let size = Math.min(prefix.length, CONTEXT); size >= MIN_CONTEXT; size -= 1) {
      const needle = prefix.slice(-size);
      const at = uniqueByContext(text, needle, suffix, 'after');
      if (at !== null) return at + size;
      // The context exists but repeats too often to name a place: shorter is never unique.
      if (text.includes(needle)) return null;
    }
  }
  if (suffix.length > 0) {
    for (let size = Math.min(suffix.length, CONTEXT); size >= MIN_CONTEXT; size -= 1) {
      const needle = suffix.slice(0, size);
      const at = uniqueByContext(text, needle, prefix, 'before');
      if (at !== null) return Math.max(0, at - 1);
      if (text.includes(needle)) return null;
    }
  }
  return null;
}

/**
 * BOOK-90 — the sentence the anchor's **place** points at in the current text.
 *
 * A landed change rewrites its own sentence, so the stored quote no longer equals any
 * sentence's text; the place still does. The tick and «стало» resolve through this one
 * function, so the mark can never stand on a different sentence from the record it opens.
 * Null when the anchor is unresolved or the place cannot be named.
 */
export function sentenceAt(text: string, anchor: CommentDto['anchor']): number | null {
  if (!anchor.resolved) return null;
  const at = anchoredAt(text, anchor);
  if (at === null) return null;
  const sentence = splitSentences(text).find((item) => item.start <= at && at < item.end);
  return sentence === undefined ? null : sentence.start;
}

/**
 * BOOK-90 — the revision object's two rows, resolved **by position**.
 *
 * The anchored sentence is the one at the place the stored quote/prefix/suffix points to in
 * the paragraph's current text. When the sentence found there is the same wording, nothing
 * changed at that place: no «стало» is printed. When it is different, that sentence is
 * «стало» — the applied text, never the reader's `proposedText`. When the place cannot be
 * found, the object says «текст изменился после правки» instead of inventing a sentence.
 */
export function revisionOf(comment: Pick<CommentDto, 'anchor'>, text: string): Revision {
  const before = comment.anchor.quote;
  if (before === null || before.length === 0) return { before: null, after: null, status: 'unresolved' };
  if (!comment.anchor.resolved) return { before, after: null, status: 'unresolved' };
  const at = anchoredAt(text, comment.anchor);
  if (at === null) return { before, after: null, status: 'unresolved' };
  const sentence = splitSentences(text).find((item) => item.start <= at && at < item.end);
  if (sentence === undefined) return { before, after: null, status: 'unresolved' };
  // The sentence at that place is the one we already have: the paragraph did not change there.
  if (clampQuote(sentence.text) === before) return { before, after: null, status: 'same' };
  return { before, after: sentence.text, status: 'changed' };
}
