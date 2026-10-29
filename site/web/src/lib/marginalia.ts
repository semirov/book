import {
  ATTEMPT_LINE, DEFAULT_FRAME_MODE, DROPPED_LINES, FAILED_ATTEMPT_LINE, FILING_LINES,
  NOTE_SAVED_LINE, PREMISE_LINES, RETRO_MODES, STATE_LINES, STATE_WORDS,
  framePaperworkReason, isOutcomeLine, landedSentence, landedTail, outcomeLine,
  outcomeOfFiling, outcomeTail, parseOutcomeLine, premiseLandedLine, registrationLine,
  type ChangeSummaryDto, type CommentDto, type Outcome, type RetroMode, type State,
} from '@book/shared';

/**
 * BOOK-90 / BOOK-218 — marginalia: one vocabulary for the marks in the margin.
 *
 * The words a reader sees about their own edit are spelled in `@book/shared`'s `stateWords.ts`
 * and nowhere else; this module is the surfaces' import path for them. The states are «ждёт»,
 * «идёт», «принято», «главу пишут», «внесено», «рассмотрено», «проверяется», «не принято»,
 * «снято» and «скрыто» — one per row, and the second line (`consequence`) carries the fact the
 * word cannot. «Рассмотрено» is never printed for a filing applied to text, and «внесено» never for
 * one that was not. BOOK-218: two sinks keep one word each — a landing says «внесено», a refusal
 * «не принято», and the sentence on the line is what tells the four locks apart.
 *
 * A legacy `escalated` row prints no word of its own (BOOK-206): there is no author's door left
 * to wait at, so it reads as any undecided row does — «ждёт» — and the boot migration re-opens it.
 *
 * The word alone does not carry the facts: a superseded anchor, a held check and an expired pass
 * are each their own state, and the second line (`consequence`) says which one — the deck is
 * vocabulary.
 *
 * The code's comment status `accepted` is a place in the writer's work: «главу пишут» while the
 * linked change is `processing`, «принято» while the chapter's turn has not come. Only `applied`
 * is «внесено»; only `registered` is «рассмотрено»; only `rejected` is «не принято».
 *
 * Every terminal word is the **server's** (`server/src/comments/states.ts` derives a filing's
 * status and its sentence once, in one place): this module reads `status`, `reason` and `applied`,
 * and re-derives no terminal word of its own — a change in the server's derivation drives the
 * page, instead of disagreeing with a second copy of the rule. `changeStatus` is read only where
 * the DTO itself names it: the live words `pending`/`processing` (BOOK-189).
 */

/** BOOK-218 — the reader's words, re-exported from `@book/shared` (one copy, no drift). */
export {
  AGE_WORDS, DROPPED_LINES, FAILED_ATTEMPT_LINE, FILING_LINES, HEAD_WORDS, LOCK_LINES, NOTE_SAVED_LINE,
  OWN_WAITING_LINE, PREMISE_LINES, STATE_LINES, STATE_WORDS,
  WAITING_FOR_CHAPTER_LINE, chapterLine, draftingLine, droppedLine, landedSentence, landedTail,
  lockTail, ordinalWord, queueLine, registrationLine, turnLine, waitingLine,
} from '@book/shared';
export type { State } from '@book/shared';

/** The deck's one line for a premise that waits for the chapter's first pass (one source). */
export const PREMISE_PENDING = PREMISE_LINES.pendingSentence;

/**
 * BOOK-61 — the **gate's** word, one per refusal. A gate's word heads the line of a refused
 * filing: the state says where the row stands in the book, and these say which gate stopped it.
 * «Не принято» (a lock) and «не дошло» (our failure) are the two verdicts a decided row can
 * carry, and «проверяется» (a hold before a read) is not a verdict — the reader must be able to
 * tell them apart, and an operator reads `held_rule`/`rights_rule`/`audit_verdict` instead.
 *
 * BOOK-189: the auditor's word is also the deck's refusal state (`STATE_WORDS.refused`) — a
 * refusal is decided, so it is a state of its own and this word heads it. B's «не принято» and
 * A's «проверяется» are not states: they qualify a row that still waits for a person.
 */
export type GateWord = 'held' | 'rights' | 'auditor';

export const GATE_WORDS: Readonly<Record<GateWord, string>> = {
  held: STATE_WORDS.held,
  // BOOK-218: two sinks, one word each. A refusal says `не принято` whichever door it came
  // through; what separates them is the sentence on the line, never a second word.
  rights: STATE_WORDS.refused,
  auditor: STATE_WORDS.refused,
};

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
  /** BOOK-174 — how the filing was read; `inadmissible` is the lock that refused it. */
  disposition?: CommentDto['disposition'];
  carrierKind?: CommentDto['carrierKind'];
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

