import {
  DEFAULT_FRAME_MODE,
  FAILED_ATTEMPT_LINE,
  framePaperworkReason,
  RETRO_MODES,
  type ChangeSummaryDto,
  type CommentDto,
  type RetroMode,
} from '@book/shared';

import { receiptLine } from './terms.ts';
import { clampQuote, splitSentences } from './seam.ts';

/**
 * BOOK-90 — marginalia: one vocabulary for the marks in the margin.
 *
 * The book has **six** state words and no seventh: «ждёт» (alive, waiting), «идёт» (alive, in
 * the machinery), «внесено» (landed in the text), «рассмотрено» (BOOK-137: decided as
 * **paperwork** — the record exists, the sentence's letters did not change), «ждёт решения
 * автора» (BOOK-174: the ladder could not place it and the author decides) and «отклонено»
 * (BOOK-189: the filing was refused, and nothing is coming). Every surface that prints a
 * state — the margin note, the phone strip, the filing panel, the thread, the change card's
 * stamp — reads them here, so the same row cannot be «в процессе» in one place and «идёт» in
 * another.
 *
 * «Рассмотрено» is never printed for a filing applied to text, and «внесено» never for one that
 * was not. A refusal is a state of its own — it never waits, never reads as a queue place. There
 * is no author's door any more (BOOK-206): every filing is placed by the ladder, and a legacy
 * `escalated` row — which the boot migration re-opens — reads as any undecided row does.
 *
 * The word alone does not carry the facts: a superseded anchor, a held check and an expired pass
 * are all «ждёт», and the second line (`consequence`) says which one — the deck is vocabulary.
 *
 * The code's comment status `accepted` («принято, правка в очереди») is a place in the writer's
 * work, not a state of its own: it is `идёт` only while the linked change is `processing`, and
 * `ждёт` while the lane has not reached it (BOOK-189). Only `applied` is «внесено»; only
 * `registered` is «рассмотрено»; only `rejected` is «отклонено».
 */

export type State = 'waiting' | 'working' | 'landed' | 'registered' | 'refused';

/** The deck's one line for a premise that waits for the chapter's first pass (one source). */
export const PREMISE_PENDING = 'принято в основу, до первой редакции';

/** The state words. Nothing else may print a state (BOOK-90, Part II; BOOK-137, BOOK-189). */
export const STATE_WORDS: Readonly<Record<State, string>> = {
  waiting: 'ждёт',
  working: 'идёт',
  landed: 'внесено',
  registered: 'рассмотрено',
  // BOOK-189 — a refusal is its own state; `filingMarginalia` heads it with the gate's word.
  refused: 'отклонено',
};

/**
 * BOOK-61 — the **gate's** word, one per refusal. A gate's word heads the line of a refused
 * filing: the state says where the row stands in the book's machinery, and these say which gate
 * stopped it. «Не принято» (B, the law) is never «отклонено» (C, the auditor) and neither is
 * «проверяется» (A, a hold before a model read it) — the reader must be able to tell the three
 * apart, and an operator reads `held_rule`/`rights_rule`/`audit_verdict` instead.
 *
 * BOOK-189: the auditor's word is also the deck's refusal state (`STATE_WORDS.refused`) — a
 * refusal is decided, so it is a state of its own and this word heads it. B's «не принято» and
 * A's «проверяется» are not states: they qualify a row that still waits for a person.
 */
export type GateWord = 'held' | 'rights' | 'auditor';

export const GATE_WORDS: Readonly<Record<GateWord, string>> = {
  held: 'проверяется',
  rights: 'не принято',
  auditor: 'отклонено',
};

/** HELD's own line: a hold is not history and no change is made from it (BOOK-DOC-42 §5). */
export const HELD_LINE = 'замечание сохранено и ждёт человека — из него пока не делают правку';

/**
 * BOOK-137 — the paperwork's second line: the mode it was filed as, and the one fact that matters
 * — the sentence did not change. One source for the filing and the change alike.
 */
export function registrationLine(mode: RetroMode = DEFAULT_FRAME_MODE): string {
  return `${mode} · фраза не изменилась`;
}

export type Marginalia = {
  state: State;
  /** The state word, lowercase: the label register uppercases it in CSS. */
  word: string;
  /** The deck's second line: what happens next, or what befell the filing (≤46 chars); `''` = none. */
  consequence: string;
};

