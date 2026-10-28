import type { CommentDto, ParagraphChainDto } from '@book/shared';

import { formatDate, formatTime } from './format.ts';
import { PASS_HAND } from './provenance.ts';
import { filingNumber } from './filings.ts';
import {
  filingConsequence,
  filingState,
  GATE_WORDS,
  landedReceiptLine,
  STATE_WORDS,
} from './marginalia.ts';

/**
 * BOOK-128 comment #3863 / #3862 — the sentence's record, as data.
 *
 * The record answers six situations with **words the book already prints** (`STATE_WORDS`,
 * `GATE_WORDS`, `PASS_HAND`) and one line that carries what a word cannot. Nothing here
 * formats a row, decides a height or reads the DOM: the component prints, this module decides,
 * and every branch is a copy rule with a test beside it.
 *
 * Two honesty rules are encoded, not commented:
 *   - a section with nothing is **not a section**: `sections` is empty for an untouched
 *     sentence, and the record prints one sentence instead of a wall of zeros;
 *   - a section prints **no count of one** (BOOK-59: «1 волна» is a number that is always one).
 */

export type RecordInk = 'live' | 'ink' | 'revise' | 'quiet';

/** The six situations of the design, plus the two the shipped deck forces. */
export type RecordSituation =
  | 'writing'
  | 'waiting'
  | 'waitingOwn'
  | 'working'
  | 'held'
  | 'landed'
  | 'refused'
  | 'untouched';

export type RecordState = {
  situation: RecordSituation;
  /** The one word in the head row; `null` when the record has no state (an untouched sentence). */
  word: string | null;
  ink: RecordInk;
  /** The one line under the word, when the word cannot carry the fact. */
  line: string | null;
  /** Nobody ever touched this sentence: one line, no sections, `вмешаться` the only act. */
  empty: boolean;
};

/** The hand's word and the moment it wrote this version: `печатник · 28.10.2026, 12:08`. */
export type RecordHand = { hand: string; moment: string; line: string };

/** `2026-10-28T12:08:00Z` → `28.10.2026, 12:08`; a missing moment is «вне правок». */
export function fullMoment(iso: string | null): string {
  if (iso === null) return 'вне правок';
  const date = formatDate(iso);
  const time = formatTime(iso);
  if (date === '—' || time === '—') return 'вне правок';
  return `${date}, ${time}`;
}

/** Who wrote the last version — the hand, never «автор» on a book a pass wrote. */
export function handWord(input: {
  chain: ParagraphChainDto | null;
  frozen: 'frame' | 'basis' | null;
}): string {
  if (input.frozen === 'basis') return 'основание книги';
  if (input.frozen === 'frame') return 'рамка книги';
  const last = (Array.isArray(input.chain?.versions) ? input.chain.versions : []).at(-1) ?? null;
  if (last === null) return PASS_HAND;
  if (last.actor?.kind === 'reader') {
    if (last.changeSeq !== null) return `правка ${String(last.changeSeq).padStart(3, '0')}`;
    return last.actor.label;
  }
  if (last.actor === null && last.changeSeq === null) return 'рука не названа';
  return PASS_HAND;
}

/** The hand's own line: who, and when the version it wrote became the text. */
export function handOf(input: {
  chain: ParagraphChainDto | null;
  frozen: 'frame' | 'basis' | null;
}): RecordHand {
  const hand = handWord(input);
  const frozen = input.frozen !== null;
  const last = (Array.isArray(input.chain?.versions) ? input.chain.versions : []).at(-1) ?? null;
  const moment = frozen ? 'вне правок' : fullMoment(last?.at ?? null);
  return { hand, moment, line: `${hand} · ${moment}` };
}

/** Is this filing the reader's own? The name is the only identity the page has. */
export function isOwn(comment: CommentDto, viewerName: string | null): boolean {
  return viewerName !== null && comment.author === viewerName;
}

/**
 * The state, in the design's order of authority: the reader's own filing first (it is the one
 * they can still act on), then the newest other filing, then the log's last version, then the
 * untouched sentence.
 */