/**
 * A landing's word-free receipt — `в главу 1. это третья редакция` (BOOK-218 line 10) — for a
 * surface that prints `внесено` above it; null when no receipt was recorded.
 */
export function landedReceiptLine(applied: CommentDto['applied'] | undefined): string | null {
  if (applied === null || applied === undefined) return null;
  return landedTail(applied.chapter, applied.rev);
}

/** Was the edit accepted into the text? A receipt on the row is that fact. */
function written(comment: FilingFacts): boolean {
  return comment.status === 'applied' || hasReceipt(comment);
}

/**
 * The one outcome this row names (BOOK-218): a stored lock or failure decides the sentence, and
 * a reading appears only for a written edit. `null` when the row is still on its way.
 */
export function outcomeOf(comment: FilingFacts): Outcome | null {
  return outcomeOfFiling({
    written: written(comment),
    reason: comment.reason ?? null,
    disposition: comment.disposition ?? null,
    carrierKind: comment.carrierKind ?? null,
  });
}

/**
 * One filing's whole sentence — the word and the fact it cannot carry, joined the way a single
 * row reads it. Every branch reads the deck above; none spells a word of its own.
 */
export function filingSentence(comment: FilingFacts): string {
  // A failed attempt on a row that still waits is the attempt's own sentence, and only that.
  if (failedAttempt(comment) && STILL_WAITING.has(comment.status)) return ATTEMPT_LINE;
  // 11 — an outcome carries its own verdict word, so it stands alone: one line, never two.
  const outcome = outcomeOf(comment);
  if (outcome !== null && outcome.kind !== 'reading') return outcomeLine(outcome);
  // A gate's own sentence has the same form (`не принято: …`) and is printed whole, as stored.
  const stored = (comment.reason ?? '').trim();
  if (comment.status === 'rejected' && isOutcomeLine(stored)) return stored;
  if (filingState(comment) === 'landed' && comment.premise !== true) {
    // A note moved no text (BOOK-190): never «внесено · в главу N».
    if (isNote(comment)) return NOTE_SAVED_LINE;
    // Line 10 — the whole sentence, the sink word in front of its own fact.
    if (comment.applied !== null && comment.applied !== undefined) {
      return landedSentence(comment.applied.chapter, comment.applied.rev);
    }
    return STATE_WORDS.landed;
  }
  // A premise says it once, in its own words (`принято в основу · до первой редакции`).
  if (comment.premise === true && comment.status === 'accepted') return PREMISE_LINES.pendingSentence;
  // A legacy value the boot migration re-opens: the author decides, and the row says so.
  if (comment.status === 'escalated') return FILING_LINES.authorWaits;
  // A paperwork row whose attempt came back empty keeps its own word and no line.
  if (comment.status === 'registered' && comment.attempt === 'failed') return STATE_WORDS.registered;
  const { word, consequence } = filingMarginalia(comment);
  if (consequence.length === 0 || consequence === word) return word;
  return `${word} · ${consequence}`;
}

/** The states a failed attempt is printed over: a landed or refused row keeps its own sentence. */
const STILL_WAITING: ReadonlySet<CommentDto['status']> = new Set<CommentDto['status']>([
  'new',
  'batched',
  'delivered',
  'accepted',
]);

