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
  TOTAL_CHAPTERS,
  type ChangeDto,
  type ChangeOutcome,
  type ChangeStepDto,
  type ChangeSummaryDto,
  type HistoryRecordDto,
  type PublicRelevance,
  type SeamBoundary,
} from '@book/shared';

import { plural } from './format.ts';
import { changeState, changeWord, PREMISE_PENDING, STATE_WORDS } from './marginalia.ts';

export type ChangeLines = {
  first: string;
  second: string;
  tone: 'waiting' | 'live' | 'done' | 'quiet' | 'escalated';
};

/** The stamp on the card and the thread: one fact, never a second line (§DESIGN 7.10). */
export function stampCopy(change: Pick<ChangeSummaryDto, 'status' | 'outcome'> & { premise?: boolean }): string {
  // BOOK-90: the stamp is a **state word** — «ждёт» · «идёт» · «внесено» — not a phrase.
  // A premise's own story (in basis, first edition, refused) is its second line.
  return changeWord(change);
}

/** `14` → `014`, the change's public number (§DESIGN 7.12). */
export function changeNumber(seq: number): string {
  return String(Math.trunc(seq)).padStart(3, '0');
}

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
        second: change.reason ?? (change.outcome === 'superseded' ? 'снято: у главы уже есть замысел' : 'замысел не взят'),
        tone: 'quiet',
      };
    }
    if (change.status === 'pending') {
      return { first, second: PREMISE_PENDING, tone: 'waiting' };
    }
    return {
      first,
      second: change.reason ?? 'нужно решение автора',
      tone: 'escalated',
    };
  }
  if (change.status === 'pending') {
    return {
      first,
      second: `${change.position ?? 1}-я в очереди`,
      tone: 'waiting',
    };
  }
  if (change.status === 'stale') {
    return { first, second: 'основа изменилась, решается заново', tone: 'live' };
  }
  if (change.status === 'processing') {
    return { first, second: `пишется глава ${change.chapter}`, tone: 'live' };
  }
  if (change.status === 'escalated') {
    return { first, second: change.reason ?? 'нужно решение автора', tone: 'escalated' };
  }
  if (change.status === 'failed') {
    return { first, second: change.reason ?? 'не удалось внести', tone: 'escalated' };
  }
  if (isDropped(change)) {
    return {
      first,
      second: change.reason ?? (change.outcome === 'superseded' ? 'перекрыто более поздней правкой' : 'снято'),
      tone: 'quiet',
    };
  }
  return {
    first,
    second: change.outcome === 'adapted' ? `частично · ${reachCopy(change)}` : reachCopy(change),
    tone: 'done',
  };
}

/** The one-line trace `принято → внесено → дошло до глав 7–9` (§20 M4). */
export function progressLine(change: ChangeSummaryDto): string {
  const state = changeWord(change);
  if (change.premise) {
    if (change.status === 'done') return `принято в основу → ${state} → вошло в первую редакцию`;
    return `принято в основу → ${state}`;
  }
  if (change.status === 'done') return `принято → ${state} → ${reachCopy(change)}`;
  return `принято → ${state}`;
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
export function premiseOutcomeCopy(change: Pick<ChangeDto, 'status' | 'outcome'>): string {
  if (change.status === 'done') return 'замысел учтён';
  if (change.status === 'void') return change.outcome === 'superseded' ? 'замысел снят' : 'замысел не взят';
  return 'в основе главы';
}

export function outcomeCopy(outcome: ChangeOutcome | null): string {
  if (outcome === 'applied') return 'внесено';
  if (outcome === 'adapted') return 'внесено частично';
  if (outcome === 'dropped') return 'снято';
  if (outcome === 'superseded') return 'перекрыто';
  // BOOK-59: the wave bound is where a deeper change asks for a decision, not a failure, and
  // the word must not name money to a reader who never met a budget.
  if (outcome === 'budget') return 'остановлено: дальше — решением владельца';
  if (outcome === 'oscillation') return 'остановлено: ходит по кругу';
  if (outcome === 'origin') return 'остановлено: нужно решение';
  if (outcome === 'delta') return 'остановлено: слишком много текста';
  if (outcome === 'finding') return 'внесено · замечание сохранено';
  // BOOK-76: a physics stop is not «внесено» and not «замечание сохранено» — the claim
  // never entered the book and the change waits for a decision.
  if (outcome === 'science') return 'остановлено: физика не подтверждена';
  if (outcome === 'ending') return 'финал проверен, нужно решение';
  if (outcome === 'gate_timeout') return 'остановлено: проверка не ответила';
  return 'идёт';
}

/**
 * BOOK-65 — the one word a public record entry prints for a change, and the only function
 * allowed to choose it. The record is one change, one line, and the line carries one outcome:
 * for a change still on its way (or already landed) it delegates to the card's own rule,
 * `changeState`, so the list and the card can never say two different states one click apart.
 * A refusal keeps its word — «снято» · «перекрыто» — from `outcomeCopy`, and a stopped change
 * says «остановлено». A premise speaks of «замысел», so its word agrees with that noun instead
 * («учтён» · «снят» · «ждёт»).
 *
 * Nothing here invents a register: every word already exists in `STATE_WORDS`,
 * `outcomeCopy` or the premise's own card copy. The final wording belongs to BOOK-59's copy
 * pass; this function is where that pass changes it.
 */
export function recordWord(record: Pick<HistoryRecordDto, 'status' | 'outcome' | 'premise'>): string {
  if (record.premise) {
    if (record.status === 'done') return 'учтён';
    if (record.status === 'void') return 'снят';
    return STATE_WORDS.waiting;
  }
  if (record.status === 'void') return outcomeCopy(record.outcome === 'superseded' ? 'superseded' : 'dropped');
  if (record.status === 'escalated' || record.status === 'failed') return 'остановлено';
  // One mapping for all surfaces: «идёт» is a queue place (`pending`/`processing`), «ждёт» is
  // `stale`, «внесено» is `done` — exactly what `changeState` says on the card.
  return STATE_WORDS[changeState(record)];
}

/**
 * The public reason a refused or stopped change prints **after** its word, or `null`.
 *
 * The server already bounds and normalises it (`record.ts`), so the row appends nothing of its
 * own: the reason is the only tail a record entry may carry, and only where there is one.
 */
export function recordReason(record: Pick<HistoryRecordDto, 'status' | 'reason'>): string | null {
  if (record.reason === null || record.reason.length === 0) return null;
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