type FilingFacts = Pick<CommentDto, 'status'> & {
  premise?: boolean;
  interventionKind?: CommentDto['interventionKind'];
  applied?: CommentDto['applied'];
  chapter?: number;
  /**
   * BOOK-189 — the linked change's own place: the writer has the filing in hand (`processing`)
   * or the lane holds it (`pending`). `null`/absent for a filing that landed, was refused, or
   * that no change ever held. It is the only fact that separates «идёт» from «ждёт» on an
   * `accepted` row: the row's word alone cannot say whether the writer is there yet.
   */
  changeStatus?: CommentDto['changeStatus'];
  /** BOOK-61 — which gate refused it; the reader's line is chosen from this, not from `reason`. */
  refusal?: CommentDto['refusal'];
  /**
   * The stored public line: joined under the gate's word where the gate owes one (BOOK-61), and
   * it carries the paperwork mode of a `registered` row (BOOK-137).
   */
  reason?: string | null;
  /** The linked change's attempt failed; the filing itself keeps its state. */
  attempt?: 'failed' | null;
  /** BOOK-137 — the mode when the caller has it (a change's summary), never guessed. */
  frameMode?: RetroMode | null;
};

type ChangeFacts = Pick<ChangeSummaryDto, 'status' | 'outcome'> & {
  premise?: boolean;
  /** A premise whose chapter has text: it entered the first edition. */
  premiseLanded?: boolean;
  /** BOOK-137 — the paperwork mode of a `registered` change. */
  frameMode?: RetroMode | null;
};

/** A note (no kind, no proposed text) never lands text: its terminal is «сохранено». */
function isNote(comment: FilingFacts): boolean {
  return comment.interventionKind === null || comment.interventionKind === undefined;
}

/** The chapter a filing was entered into, for the receipt and the premise line. */
function chapterOf(comment: FilingFacts): number {
  return comment.applied?.chapter ?? comment.chapter ?? 0;
}

/**
 * The mode a `registered` comment was filed as: the row carries the server's public one-liner
 * (`CommentDto.reason`) and no mode of its own, so it is read back through the one function that
 * writes that line, never through a second template.
 */
function registrationMode(comment: FilingFacts): RetroMode {
  if (comment.frameMode !== undefined && comment.frameMode !== null) return comment.frameMode;
  const reason = comment.reason ?? '';
  return RETRO_MODES.find((mode) => framePaperworkReason(mode) === reason) ?? DEFAULT_FRAME_MODE;
}

/** The gate's own word for a refusal: B's law, C's auditor — never a fourth gate invented here. */
function refusalWord(comment: FilingFacts): string {
  return comment.refusal === 'rights' ? GATE_WORDS.rights : GATE_WORDS.auditor;
}

/** A refusal's detail without its own gate word: strip one «не принято: » prefix. */
export function refusalDetail(comment: FilingFacts): string | null {
  const reason = comment.reason ?? null;
  if (reason === null || reason.length === 0) return null;
  const prefix = `${GATE_WORDS.rights}: `;
  // A bare word is the row's own again, and a sentence that carries the word in front of it is
  // the word plus its rule sentence: both are handled, anything else is printed as stored.
  if (comment.refusal !== 'rights') return reason;
  if (reason === GATE_WORDS.rights) return null;
  return reason.startsWith(prefix) ? reason.slice(prefix.length) || null : reason;
}

/** A landing's word-free receipt «глава N · ревизия R»; null when none was recorded. */
export function landedReceiptLine(applied: CommentDto['applied'] | undefined): string | null {
  if (applied === null || applied === undefined) return null;
  return `глава ${applied.chapter} · ревизия ${applied.rev}`;
}

/** The state family of a filing, before any of the words are chosen. */
export function filingState(comment: FilingFacts): State {
  // BOOK-7: a premise is the chapter's starting point; it never enters the lane.
  if (comment.premise === true) return comment.status === 'applied' ? 'landed' : 'waiting';
  switch (comment.status) {
    case 'applied':
      return 'landed';
    // BOOK-137: accepted as paperwork — nothing was written, and it is decided, so not «ждёт».
    case 'registered':
      return 'registered';
    // BOOK-206: a legacy `escalated` row (before the boot migration re-opens it) is neither
    // landed nor refused — it waits like any undecided filing, and no author's word is printed.
    case 'escalated':
      return 'waiting';
    // BOOK-189: a refusal is a decision, not a queue place. It never reads as waiting.
    case 'rejected':
      return 'refused';
    case 'batched':
    case 'delivered':
      return 'working';
    case 'accepted':
      // The row's own word stops at triage: only the linked change says whether the writer is
      // at this filing now (`processing` → «идёт») or the lane has not reached it («ждёт»).
      // A failed attempt carries no `changeStatus` and waits with the deck's sentence.
      return comment.changeStatus === 'processing' ? 'working' : 'waiting';
    default:
      return 'waiting';
  }
}

