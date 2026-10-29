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

/**
 * BOOK-90 — marginalia: one vocabulary for the marks in the margin.
 *
 * The book has **seven** state words and no eighth: «ждёт» (alive, waiting), «идёт» (alive, in
 * the machinery), «пишется» (the writer is at this filing), «принято» (in the writer's lane,
 * not reached yet), «внесено» (landed), «рассмотрено» (BOOK-137: paperwork — the letters did
 * not change) and «отклонено» (BOOK-189: refused). Every surface that prints a state — the
 * margin note, the phone strip, the filing panel, the thread, the change card's stamp — reads
 * them here, so one row cannot say «в процессе» where another says «идёт».
 *
 * «Рассмотрено» is never printed for a filing applied to text, and «внесено» never for one that
 * was not. A refusal is a state of its own — it never waits, never reads as a queue place. There
 * is no author's door any more (BOOK-206): every filing is placed by the ladder, and a legacy
 * `escalated` row — which the boot migration re-opens — reads as any undecided row does.
 *
 * The word alone does not carry the facts: a superseded anchor, a held check and an expired pass
 * are all «ждёт», and the second line (`consequence`) says which one — the deck is vocabulary.
 *
 * The code's comment status `accepted` is a place in the writer's work, said in its own two
 * words: «пишется» while the linked change is `processing`, «принято» while the lane has not
 * reached it. Only `applied` is «внесено»; only `registered` is «рассмотрено»; only `rejected`
 * is «отклонено».
 *
 * Every terminal word is the **server's** (`server/src/comments/states.ts` derives a filing's
 * status and its sentence once, in one place): this module reads `status`, `reason` and `applied`,
 * and re-derives no terminal word of its own — a change in the server's derivation drives the
 * page, instead of disagreeing with a second copy of the rule. `changeStatus` is read only where
 * the DTO itself names it: the live words `pending`/`processing` (BOOK-189).
 */

export type State =
  'waiting' | 'working' | 'writing' | 'accepted' | 'landed' | 'registered' | 'refused';

/** The deck's one line for a premise that waits for the chapter's first pass (one source). */
export const PREMISE_PENDING = 'принято в основу, до первой редакции';

/** The state words. Nothing else may print a state (BOOK-90, Part II; BOOK-137, BOOK-189). */
export const STATE_WORDS: Readonly<Record<State, string>> = {
  waiting: 'ждёт',
  working: 'идёт',
  // `accepted` is the writer's lane: «пишется» while the change is `processing`, «принято» else.
  writing: 'пишется',
  accepted: 'принято',
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

export type FilingFacts = Pick<CommentDto, 'status'> & {
  premise?: boolean;
  interventionKind?: CommentDto['interventionKind'];
  applied?: CommentDto['applied'];
  chapter?: number;
  /**
   * BOOK-189 — the linked change's own place: the writer has the filing in hand (`processing`)
   * or the lane holds it (`pending`) — the two values the DTO names (a terminal change reaches
   * the page as `status` and `reason`, never as this field). It is the only fact that separates
   * «пишется» from «принято» on an `accepted` row: the row's word alone cannot say whether the
   * writer is there yet.
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
  /**
   * BOOK-206 audit B1 — the `attempt.retryAt` a `comment:decision` frame carries: the change's
   * next attempt is scheduled. It is a fact, never a word and never a second clock: the line is
   * the frame's own `reason` (a sentence the server wrote), and no time is formatted here.
   */
  retryAt?: string | null;
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

/**
 * BOOK-219 — a landing's receipt on the row itself (`applied: { chapter, rev }`). It is the
 * server's own landing fact: a row that carries one has its text in a chapter, whatever word the
 * row's status still says before the durable read replaces it.
 */
function hasReceipt(comment: FilingFacts): boolean {
  return comment.applied !== null && comment.applied !== undefined;
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
      // A receipt on the row is the server's landing fact: the text is in a chapter already.
      if (hasReceipt(comment)) return 'landed';
      // The row's own state is the writer's lane: the linked change says whether the writer is
      // at this filing now (`processing` → «пишется») or the lane has not reached it («принято»).
      // A failed attempt carries no `changeStatus` and stays «принято», with the deck's sentence.
      return comment.changeStatus === 'processing' ? 'writing' : 'accepted';
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
    case 'accepted': {
      // BOOK-189: one line for each side of the writer's work. «пишется» is the word above — the
      // writer is at this filing — and «впишется, когда машина возьмёт главу» is the lane holding
      // it. An `accepted` row carries no queue word at all — the queue is counted by the writer,
      // never by a comment status.
      //
      // B1 — a scheduled retry is the frame's own sentence: the row keeps its lane's word and
      // repeats what the server said, and it never claims a queue place for an attempt that failed.
      if (comment.retryAt !== null && comment.retryAt !== undefined) return comment.reason ?? '';
      // A receipt owes the same word-free line an `applied` row prints; no receipt, no line.
      const receipt = landedReceiptLine(comment.applied);
      if (receipt !== null) return receipt;
      return comment.changeStatus === 'processing' ? '' : 'впишется, когда машина возьмёт главу';
    }
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
      // A stored legacy value: the server's own sentence, or none — nothing is written here.
      return comment.reason ?? '';
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

/**
 * BOOK-90 — the place arithmetic moved to `anchor.ts` when the deck grew past the file bound;
 * the deck's own consumers (a mark's sentence, «стало», the record's door) keep this one import.
 */
export { revisionOf, sentenceAt } from './anchor.ts';
export type { Revision, RevisionStatus } from './anchor.ts';