export function recordStateOf(input: {
  filings: readonly CommentDto[];
  own: (comment: CommentDto) => boolean;
  chain: ParagraphChainDto | null;
  /** A pass is writing this paragraph now: `пишется`, and no line. */
  writing: boolean;
  frozen: 'frame' | 'basis' | null;
}): RecordState {
  const { filings, chain, writing, frozen, own } = input;
  if (writing) return { situation: 'writing', word: 'пишется', ink: 'live', line: null, empty: false };

  const ownFiling = filings.find(own) ?? null;
  const filing = ownFiling ?? filings[0] ?? null;

  if (filing !== null) {
    const mine = ownFiling !== null && filing.id === ownFiling.id;
    switch (filing.status) {
      case 'new':
        return {
          situation: mine ? 'waitingOwn' : 'waiting',
          word: STATE_WORDS.waiting,
          ink: 'live',
          line: mine ? 'ваша — в очереди' : 'решения ещё нет',
          empty: false,
        };
      case 'batched':
      case 'delivered':
        return {
          situation: 'working',
          word: STATE_WORDS.working,
          ink: 'live',
          line: 'в очереди на запись',
          empty: false,
        };
      case 'accepted':
        // BOOK-189: the row's word stops at triage. Only the linked change says whether the
        // writer is at this filing now (`processing` → «идёт» · «пишется») or the lane holds it
        // («ждёт», and the reader's own line says whose it is).
        if (filing.changeStatus === 'processing') {
          return {
            situation: 'working',
            word: STATE_WORDS.working,
            ink: 'live',
            line: 'пишется',
            empty: false,
          };
        }
        return {
          situation: mine ? 'waitingOwn' : 'waiting',
          word: STATE_WORDS.waiting,
          ink: 'live',
          line: mine ? 'ваша — в очереди' : 'в очереди на запись',
          empty: false,
        };
      case 'quarantined':
        return { situation: 'held', word: STATE_WORDS.waiting, ink: 'live', line: 'ждёт человека', empty: false };
      case 'applied': {
        // BOOK-189 — the one receipt shape of every surface: «глава 7 · ревизия 4». The word
        // above is «внесено», so the line never repeats it and never carries the rights clause
        // (where the text went, not what a reader signed away — #3862 §2).
        const receipt = landedReceiptLine(filing.applied);
        if (receipt !== null) {
          return { situation: 'landed', word: STATE_WORDS.landed, ink: 'ink', line: receipt, empty: false };
        }
        const fallback = filingConsequence(filing);
        return {
          situation: 'landed',
          word: STATE_WORDS.landed,
          ink: 'ink',
          line: fallback.length === 0 ? null : fallback,
          empty: false,
        };
      }
      case 'rejected':
        // The gate's own word and the reason **whole** — a refusal is a decision, not an error.
        return {
          situation: 'refused',
          word: filing.refusal === 'rights' ? GATE_WORDS.rights : GATE_WORDS.auditor,
          ink: 'revise',
          line: `: ${filing.reason ?? filingConsequence(filing)}`,
          empty: false,
        };
      default:
        // `superseded`, `expired`, `hidden`: the deck's own word and line, printed, not re-decided.
        return {
          situation: 'refused',
          word: GATE_WORDS.auditor,
          ink: 'revise',
          line: `: ${filingConsequence(filing)}`,
          empty: false,
        };
    }
  }

  const last = (Array.isArray(chain?.versions) ? chain.versions : []).at(-1) ?? null;
  if (frozen !== null) {
    // The frozen surfaces have no revisions to offer: the word is the whole answer.
    return { situation: 'landed', word: 'не меняется', ink: 'quiet', line: null, empty: false };
  }
  if (last !== null && last.changeSeq !== null) {
    // The head row's own cell: «внесено · правка 012» — one word with its change, and no second
    // line, because the number is part of what the word says (#3863 §4).
    return {
      situation: 'landed',
      word: `${STATE_WORDS.landed} · правка ${String(last.changeSeq).padStart(3, '0')}`,
      ink: 'ink',
      line: null,
      empty: false,
    };
  }

  /**
   * No filing and no revision. A chain that still holds the introduction is not «nothing»: the
   * `история` section prints its single row (never a count of one), so the record is not empty.
   * Only a chain that answers with no versions at all is the one-line record of #3862 §3.
   */
  const versions = Array.isArray(chain?.versions) ? chain.versions : [];
  if (versions.length > 0) {
    return { situation: 'untouched', word: null, ink: 'quiet', line: null, empty: false };
  }
  return { situation: 'untouched', word: null, ink: 'quiet', line: 'с тех пор её никто не трогал', empty: true };
}

