import type { CommentDto, ParagraphChainDto, ParagraphVersionDto } from '@book/shared';
import { filingWord } from '@book/shared';

import { formatDate, formatTime } from './format.ts';
import {
  filingConsequence,
  filingMarginalia,
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

/**
 * §11.3 — the record's head line: **the reader's act**, and the printer's only where it is the
 * point.
 *
 * The old line was the hand of the last version (`печатник · 28.10.2026, 00:29`) — the
 * printer's own timestamp, which the reader did not ask for and which said nothing about their
 * own filing. Now a filing names the reader's act (`вы предложили 28.10, 00:24`); the printer's
 * act (`печатник внёс правку 28.10, 00:29`) stands only where it is the point — the record of a
 * sentence with no filing, and the trail's rows — never beside a state word that already says
 * «внесено». A sentence nobody wrote has no line at all.
 */
export function headLineOf(input: {
  filing: CommentDto | null;
  viewer: string | null;
  chain: ParagraphChainDto | null;
  frozen: 'frame' | 'basis' | null;
}): string | null {
  if (input.frozen === 'basis') return 'основание книги';
  if (input.frozen === 'frame') return 'рамка книги';
  const versions = Array.isArray(input.chain?.versions) ? input.chain.versions : [];
  const last = versions.at(-1) ?? null;
  const filing = input.filing;
  if (filing !== null) {
    const own = input.viewer !== null && filing.author === input.viewer;
    return `${own ? 'вы предложили' : 'читатель предложил'} ${shortMoment(filing.createdAt)}`;
  }
  if (last === null) return null;
  return `${OP_WORDS[last.op]} ${shortMoment(last.at)}`;
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
  /**
   * §11.3 — the filing the record is open for. The head speaks about it, and `замечания` lists
   * the others; without one, the reader's own filing comes first, then the newest.
   */
  subject?: string | null;
}): RecordState {
  const { filings, chain, writing, frozen, own } = input;
  if (writing) return { situation: 'writing', word: 'пишется', ink: 'live', line: null, empty: false };

  const subject = filings.find((comment) => comment.id === input.subject) ?? null;
  const filing = subject ?? filings.find(own) ?? filings[0] ?? null;

  if (filing !== null) {
    const mine = own(filing);
    // BOOK-90 — the word is the deck's, read once (`filingMarginalia`): this module decides the
    // situation and the line, never a second word for the same row.
    const { word } = filingMarginalia(filing);
    // BOOK-219 — a receipt on the row is the server's landing fact, the one receipt shape of the
    // block: «внесено · глава 67 · ревизия 4», whatever the row's status still says.
    const receipt = landedReceiptLine(filing.applied);
    if (receipt !== null) return { situation: 'landed', word, ink: 'ink', line: receipt, empty: false };
    // §11.3 — a failed attempt is our failure, said once in the book's own sentence (the row
    // keeps its state word, because the filing still waits); the trail keeps the row after a
    // repeat, and the record never offers the bare «ждёт» over a try that came back empty.
    if (filing.attempt === 'failed') {
      return {
        situation: mine ? 'waitingOwn' : 'waiting',
        word,
        ink: 'live',
        line: filingConsequence(filing),
        empty: false,
      };
    }
    switch (filing.status) {
      case 'new':
        return {
          situation: mine ? 'waitingOwn' : 'waiting',
          word,
          ink: 'live',
          line: mine ? 'ваша — в очереди' : 'решения ещё нет',
          empty: false,
        };
      case 'batched':
      case 'delivered':
        return {
          situation: 'working',
          word,
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
            word,
            ink: 'live',
            line: 'пишется',
            empty: false,
          };
        }
        return {
          situation: mine ? 'waitingOwn' : 'waiting',
          word,
          ink: 'live',
          line: mine ? 'ваша — в очереди' : 'в очереди на запись',
          empty: false,
        };
      case 'quarantined':
        return { situation: 'held', word, ink: 'live', line: 'ждёт человека', empty: false };
      case 'applied': {
        // BOOK-189 — the receipt path returned above; a row without one prints the deck's own
        // line and never an invented revision.
        const fallback = filingConsequence(filing);
        return {
          situation: 'landed',
          word,
          ink: 'ink',
          line: fallback.length === 0 ? null : fallback,
          empty: false,
        };
      }
      case 'registered':
        // BOOK-137 — a paperwork row is decided, not refused: the thread's own line, and the
        // word is the deck's «рассмотрено».
        return { situation: 'landed', word, ink: 'ink', line: filingConsequence(filing), empty: false };
      case 'rejected':
        // The gate's own word and the reason **whole** — a refusal is a decision, not an error.
        // §11.3 — the sentence stands on its own, with no leading colon: the word is printed
        // once in the head, and the sentence says what happened to the text, once.
        return {
          situation: 'refused',
          word,
          ink: 'revise',
          line: filing.reason ?? filingConsequence(filing),
          empty: false,
        };
      default:
        // `superseded`, `expired`, `hidden`: the deck's own word and line, printed, not re-decided.
        return {
          situation: 'refused',
          word,
          ink: 'revise',
          line: filingConsequence(filing),
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

/**
 * One intervention row: the reader's own first, then pending, then newest (`sortFilings`).
 *
 * §11.3 — the record's own filing is **not** one of these rows: the filing the record is open
 * for lives in the head (its number once, its state once), and `замечания` lists the sentence's
 * *other* filings. The row's number is the change's own `seq` in the book's words — never a
 * token cut out of an id.
 */
export function interventionRows(input: {
  filings: readonly CommentDto[];
  own: (comment: CommentDto) => boolean;
  /** The filing the head speaks about; its id is left out of the list. */
  subject?: string | null;
}): InterventionRow[] {
  return input.filings
    .filter((comment) => comment.id !== input.subject)
    .map((comment) => {
      const mine = input.own(comment);
      return {
        id: comment.id,
        facts: [filingWord(comment.changeSeq), mine ? 'ваше' : null, stateWordOf(comment), shortMoment(comment.createdAt)]
          .filter((part): part is string => part !== null && part.length > 0)
          .join(' · '),
        specimen: filingConsequence(comment),
        own: mine,
        comment,
      };
    });
}

/** The word a filing's row prints: the deck's own table, read from `filingMarginalia` once. */
function stateWordOf(comment: CommentDto): string {
  return filingMarginalia(comment).word;
}

export type HistoryRow = {
  id: string;
  /** `28.10, 00:24 · вы предложили эту правку` — when, who, what, in the book's words. */
  facts: string;
  /** `было: «…» → стало: «…»`, a short fragment; `''` when the book holds no honest pair. */
  specimen: string;
};

/** The one word for an op: the printer's act, never the chain's own verb. */
const OP_WORDS: Readonly<Record<ParagraphVersionDto['op'], string>> = {
  introduced: 'печатник написал фразу',
  revised: 'печатник внёс правку',
  kept: 'никто не менял фразу',
  erased: 'печатник убрал фразу',
};

/** A short fragment of a changed text: the pair is never the whole sentence on the row. */
function fragment(text: string, max = 48): string {
  const clean = text.replace(/\s+/gu, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/** The reader's act, as the history's own words: «вы» or «читатель», never a display name. */
function proposer(own: boolean): string {
  return own ? 'вы предложили эту правку' : 'читатель предложил эту правку';
}

/**
 * §11.3 — the record's `история`: one row per event, newest first.
 *
 * Every row answers **when, who, what happened** to the sentence: `28.10, 00:24 · вы
 * предложили эту правку`, `28.10, 00:29 · печатник внёс правку`, `28.10, 00:31 · никто не
 * внёс правку`. No placeholder ever reaches the reader (`пара не записана` is gone), no id and
 * no machine noun: the words come from `OP_WORDS` and the row's own moment. When the text
 * changed and the pair is honestly held (the filing's stored quote and the sentence that stands
 * there now), a short fragment follows; when it is not, the row simply says what is known.
 *
 * Two rows with the same minute, kind and change are **one event** (§11.3): the chain and the
 * frames can both narrate one write, and the trail prints it once.
 */
export function historyRows(input: {
  chain: ParagraphChainDto | null;
  /** The filing the record is open for, when there is one: its proposal is an event too. */
  filing?: CommentDto | null;
  viewer?: string | null;
  /** The sentence as it stands now — the `стало` side of a pair, when one is held. */
  quote?: string | null;
  /** The failure was ours: the trail keeps it, even after a repeat. */
  failed?: boolean;
}): HistoryRow[] {
  const versions = Array.isArray(input.chain?.versions) ? input.chain.versions : [];
  const filing = input.filing ?? null;
  const own = filing !== null && input.viewer !== null && input.viewer !== undefined && filing.author === input.viewer;
  const quote = input.quote ?? null;
  type Event = { at: string; kind: string; change: number | null; facts: string; specimen: string };
  const events: Event[] = [];
  if (filing !== null) {
    events.push({
      at: filing.createdAt,
      kind: 'proposed',
      change: filing.changeSeq ?? null,
      facts: `${shortMoment(filing.createdAt)} · ${proposer(own)}`,
      specimen: '',
    });
  }
  for (const version of versions) {
    const changed =
      version.op === 'revised' && filing !== null && quote !== null && filing.anchor.quote !== null &&
      filing.anchor.quote !== quote &&
      (version.changeId === filing.changeId ||
        (version.changeSeq !== null && version.changeSeq === filing.changeSeq));
    events.push({
      at: version.at,
      kind: version.op,
      change: version.changeSeq,
      facts: `${shortMoment(version.at)} · ${OP_WORDS[version.op]}`,
      specimen: changed
        ? `было: «${fragment(filing.anchor.quote ?? '')}» → стало: «${fragment(quote ?? '')}»`
        : '',
    });
  }
  if (input.failed === true && filing !== null) {
    const at = filing.decidedAt ?? filing.createdAt;
    events.push({
      at,
      kind: 'failed',
      change: filing.changeSeq ?? null,
      facts: `${shortMoment(at)} · никто не внёс правку`,
      specimen: '',
    });
  }
  const seen = new Set<string>();
  return events
    .sort((left, right) => right.at.localeCompare(left.at))
    .filter((event) => {
      const key = `${shortMoment(event.at)}|${event.kind}|${event.change === null ? '' : String(event.change)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((event, index) => ({
      id: `${event.kind}:${event.at}:${event.change === null ? '' : String(event.change)}:${String(index)}`,
      facts: event.facts,
      specimen: event.specimen,
    }));
}

/* ---------- the count law ---------- */

export const RECORD_CUT = 3;

export type RowWindow<T> = {
  rows: T[];
  /**
   * Rows the fold still hides — the count `ещё N →` promises, and the exact number its control
   * reveals. 0 when nothing remains, and then only `свернуть` is printed.
   */
  rest: number;
};

/**
 * Three visible, then one door for the rest (BOOK-199 m3). A count with no door is a defect:
 * the lifted state shows **every** row, so the fold line that prints `показаны N из M` always
 * carries a control that reveals exactly the M − N it names. One law for every list in the
 * block; no inner scroll, no pagination, no second request.
 */
export function rowWindow<T>(rows: readonly T[], lifted: boolean): RowWindow<T> {
  const shown = lifted ? [...rows] : rows.slice(0, RECORD_CUT);
  return { rows: shown, rest: rows.length - shown.length };
}

/** A count that is printed beside a header: never a zero, never a one. */
export function countOf(rows: readonly unknown[]): string | null {
  return rows.length > 1 ? String(rows.length) : null;
}
