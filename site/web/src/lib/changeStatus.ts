/**
 * The words a change gets on the page (ARCHITECTURE.md §11.6, §11.7, §21.6; DESIGN §8.4–8.6).
 *
 * A comment thread shows **two** lines and never collapses them into one «готово»:
 * acceptance is a promise, application is a fact, and how far the consequence travelled is
 * a third fact (`принято → внесено → дошло до глав 7–9`). BOOK-76: the record now carries one
 * gate fact — `ChangeDto.scienceCheck` — but its word lives in `lib/science.ts`; nothing here
 * names a gate, a finding or a role.
 */

import {
  FAILURE_LINES,
  TOTAL_CHAPTERS,
  isOutcomeLine,
  changeName,
  changeNumber,
  type ChangeDto,
  type ChangeOutcome,
  type ChangeStepDto,
  type ChangeSummaryDto,
  type HistoryRecordDto,
  type PublicRelevance,
  type SeamBoundary,
} from '@book/shared';

import { plural } from './format.ts';
import {
  changeWord,
  draftingLine,
  FILING_LINES,
  NOTE_SAVED_LINE,
  PREMISE_LINES,
  PREMISE_PENDING,
  registrationLine,
  STATE_WORDS,
  turnLine,
} from './marginalia.ts';

export type ChangeLines = {
  first: string;
  second: string;
  tone: 'waiting' | 'live' | 'done' | 'quiet' | 'escalated';
};

/** BOOK-220 B2 — the stale change's one sentence, shared by the row and the live frame's line. */
export const CHANGE_STALE_LINE = 'основа изменилась, решается заново';

/** The stamp on the card and the thread: one fact, never a second line (§DESIGN 7.10). */
export function stampCopy(
  change: Pick<ChangeSummaryDto, 'status' | 'outcome'> & { premise?: boolean; premiseLanded?: boolean },
): string {
  // BOOK-90: the stamp is a **state word** — «ждёт» · «идёт» · «внесено» — not a phrase.
  // A premise's own story (in basis, first edition, refused) is its second line.
  return changeWord(change);
}

/**
 * `14` → `014`, the change's public number (§DESIGN 7.12). BOOK-218 — the one implementation
 * lives in `@book/shared`'s `stateWords.ts` beside `changeName`, so a surface cannot pad a
 * number one way and name it another; this module re-exports it for the page's callers.
 */
export { changeName, changeNumber };

function reached(change: Pick<ChangeSummaryDto, 'chapters' | 'chapter'>): number[] {
  return change.chapters.filter((chapter) => chapter !== change.chapter);
}

/** `7–9`, `6 и 9`, `7` — a readable reach, never a percentage of the book. */
export function chapterRange(chapters: readonly number[]): string {
  const sorted = [...new Set(chapters)].sort((left, right) => left - right);
  if (sorted.length === 0) return '';
  if (sorted.length === 1) return String(sorted[0]);
  const contiguous = sorted.every((chapter, index) => index === 0 || chapter === (sorted[index - 1] ?? 0) + 1);
  if (contiguous && sorted.length > 2) return `${String(sorted[0])}–${String(sorted.at(-1))}`;
  return `${sorted.slice(0, -1).join(', ')} и ${String(sorted.at(-1))}`;
}

export function reachCopy(change: Pick<ChangeSummaryDto, 'chapters' | 'chapter'>): string {
  const wings = reached(change);
  if (wings.length === 0) return `осталось в главе ${change.chapter}`;
  return `дошло до глав ${chapterRange(wings)}`;
}

function isDropped(change: Pick<ChangeSummaryDto, 'status' | 'outcome'>): boolean {
  return change.status === 'void' || change.outcome === 'dropped' || change.outcome === 'superseded';
}

