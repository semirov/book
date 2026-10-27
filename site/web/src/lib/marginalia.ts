import type { ChangeSummaryDto, CommentDto } from '@book/shared';

import { RECEIPT_RIGHTS, receiptLine } from './terms.ts';
import { clampQuote, splitSentences } from './seam.ts';

/**
 * BOOK-90 — marginalia: one vocabulary for the marks in the margin.
 *
 * The book has **three** state words and no fourth: «ждёт» (alive, waiting), «идёт» (alive,
 * in the machinery) and «внесено» (landed). Every surface that prints a state — the margin
 * note, the phone strip, the filing panel, the thread, the change card's stamp — reads them
 * here, so the same row cannot be «в процессе» in one place and «идёт» in another.
 *
 * The word alone does not carry the facts: a refusal, a superseded anchor, a held check and
 * an expired pass are all «ждёт», and the second line (`consequence`) says which one it is.
 * That is the owner's rule — waiting is not history — and it is why the deck below is part of
 * the vocabulary and not of a component.
 *
 * The code's comment status `accepted` («принято, правка в очереди») is a change now: it is
 * `идёт`, not `внесено`. Only `applied` is `внесено`.
 */

export type State = 'waiting' | 'working' | 'landed';

/** The deck's one line for a premise that waits for the chapter's first pass (one source). */
export const PREMISE_PENDING = 'принято в основу, до первой редакции';

/** The three words. Nothing else may print a state (BOOK-90, Part II). */
export const STATE_WORDS: Readonly<Record<State, string>> = {
  waiting: 'ждёт',
  working: 'идёт',
  landed: 'внесено',
};

export type Marginalia = {
  state: State;
  /** The state word, lowercase: the label register uppercases it in CSS. */
  word: string;
  /** The deck's second line: what happens next, or what befell the filing (≤46 chars). */
  consequence: string;
};

type FilingFacts = Pick<CommentDto, 'status'> & {
  premise?: boolean;
  interventionKind?: CommentDto['interventionKind'];
  applied?: CommentDto['applied'];
  chapter?: number;
};

type ChangeFacts = Pick<ChangeSummaryDto, 'status' | 'outcome'> & { premise?: boolean };

/** A note (no kind, no proposed text) never lands text: its terminal is «сохранено». */
function isNote(comment: FilingFacts): boolean {
  return comment.interventionKind === null || comment.interventionKind === undefined;
}

/** The chapter a filing was entered into, for the receipt and the premise line. */
function chapterOf(comment: FilingFacts): number {
  return comment.applied?.chapter ?? comment.chapter ?? 0;
}

/** The state family of a filing, before any of the words are chosen. */
export function filingState(comment: FilingFacts): State {
  // BOOK-7: a premise is the chapter's starting point; it never enters the lane.
  if (comment.premise === true) return comment.status === 'applied' ? 'landed' : 'waiting';
  switch (comment.status) {
    case 'applied':
      return 'landed';
    case 'batched':
    case 'delivered':
    case 'accepted':
      return 'working';
    default:
      return 'waiting';
  }
}

/** The deck's second line for a filing: the fact the single word cannot carry. */
export function filingConsequence(comment: FilingFacts): string {
  if (comment.premise === true) {
    switch (comment.status) {
      case 'applied':
        return `вошло в первую редакцию главы ${chapterOf(comment)}`;
      case 'superseded':
        return 'снято: у главы уже есть замысел';
      case 'rejected':
        return 'замысел не взят';
      default:
        return PREMISE_PENDING;
    }
  }
  switch (comment.status) {
    case 'batched':
    case 'delivered':
      return 'читает триаж';
    case 'accepted':
      return isNote(comment) ? 'замечание в очереди' : 'правка в очереди на запись';
    case 'applied': {
      if (isNote(comment)) return 'замечание сохранено';
      const applied = comment.applied;
      return applied === null || applied === undefined
        ? RECEIPT_RIGHTS
        : receiptLine(String(applied.chapter).padStart(2, '0'));
    }
    case 'superseded':
      return 'снято: текст успел измениться';
    case 'rejected':
      return 'отклонено';
    case 'quarantined':
      return 'проверяется перед триажем';
    case 'expired':
      return 'проход не состоялся';
    case 'hidden':
      return 'скрыто';
    default:
      return 'попадёт в триаж';
  }
}

/** One filing's whole marginalia: the word and the line that keeps it honest. */
export function filingMarginalia(comment: FilingFacts): Marginalia {
  const state = filingState(comment);
  return { state, word: STATE_WORDS[state], consequence: filingConsequence(comment) };
}

/** The state family of a change. `pending` is a queue place, i.e. in the machinery: `идёт`. */
export function changeState(change: ChangeFacts): State {
  if (change.premise === true) return change.status === 'done' ? 'landed' : 'waiting';
  switch (change.status) {
    case 'done':
      return 'landed';
    case 'pending':
    case 'processing':
      return 'working';
    default:
      return 'waiting';
  }
}

/** The word a change's stamp prints. */
export function changeWord(change: ChangeFacts): string {
  return STATE_WORDS[changeState(change)];
}

/** `07` — the two-digit chapter the receipt names. */
export function landingReceipt(chapter: number, rev: number | null = null): string {
  const receipt = receiptLine(String(chapter).padStart(2, '0'));
  return rev === null ? receipt : `${receipt} · ревизия ${rev}`;
}

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

/** The longest suffix of `want` that `text` ends with, 0 when it is too short. */
function tailMatch(text: string, want: string): number {
  for (let size = Math.min(want.length, CONTEXT); size >= MIN_CONTEXT; size -= 1) {
    if (text.endsWith(want.slice(-size))) return size;
  }
  return 0;
}

/** The longest prefix of `want` that `text` starts with, 0 when it is too short. */
function headMatch(text: string, want: string): number {
  for (let size = Math.min(want.length, CONTEXT); size >= MIN_CONTEXT; size -= 1) {
    if (text.startsWith(want.slice(0, size))) return size;
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
 * Where the anchored sentence starts in the current text.
 *
 * The **place**, not the wording, is the anchor: the stored quote (its first occurrence, or the
 * one whose stored prefix/suffix context matches when the wording repeats), else the tail of
 * the stored prefix, else the head of the stored suffix. `null` when neither context survives
 * — the paragraph was rewritten under the filing and no sentence may be claimed for it.
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
      for (const at of offsets) {
        const before = text.slice(Math.max(0, at - CONTEXT), at);
        const after = text.slice(at + quote.length, at + quote.length + CONTEXT);
        const score = tailMatch(before, prefix) + headMatch(after, suffix);
        if (best === null || score > best.score) best = { at, score };
      }
      // A repeated wording with no context to tell the occurrences apart is ambiguous.
      if (best !== null && best.score > 0) return best.at;
    }
  }
  if (prefix.length > 0) {
    for (let size = Math.min(prefix.length, CONTEXT); size >= MIN_CONTEXT; size -= 1) {
      const at = text.indexOf(prefix.slice(-size));
      if (at >= 0) return at + size;
    }
  }
  if (suffix.length > 0) {
    for (let size = Math.min(suffix.length, CONTEXT); size >= MIN_CONTEXT; size -= 1) {
      const at = text.indexOf(suffix.slice(0, size));
      if (at >= 0) return Math.max(0, at - 1);
    }
  }
  return null;
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