/** The state family of a filing, before any of the words are chosen. */
export function filingState(comment: FilingFacts): State {
  // BOOK-7: a premise is the chapter's starting point; it never enters the writer's lane. It is
  // accepted into the basis until the chapter's first edition takes it (BOOK-218).
  if (comment.premise === true) {
    switch (comment.status) {
      case 'applied':
        return 'landed';
      case 'superseded':
      case 'expired':
        return 'dropped';
      case 'rejected':
        return 'refused';
      case 'hidden':
        return 'hidden';
      default:
        return 'accepted';
    }
  }
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
    // BOOK-218 — our failure is its own word: the filing was never judged, and «не принято»
    // would be a verdict nobody made.
    case 'rejected':
      return parseOutcomeLine(comment.reason)?.kind === 'failure' ? 'undelivered' : 'refused';
    // BOOK-218: the text moved under the filing, or the attempt never landed — both are «снято».
    case 'superseded':
    case 'expired':
      return 'dropped';
    case 'hidden':
      return 'hidden';
    // A hold keeps a person's word, not a wait: «проверяется», with «ждёт человека» under it.
    case 'quarantined':
      return 'held';
    case 'batched':
    case 'delivered':
      return 'reading';
    case 'accepted':
      // A receipt on the row is the server's landing fact: the text is in a chapter already.
      if (hasReceipt(comment)) return 'landed';
      // The row's own word is «принято»; only the linked change says whether the writer is at
      // this filing now (`processing` → «пишется») or the chapter's turn has not come yet.
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

/** A premise's own line: it enters the chapter's first edition, or it is dropped with why. */
function premiseConsequence(comment: FilingFacts): string {
  switch (comment.status) {
    case 'applied':
      return premiseLandedLine(chapterOf(comment));
    case 'superseded':
      return PREMISE_LINES.superseded;
    case 'rejected':
      return PREMISE_LINES.refused;
    case 'hidden':
      return STATE_LINES.hidden;
    default:
      return PREMISE_LINES.pending;
  }
}

/**
 * BOOK-218 — the second line for a filing: the fact the single word cannot carry. Every branch
 * reads the deck (`STATE_LINES`, `DROPPED_LINES`, `PREMISE_LINES`) — no surface spells its own.
 */
export function filingConsequence(comment: FilingFacts): string {
  // A failed attempt is not a state and not a refusal — the filing keeps its word and waits,
  // and only a landed one has a receipt that says more.
  if (failedAttempt(comment)) return FAILED_ATTEMPT_LINE;
  if (comment.premise === true) return premiseConsequence(comment);
  switch (comment.status) {
    // BOOK-137 — a filing on the frame became a document: the mode it was filed as, and the
    // one fact a reader needs — their sentence is still the book's sentence.
    case 'registered':
      return registrationLine(registrationMode(comment));
    case 'batched':
    case 'delivered':
      return STATE_LINES.reading;
    case 'accepted': {
      // BOOK-218: the chapter's turn while the writer has not taken it, and the chapter it is
      // writing now — never a queue place, and never «пишется» before the machine is there.
      //
      // B1 — a scheduled retry is the frame's own sentence: the row keeps its lane's word and
      // repeats what the server said, and it never claims a queue place for an attempt that failed.
      if (comment.retryAt !== null && comment.retryAt !== undefined) return comment.reason ?? '';
      // A receipt owes the same word-free line an `applied` row prints; no receipt, no line.
      const receipt = landedReceiptLine(comment.applied);
      if (receipt !== null) return receipt;
      // BOOK-218 line 7 — the chapter is being drafted, and the word *is* the sentence; the start
      // moment lives on the change, which this row's DTO does not carry, so no line is added.
      return comment.changeStatus === 'processing' ? '' : STATE_LINES.accepted;
    }
    case 'applied': {
      // A note moved no text and transferred no right: its terminal stays «замечание сохранено».
      if (isNote(comment)) return NOTE_SAVED_LINE;
      // BOOK-189 — one word-free receipt; a row stored before it has none, and none is invented.
      return landedReceiptLine(comment.applied) ?? '';
    }
    case 'escalated':
      // BOOK-206: nothing landed and nobody is owed it any more — a legacy row claims no fact.
      return '';
    case 'superseded':
      return DROPPED_LINES.superseded;
    case 'expired':
      return DROPPED_LINES.expired;
    case 'hidden':
      return STATE_LINES.hidden;
    case 'rejected': {
      // BOOK-218: one outcome, one line. A lock or our failure is the stored sentence; the word
      // above takes its tail, never a second verdict.
      const outcome = outcomeOf(comment);
      if (outcome !== null && outcome.kind !== 'reading') return outcomeTail(outcome);
      const stored = (comment.reason ?? '').trim();
      if (isOutcomeLine(stored)) return stored.slice(stored.indexOf(': ') + 2);
      // BOOK-61: the state word is the gate's own, so the line carries the reason alone —
      // `refusalDetail` strips B's word from its stored sentence, never printing it twice.
      return refusalDetail(comment) ?? refusalWord(comment);
    }
    case 'quarantined':
      // A hold's line, never the guard's taxonomy: the rule an operator reads is `held_rule`.
      return STATE_LINES.held;
    default:
      return STATE_LINES.waiting;
  }
}

/** One filing's whole marginalia: the word and the line that keeps it honest. */
export function filingMarginalia(comment: FilingFacts): Marginalia {
  const state = filingState(comment);
  // BOOK-218 — one word per sink: «не принято» for a lock, «не дошло» for our failure. The
  // state already is the verdict, so no gate word is chosen a second time.
  const word = STATE_WORDS[state];
  return { state, word, consequence: filingConsequence(comment) };
}

/** The state family of a change: it is «идёт» while it is in the machine's hands. */
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
      return 'reading';
    default:
      return 'waiting';
  }
}

/** The word a change's stamp prints. */
export function changeWord(change: ChangeFacts): string {
  return STATE_WORDS[changeState(change)];
}

/**
 * BOOK-90 — the place arithmetic moved to `anchor.ts` when the deck grew past the file bound;
 * the deck's own consumers (a mark's sentence, «стало», the record's door) keep this one import.
 */
export { revisionOf, sentenceAt } from './anchor.ts';
export type { Revision, RevisionStatus } from './anchor.ts';