/** The thread's two lines. The first is the state word, the second is the fact (BOOK-90). */
export function changeLines(change: ChangeSummaryDto): ChangeLines {
  const first = changeWord(change);
  // BOOK-7: a premise is the chapter's starting point; it never claims a queue place or a
  // ripple. Its whole story is «ждёт → внесено» with the edition on the second line.
  if (change.premise) {
    // The book's own fact decides the landing. A premise whose chapter has text
    // is «внесено» with the edition it entered — and a failed attempt behind it is stale
    // news, not the premise's line.
    if (change.premiseLanded === true) {
      return { first, second: `вошло в первую редакцию главы ${change.chapter}`, tone: 'done' };
    }
    if (change.status === 'done') {
      return {
        first,
        second: change.reason ?? `вошло в первую редакцию главы ${change.chapter}`,
        tone: 'done',
      };
    }
    if (change.status === 'void') {
      return {
        first,
        second:
          change.reason ??
          (change.outcome === 'superseded' ? PREMISE_LINES.supersededSentence : PREMISE_LINES.refused),
        tone: 'quiet',
      };
    }
    if (change.status === 'pending') {
      return { first, second: PREMISE_PENDING, tone: 'waiting' };
    }
    return {
      first,
      second: change.reason ?? FAILURE_LINES.ourFailure,
      tone: 'escalated',
    };
  }
  if (change.outcome === 'registered') {
    // BOOK-137 — paperwork: nothing was written into the book, so the second line names the
    // mode it was filed as and the fact that matters, never a reach it did not have.
    return { first, second: registrationLine(change.frameMode ?? undefined), tone: 'done' };
  }
  if (change.status === 'pending') {
    // BOOK-218 line 6 — a change's turn, in the chapter's words: never a place in a queue.
    return { first, second: turnLine(change.position), tone: 'waiting' };
  }
  if (change.status === 'stale') {
    return { first, second: CHANGE_STALE_LINE, tone: 'live' };
  }
  if (change.status === 'processing') {
    // BOOK-218 line 7 — the chapter is being drafted. The summary carries no start moment (the
    // full `ChangeDto` does, and `changeVerdict` prints it), so the word stands alone here.
    return { first, second: draftingLine(), tone: 'live' };
  }
  if (change.status === 'escalated') {
    return { first, second: change.reason ?? FAILURE_LINES.ourFailure, tone: 'escalated' };
  }
  if (change.status === 'failed') {
    return { first, second: change.reason ?? 'не удалось внести', tone: 'escalated' };
  }
  if (isDropped(change)) {
    return {
      first,
      second: change.reason ?? (change.outcome === 'superseded' ? 'перекрыто более поздней правкой' : STATE_WORDS.dropped),
      tone: 'quiet',
    };
  }
  return {
    first,
    second: change.outcome === 'adapted' ? `частично · ${reachCopy(change)}` : reachCopy(change),
    tone: 'done',
  };
}

/**
 * The one-line trace `принято → внесено → дошло до глав 7–9` (§20 M4). BOOK-218 — the words are
 * the module's, never a second literal of them.
 */
export function progressLine(change: ChangeSummaryDto): string {
  const state = changeWord(change);
  const accepted = STATE_WORDS.accepted;
  if (change.premise) {
    if (change.premiseLanded === true || change.status === 'done') {
      return `${accepted} в основу → ${state} → вошло в первую редакцию`;
    }
    return `${accepted} в основу → ${state}`;
  }
  // BOOK-137 — paperwork travelled nowhere: no reach to print after the word.
  if (change.outcome === 'registered') return `${accepted} → ${state}`;
  if (change.status === 'done') return `${accepted} → ${state} → ${reachCopy(change)}`;
  return `${accepted} → ${state}`;
}

// ── the change card's vocabulary (public fields only) ────────────────────────

export function relevanceCopy(grade: PublicRelevance['grade']): string {
  if (grade === 'fresh') return 'основа та же';
  if (grade === 'rebased') return 'основа сдвинулась, правка перенесена';
  if (grade === 'partial') return 'основа изменилась частично';
  if (grade === 'void') return 'уже не нужно';
  return 'основа не проверена';
}