/* ---------- rows ---------- */

export type InterventionRow = {
  id: string;
  /** `№A7K · ваше · внесено · 28.10, 12:08` — one line, the row's facts. */
  facts: string;
  /** The pair, or the deck's own consequence. */
  specimen: string;
  own: boolean;
  /** The filing itself, for the `замечание` body state. */
  comment: CommentDto;
};

/** `28.10, 12:08` — the row register's short moment. */
function shortMoment(iso: string): string {
  const date = formatDate(iso);
  const time = formatTime(iso);
  if (date === '—' || time === '—') return '—';
  return `${date.slice(0, 5)}, ${time}`;
}

/** One intervention row: the reader's own first, then pending, then newest (`sortFilings`). */
export function interventionRows(input: {
  filings: readonly CommentDto[];
  own: (comment: CommentDto) => boolean;
}): InterventionRow[] {
  return input.filings.map((comment) => {
    const mine = input.own(comment);
    return {
      id: comment.id,
      facts: [filingNumber(comment), mine ? 'ваше' : null, stateWordOf(comment), shortMoment(comment.createdAt)]
        .filter((part): part is string => part !== null && part.length > 0)
        .join(' · '),
      specimen: filingConsequence(comment),
      own: mine,
      comment,
    };
  });
}

/** The word a filing's row prints: the deck's state word, or the gate's when it refused. */
function stateWordOf(comment: CommentDto): string {
  if (comment.status === 'rejected') return comment.refusal === 'rights' ? GATE_WORDS.rights : GATE_WORDS.auditor;
  if (comment.status === 'quarantined') return GATE_WORDS.held;
  // BOOK-189: the deck's own table, so a row's word cannot disagree with the state block above
  // (an `accepted` filing the writer has not reached is «ждёт», not «идёт»).
  return STATE_WORDS[filingState(comment)];
}

export type HistoryRow = {
  id: string;
  /** `28.10, 12:08 · печатник · правка 012` */
  facts: string;
  /** The pair, or the record's own confession that the pair was not stored. */
  specimen: string;
};

/** Newest first; the chain is per block, and the block is the record's honest granularity. */
export function historyRows(chain: ParagraphChainDto | null): HistoryRow[] {
  const versions = Array.isArray(chain?.versions) ? chain.versions : [];
  return [...versions].reverse().map((version) => ({
    id: `${version.blockUid}-${String(version.ver)}`,
    facts: [
      shortMoment(version.at),
      version.actor?.label ?? PASS_HAND,
      version.changeSeq === null ? null : `правка ${String(version.changeSeq).padStart(3, '0')}`,
    ]
      .filter((part): part is string => part !== null && part.length > 0)
      .join(' · '),
    // The chain carries no pair; the change's span is the chronicle's row, and inventing one
    // here would be a claim nobody stored.
    specimen: 'пара не записана',
  }));
}

/* ---------- the count law ---------- */

export const RECORD_CUT = 3;
export const RECORD_LIFT = 6;

export type RowWindow<T> = {
  rows: T[];
  /** `ещё N →` after the cut, when the list holds more than the cut. */
  more: number;
  /** `показаны 6 из N` above the lift ceiling. */
  over: number;
};

/** Three visible, six lifted, then the count — one law for every list in the block. */
export function rowWindow<T>(rows: readonly T[], lifted: boolean): RowWindow<T> {
  const visible = lifted ? RECORD_LIFT : RECORD_CUT;
  const shown = rows.slice(0, visible);
  const rest = rows.length - shown.length;
  return {
    rows: shown,
    more: rest > 0 && rows.length <= RECORD_LIFT ? rest : 0,
    over: rest > 0 && rows.length > RECORD_LIFT ? rest : 0,
  };
}

/** A count that is printed beside a header: never a zero, never a one. */
export function countOf(rows: readonly unknown[]): string | null {
  return rows.length > 1 ? String(rows.length) : null;
}