/**
 * Filing states that decided themselves: the row's own word is the last one, and a refusal is
 * never retold as an attempt that came back empty. The same set the server keeps (`states.ts`).
 */
const OWN_DECISION: ReadonlySet<CommentDto['status']> = new Set<CommentDto['status']>([
  'rejected',
  'quarantined',
  'superseded',
  'hidden',
]);

/**
 * BOOK-136 — an attempt that came back empty, on a filing that did **not** decide itself: it is
 * not a state and not a refusal, so a refusal and a landing keep their own line, and the attempt
 * behind them is never the reader's answer (the line, the row's note, the card's fact).
 */
export function failedAttempt(comment: FilingFacts): boolean {
  return (
    comment.attempt === 'failed' &&
    comment.status !== 'applied' &&
    !OWN_DECISION.has(comment.status)
  );
}

/** The deck's second line for a filing: the fact the single word cannot carry. */
export function filingConsequence(comment: FilingFacts): string {
  // A failed attempt is not a state and not a refusal — the filing keeps its word
  // and waits, and only a landed one has a receipt that says more.
  if (failedAttempt(comment)) return FAILED_ATTEMPT_LINE;
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
    // BOOK-137 — a filing on the frame became a document: the mode it was filed as, and the
    // one fact a reader needs — their sentence is still the book's sentence.
    case 'registered':
      return registrationLine(registrationMode(comment));
    case 'batched':
    case 'delivered':
      return 'читает триаж';
    case 'accepted':
      // BOOK-189: one line for each side of the writer's work. «пишется» is the writer at this
      // filing; «в очереди на запись» is the lane holding it. An `accepted` row carries no queue
      // word at all — the queue is counted by the writer, never by a comment status.
      return comment.changeStatus === 'processing' ? 'пишется' : 'в очереди на запись';
    case 'applied': {
      // A note moved no text and transferred no right: its terminal stays «замечание сохранено».
      if (isNote(comment)) return 'замечание сохранено';
      // BOOK-189 — one word-free receipt; a row stored before it has none, and none is invented.
      return landedReceiptLine(comment.applied) ?? '';
    }
    case 'escalated':
      // BOOK-206: nothing landed and nobody is owed it any more — a legacy row claims no fact.
      return '';
    case 'superseded':
      return 'снято: текст успел измениться';
    case 'rejected':
      // BOOK-61: the state word is the gate's own, so the line carries the reason alone —
      // `refusalDetail` strips B's word from its stored sentence, never printing it twice.
      return refusalDetail(comment) ?? refusalWord(comment);
    case 'quarantined':
      // A hold's line, never the guard's taxonomy: the rule an operator reads is `held_rule`.
      return `${GATE_WORDS.held}: ${HELD_LINE}`;
    case 'expired':
      return 'правка не состоялась';
    case 'hidden':
      return 'скрыто';
    default:
      return 'попадёт в триаж';
  }
}

/** One filing's whole marginalia: the word and the line that keeps it honest. */
export function filingMarginalia(comment: FilingFacts): Marginalia {
  const state = filingState(comment);
  // BOOK-61, BOOK-189 — a refusal heads its line with the gate's own word: «не принято» for the
  // law, «отклонено» for the auditor. The state is `refused`, the word is the gate's.
  const word = state === 'refused' ? refusalWord(comment) : STATE_WORDS[state];
  return { state, word, consequence: filingConsequence(comment) };
}

/** The state family of a change. `pending` is a queue place, i.e. in the machinery: `идёт`. */
export function changeState(change: ChangeFacts): State {
  // A premise whose chapter has text is landed, whatever the row went on to say —
  // a failed attempt after the first edition does not un-enter a premise.
  if (change.premiseLanded === true) return 'landed';
  if (change.premise === true) return change.status === 'done' ? 'landed' : 'waiting';
  // BOOK-137 — a `registered` change is `done` and yet never text: its own state wins over the
  // status word, or the card would say «внесено» about a sentence nothing was written into.
  if (change.outcome === 'registered') return 'registered';
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
 * BOOK-90 — the revision object's two rows, resolved **by position**.
 *
 * The anchored sentence is the one at the place the stored quote/prefix/suffix points to in
 * the paragraph's current text. When the sentence found there is the same wording, nothing
 * changed at that place: no «стало» is printed. When it is different, that sentence is
 * «стало» — the applied text, never the reader's `proposedText`. When the place cannot be
 * found, the object says «текст изменился после правки» instead of inventing a sentence.
 */
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