/** BOOK-7 — the card's own outcome word for a premise, never «внесено» for a first edition. */
export function premiseOutcomeCopy(change: Pick<ChangeDto, 'status' | 'outcome'> & { premiseLanded?: boolean }): string {
  // The chapter's text is the landing, not the change row's status.
  if (change.premiseLanded === true || change.status === 'done') return 'замысел учтён';
  if (change.status === 'void') return change.outcome === 'superseded' ? 'замысел снят' : 'замысел не взят';
  return 'в основе главы';
}

/** BOOK-218 — every word of a change's outcome is the module's, never a literal of its own. */
export function outcomeCopy(outcome: ChangeOutcome | null): string {
  if (outcome === 'applied') return STATE_WORDS.landed;
  if (outcome === 'adapted') return `${STATE_WORDS.landed} частично`;
  // BOOK-137 — the paperwork's own word, from the one vocabulary: the sentence did not change.
  if (outcome === 'registered') return STATE_WORDS.registered;
  if (outcome === 'dropped') return STATE_WORDS.dropped;
  if (outcome === 'superseded') return 'перекрыто';
  // BOOK-218 line 13 — the day's printing money is gone. It is said as a fact about the day,
  // and it is explicitly not about the reader's own edit.
  if (outcome === 'budget') return FILING_LINES.money;
  // BOOK-218 — the only reason vocabulary: a stop is our failure, never «нужно решение».
  if (outcome === 'oscillation') return FAILURE_LINES.ourFailure;
  if (outcome === 'origin') return FAILURE_LINES.ourFailure;
  if (outcome === 'delta') return FAILURE_LINES.ourFailure;
  if (outcome === 'finding') return `${STATE_WORDS.landed} · ${NOTE_SAVED_LINE}`;
  // BOOK-76: a physics stop is not «внесено» and not «замечание сохранено» — the claim
  // never entered the book and the change waits for a decision.
  if (outcome === 'science') return FAILURE_LINES.ourFailure;
  if (outcome === 'ending') return FAILURE_LINES.ourFailure;
  // BOOK-61/BOOK-218: a Gate B stop is our failure — the text was not judged, so the edit is
  // not rejected, and the card carries the one line that says so.
  if (outcome === 'rights') return FAILURE_LINES.ourFailure;
  if (outcome === 'gate_timeout') return FAILURE_LINES.outOfTime;
  return STATE_WORDS.reading;
}

/**
 * BOOK-61 — the change card's footer is one line: the outcome word, then the reason. A reason
 * that **already opens with that word** is that line (Gate B's fixed sentence — «не принято:
 * чужая цитата без источника»), so the word is not printed beside it a second time. Every
 * other outcome keeps both parts exactly as before.
 */
export function outcomeLine(change: Pick<ChangeDto, 'premise' | 'status' | 'outcome' | 'reason'>): {
  word: string | null;
  reason: string | null;
} {
  const word = change.premise ? premiseOutcomeCopy(change) : outcomeCopy(change.outcome);
  const reason = change.reason;
  // BOOK-218 — one reason line: a stored outcome sentence is the whole verdict, and a reason
  // that already opens with the word is that line too. Nothing is printed twice.
  if (reason !== null && reason.length > 0) {
    if (isOutcomeLine(reason) || reason.startsWith(word)) return { word: null, reason };
  }
  return { word, reason };
}

/**
 * The one word a public record entry prints when the book did not take the change, else `null`.
 *
 * BOOK-65 kept two vocabularies — the queue's and the card's — on the list; the record is now
 * the book's changes, so the list says one thing where the book refused: «не внесено», with no
 * invented span beside it. A change still on its way carries no word (the queue's place belongs
 * to the door), and a landed change has the span for its fact. A premise whose chapter has text
 * is in the first edition and has landed; a pass with no change row has landed by definition
 * (its landed stage is the row).
 *
 * The word names the fact, never the machinery: no status code, no role, no verdict.
 */
export const RECORD_NOT_LANDED = 'не внесено';

/**
 * The one word each cause gets on the chronicle's row (owner, 2026-10-28).
 *
 * «правка читателя» is a person's filing the book accepted; «писалась» is a pass over the
 * book — a machine change or a landed stage with no change row. The record never prints the
 * internal noun for a pass: the word names whose act it was, not the workshop's vocabulary.
 */
export const CAUSE_WORDS = { reader: 'правка читателя', pass: 'писалась' } as const;

export function recordStateWord(
  record: Pick<HistoryRecordDto, 'status' | 'premise' | 'premiseLanded'>,
): string | null {
  if (record.premise) return record.premiseLanded ? null : RECORD_NOT_LANDED;
  if (record.status === 'void' || record.status === 'escalated' || record.status === 'failed') {
    return RECORD_NOT_LANDED;
  }
  return null;
}

/**
 * The public reason a refused or stopped change prints **after** its word, or `null`.
 *
 * The server already bounds and normalises it (`record.ts`), so the row appends nothing of its
 * own: the reason is the only tail a record entry may carry, and only where there is one.
 * A premise that landed carries none, whatever its change row still says: the failed attempt
 * behind a written chapter is stale news, not the premise's line.
 */
export function recordReason(
  record: Pick<HistoryRecordDto, 'status' | 'reason' | 'premiseLanded'>,
): string | null {
  if (record.reason === null || record.reason.length === 0) return null;
  if (record.premiseLanded) return null;
  if (record.status === 'void' || record.status === 'escalated' || record.status === 'failed') return record.reason;
  return null;
}

/** `8` → `стык 7 | 8`; the sentinels name the first sheet and the ending (§6A.5). */
export function boundaryLabel(boundary: SeamBoundary): string {
  if (boundary === 'front') return 'обложка | 1';
  if (boundary === 'ending') return `${TOTAL_CHAPTERS} | финал`;
  return `${boundary - 1} | ${boundary}`;
}

export function stepLabel(step: ChangeStepDto): string {
  if (step.pass === 'front') return 'обложка и страница 2';
  if (step.pass === 'ending') return 'финал проверен';
  if (step.chapter === null) return step.pass;
  if (step.outcome === 'rewritten') return `глава ${step.chapter} переписана`;
  if (step.outcome === 'published_with_finding') return `глава ${step.chapter} переписана · замечание сохранено`;
  if (step.outcome === 'holds') return `глава ${step.chapter} проверена, правок нет`;
  if (step.outcome === 'evaluated') return `глава ${step.chapter} проверена`;
  if (step.outcome === 'escalated') return `глава ${step.chapter}: ждёт решения`;
  if (step.outcome === 'interrupted') return `глава ${step.chapter}: прервана`;
  return `глава ${step.chapter}: идёт`;
}

/** `←` down the book, `→` up it, `·` a local step (§DESIGN 7.13). */
export function wingGlyph(step: ChangeStepDto): string {
  if (step.wing === 'downward') return '←';
  if (step.wing === 'upward') return '→';
  return '·';
}

export function changeHeading(change: Pick<ChangeDto, 'seq' | 'chapter'> & { premise?: boolean }): string {
  // BOOK-7: a premise has no edit number — it is the chapter's starting point, not «правка N».
  if (change.premise === true) return `замысел · глава ${change.chapter}`;
  return `правка ${changeNumber(change.seq)} · глава ${change.chapter}`;
}

/** `3 главы` in the card's «затронуто» line, never in the ribbon. */
export function touchedCopy(change: Pick<ChangeDto, 'steps'>): string {
  const chapters = new Set<number>();
  for (const step of change.steps) if (typeof step.chapter === 'number') chapters.add(step.chapter);
  const count = chapters.size;
  return `${count} ${plural(count, 'глава', 'главы', 'глав')}`;
}
