/**
 * BOOK-218 — the reader's vocabulary, in one place (BOOK-DOC-82), and its only implementation.
 * Every surface that prints what happened to a reader's edit reads from here: the state word and its
 * line, the thread, a change's turn, the attempts, the hall, the too-many refusal, a stopped pass's
 * `changes.reason` — and, since BOOK-225, the rating and the gate. None spells its own copy, so one
 * row cannot be told two ways; the words are the book's nouns, never the machinery's: no queue, lane,
 * pass, triage, verdict or gate.
 */

import type { RetroMode } from './change.ts';
import type { CarrierKind, Disposition, DispositionLock } from './disposition.ts';
import { DEFAULT_FRAME_MODE } from './frame.ts';
import { boundWord, countWord, ordinalWord } from './naming.ts';

/**
 * The running head's deck: one short word, lowercase, about **now** (owner, 2026-10-29).
 * `web/src/lib/headStatus.ts` chooses it; `HeadStatus.tsx` draws it.
 */
export const HEAD_WORDS = {
  idle: 'тихо',
  reading: 'правку читают',
  waiting: 'правка ждёт',
  drafting: 'главу пишут',
  gates: 'главу проверяют',
  landed: 'внесено',
  offline: 'связи нет',
} as const;

export type HeadWord = keyof typeof HEAD_WORDS;

/** The sentences a reader reads about a filing and the page (BOOK-218): one module spells them. */
export const FILING_LINES = {
  /** 1 — a filing delivered to the reading. */
  reading: 'вашу правку читают',
  /** 6 — accepted, and the chapter's turn has not come. The count is a tail (`turnLine`). */
  waitingTurn: 'правка ждёт своей минуты',
  /** 8 — the gates read what was written. */
  gates: 'написанное читает редактор',
  /** 13 — the day's printing money is gone; the reader's own edit is not the cause. */
  money: 'на сегодня всё: деньги на печать кончились. это не про вашу правку — приходите завтра',
  /** 14 — the page holds no live line, so it cannot say what is happening now. */
  noSocket: 'нет связи: страница не знает, что сейчас происходит. обновите позже',
  /** A row the boot migration has not re-opened yet: the author decides, and it says so. */
  authorWaits: 'ждёт решения автора',
} as const;

/**
 * 11 — a verdict about the idea: one of the four locks, one sentence each (owner, 2026-10-29).
 * The verdict word `не принято` leads, so a surface that prints the word above takes
 * `lockTail` alone.
 */
export const LOCK_LINES: Readonly<Record<DispositionLock, string>> = {
  rights: 'не принято: это чужой текст, а чужое мы не переписываем',
  harm: 'не принято: этим можно навредить живому человеку',
  frame: 'не принято: у этой главы есть рамка, и её не сдвигают',
  finale: 'не принято: финал уже назван, его не меняют',
};

/** One lock's sentence without the verdict word in front of it: `это чужой текст, …`. */
export function lockTail(lock: DispositionLock): string {
  return LOCK_LINES[lock].slice(`${STATE_WORDS.refused}: `.length);
}

/**
 * Our failure — the filing was never judged (owner, 2026-10-29). `не дошло` is the verdict
 * here, not `не принято`: the edit was not rejected, so no sentence about the idea may appear.
 * One line each, and every one says what happened and what to do.
 */
export type FailureCase = 'ourFailure' | 'outOfTime' | 'attemptsSpent';

export const FAILURE_LINES: Readonly<Record<FailureCase, string>> = {
  ourFailure:
    'не дошло: мы не смогли проверить текст. это наша ошибка, правка не отклонена — нажмите «повторить»',
  outOfTime: 'не дошло: не успели. правка не отклонена — нажмите «повторить»',
  attemptsSpent: 'не дошло: пробовали шесть раз и не смогли. правка не отклонена — нажмите «повторить»',
};

/** `не дошло` — the word our failure keeps, and never a verdict about the idea. */
export const UNDELIVERED_WORD = 'не дошло';

/**
 * A reading is the **accepted** half of the vocabulary: the edit was taken, and the one line
 * says how (owner, 2026-10-29). A reading never appears beside a lock or a failure.
 */
export type AcceptedReading = Exclude<Disposition, 'inadmissible'>;

export const READING_LINES: Readonly<Record<AcceptedReading, string>> = {
  as_said: 'прочитали как сказано — ваши слова остались в этом самом предложении',
  through_paper: 'прочитали как бумагу — в сцене это некому сказать, поэтому слово ушло в документ',
  refused_in_world: 'прочитали как ответ мира — в книге это уже установлено, и миру остаётся только ответить',
};

/** Where a `through_paper` reading put the words, in the reader's nouns (closed six). */
export const READING_PLACES: Readonly<Record<CarrierKind, string>> = {
  document: 'в документ',
  speech: 'в чью-то реплику',
  registry_discrepancy: 'в запись регистратуры',
  numbered_object: 'в предмет с номером',
  unheeded_joke: 'в шутку, которую никто не подхватил',
  obligatory_joke: 'в анекдот по протоколу',
};

/**
 * One outcome, one sentence. This type is the whole reason vocabulary: a reading (accepted),
 * a lock (a verdict about the idea) or our failure (never judged). Nothing else.
 */
export type Outcome =
  | { kind: 'reading'; reading: AcceptedReading; carrierKind?: CarrierKind | null }
  | { kind: 'lock'; lock: DispositionLock }
  | { kind: 'failure'; failure: FailureCase };

/**
 * **The one place a reason line is made** (owner, 2026-10-29). A lock decides its own sentence,
 * our failure never carries a reading, and a reading is only ever an accepted outcome. Every
 * surface prints this string and nothing beside it, so two verdicts cannot meet on one row.
 */
export function outcomeLine(outcome: Outcome): string {
  switch (outcome.kind) {
    case 'lock':
      return LOCK_LINES[outcome.lock];
    case 'failure':
      return FAILURE_LINES[outcome.failure];
    case 'reading': {
      const line = READING_LINES[outcome.reading];
      if (outcome.reading !== 'through_paper') return line;
      const carrier = outcome.carrierKind ?? null;
      if (carrier === null) return line;
      // The sentence names the place the row carries; the base line already says «в документ».
      return line.replace('в документ', READING_PLACES[carrier]);
    }
  }
}

/** The verdict word a surface keeps above the line: `не дошло`, `не принято`, or none. */
export function outcomeWord(outcome: Outcome): string | null {
  if (outcome.kind === 'failure') return UNDELIVERED_WORD;
  if (outcome.kind === 'lock') return STATE_WORDS.refused;
  return null;
}

/** A line without its verdict: `это чужой текст, …` / `мы не смогли проверить текст…`. */
export function outcomeTail(outcome: Outcome): string {
  const word = outcomeWord(outcome);
  const line = outcomeLine(outcome);
  return word === null ? line : line.slice(`${word}: `.length);
}

/**
 * The outcome a stored sentence already names — the three closed families, matched exactly.
 * A reader surface reads this first: a failure or a lock suppresses any stored reading, and a
 * sentence this build does not know is not an outcome at all (an old row, printed as stored).
 */
export function parseOutcomeLine(text: string | null | undefined): Outcome | null {
  const line = (text ?? '').trim();
  if (line.length === 0) return null;
  const failure = (Object.keys(FAILURE_LINES) as FailureCase[]).find((key) => FAILURE_LINES[key] === line);
  if (failure !== undefined) return { kind: 'failure', failure };
  const lock = (Object.keys(LOCK_LINES) as DispositionLock[]).find((key) => LOCK_LINES[key] === line);
  if (lock !== undefined) return { kind: 'lock', lock };
  const paperHead = READING_LINES.through_paper.slice(0, READING_LINES.through_paper.indexOf('в документ'));
  if (line.startsWith(paperHead)) {
    const place = line.slice(paperHead.length);
    const carrier = (Object.keys(READING_PLACES) as CarrierKind[]).find((key) => READING_PLACES[key] === place);
    return { kind: 'reading', reading: 'through_paper', carrierKind: carrier ?? null };
  }
  const reading = (Object.keys(READING_LINES) as AcceptedReading[]).find((key) => READING_LINES[key] === line);
  return reading === undefined ? null : { kind: 'reading', reading, carrierKind: null };
}

/**
 * Does this sentence already carry a verdict? A closed outcome line, or a gate's own sentence
 * in the same form (`не принято: …`). A surface checks this before prefixing anything: a
 * verdict is never printed twice on one row.
 */
export function isOutcomeLine(text: string | null | undefined): boolean {
  if (parseOutcomeLine(text) !== null) return true;
  const line = (text ?? '').trim();
  return line.startsWith(`${UNDELIVERED_WORD}: `) || line.startsWith(`${STATE_WORDS.refused}: `);
}

/**
 * The one outcome a filing's own facts name. A stored lock or failure **wins** over any reading:
 * our failure is not an accepted edit, and a lock is a verdict about the idea — so a reading can
 * never appear in either case. A reading is returned only when the edit was written.
 *
 * This is the single place the rule is enforced; every surface asks it and prints one line.
 */
export function outcomeOfFiling(input: {
  /** The edit was accepted into the text (a receipt on the row). */
  written: boolean;
  reason: string | null;
  disposition?: Disposition | null;
  carrierKind?: CarrierKind | null;
}): Outcome | null {
  const stored = parseOutcomeLine(input.reason);
  if (stored !== null && stored.kind !== 'reading') return stored;
  if (!input.written) return null;
  if (stored !== null) return stored;
  const disposition = input.disposition ?? null;
  if (disposition === null || disposition === 'inadmissible') return null;
  return { kind: 'reading', reading: disposition, carrierKind: input.carrierKind ?? null };
}

/**
 * The reading ladder the owner speaks of — attempts two to five, and the refusal after six.
 * **No surface prints these:** the engine reads a filing once and retries a failed call at most
 * `TRIAGE_MAX_TRIES = 3` times (`server/src/engine/filingTriage.ts`) — no second pass, no
 * widening on the third failure, no rule-only sixth attempt, no refusal after six. Each line
 * names the fact the engine does not have yet, so the ladder lands here when it grows one.
 */
export const READING_LADDER = {
  /** Awaiting the ladder: a failed reading is retried by the same call, not by a new pass. */
  again: 'не расслышали с первого раза, читают снова · попытка вторая из пяти',
  /** Awaiting the ladder: `disposition` is final; the reading never changes approach. */
  approach: 'меняют подход: не поправка, а переписать это место · третья попытка из пяти',
  /** Awaiting the ladder: no fourth reading attempt exists. */
  fourth: 'пробуют иначе · попытка четвёртая из пяти',
  /** Awaiting the ladder: no fifth reading attempt exists. */
  fifth: 'пробуют иначе · попытка пятая из пяти',
  /** Awaiting the ladder: nothing reads a filing on a rule alone, without the machine. */
  ruleOnly: 'последняя попытка — по правилу, без машины',
  /** Awaiting the ladder: six attempts never happen; the cap is three per day, not a refusal. */
  spent: FAILURE_LINES.attemptsSpent,
} as const;

export type State =
  | 'waiting'
  | 'reading'
  | 'accepted'
  | 'writing'
  | 'landed'
  | 'registered'
  | 'held'
  | 'refused'
  | 'undelivered'
  | 'dropped'
  | 'hidden';

/** The state words. Nothing outside this module may spell one (BOOK-90, BOOK-137, BOOK-189). */
export const STATE_WORDS: Readonly<Record<State, string>> = {
  waiting: 'ждёт',
  reading: 'идёт',
  accepted: 'принято',
  writing: 'главу пишут',
  landed: 'внесено',
  registered: 'рассмотрено',
  held: 'проверяется',
  // BOOK-218: two sinks, one word each — a landing says `внесено`, a refusal `не принято`,
  // whatever gate made the refusal. The reason on the line is what separates the two refusals.
  refused: 'не принято',
  /** Our failure, and never a verdict about the idea: the filing was never judged. */
  undelivered: UNDELIVERED_WORD,
  dropped: 'снято',
  hidden: 'скрыто',
};

/**
 * The second line under the word, when the state alone carries it. `''` means the word is the
 * whole answer, or that the line depends on a fact and comes from a helper below.
 */
export const STATE_LINES: Readonly<Record<State, string>> = {
  waiting: 'её ещё не читали',
  reading: FILING_LINES.reading,
  accepted: FILING_LINES.waitingTurn,
  writing: '',
  landed: '',
  registered: '',
  held: 'ждёт человека',
  refused: '',
  undelivered: '',
  dropped: '',
  hidden: '',
};

/** Nobody has read it, and it is the reader's own: possession is a fact on the line. */
export const OWN_WAITING_LINE = 'ваша — её ещё не читали';

/** The line a filing's own row prints: `ваша — её ещё не читали` / `её ещё не читали`. */
export function waitingLine(own: boolean): string {
  return own ? OWN_WAITING_LINE : STATE_LINES.waiting;
}

/** `глава 7` — the chapter a change is writing or has written. */
export function chapterLine(chapter: number): string {
  return `глава ${String(chapter)}`;
}

/* ── a landing ─────────────────────────────────────────────────────────────── */

/**
 * 10 — the landing without its sink word: `в главу 1. это третья редакция`. A surface that
 * prints `внесено` above takes this tail; one that prints one sentence takes `landedSentence`.
 */
export function landedTail(chapter: number, rev: number | null = null): string {
  const head = `в главу ${String(chapter)}`;
  if (rev === null) return head;
  const edition = ordinalWord(rev);
  return edition === null ? head : `${head}. это ${edition} редакция`;
}

/** 10 — the whole sentence: `внесено в главу 1. это третья редакция`. */
export function landedSentence(chapter: number, rev: number | null = null): string {
  return `${STATE_WORDS.landed} ${landedTail(chapter, rev)}`;
}

/* ── the pipeline's sentences ──────────────────────────────────────────────── */

/**
 * 6 — a change waits its turn, and how many filings stand before it (`change.position`, 1-based).
 * Past twenty ahead the tail is dropped; `null` prints the reason alone, never a guessed number.
 */
export function turnLine(position: number | null = null): string {
  if (position === null || !Number.isFinite(position)) return FILING_LINES.waitingTurn;
  const ahead = Math.max(0, Math.trunc(position) - 1);
  const word = countWord(ahead);
  if (word === null) return FILING_LINES.waitingTurn;
  return `${FILING_LINES.waitingTurn}: впереди ${word}`;
}

/** 7 — a chapter is being drafted, from `at` on the site's clock (`HH:MM`, formatted by the caller). */
export function draftingLine(at: string | null = null): string {
  return at === null || at.length === 0 ? HEAD_WORDS.drafting : `${HEAD_WORDS.drafting} — начали в ${at}`;
}

/**
 * 9 — the editor asked for one place to be mended, and which mend this is of how many.
 *
 * No surface prints it yet: the round is a change step's `gates.cycles`, and the bound is the
 * engine's `GATE_CYCLES` (config, in no DTO), while no surface reads a step's live gates. A
 * sentence with an invented bound would lie, so it waits here for the fact.
 */
export function reviseLine(round: number, cap: number): string {
  const edition = ordinalWord(round);
  const bound = boundWord(cap);
  if (edition === null || bound === null) return 'редактор просит поправить одно место';
  return `редактор просит поправить одно место · ${edition} поправка из ${bound}`;
}

/** The two ways a filing is dropped: the text moved under it, or the attempt never landed. */
export const DROPPED_LINES = {
  superseded: 'текст успел измениться',
  expired: 'правка не состоялась',
} as const;

export function droppedLine(kind: keyof typeof DROPPED_LINES): string {
  return DROPPED_LINES[kind];
}

/** The paperwork's line: the mode it was filed as, and the fact that matters. */
export function registrationLine(mode: RetroMode = DEFAULT_FRAME_MODE): string {
  return `${mode} · фраза не изменилась`;
}

/** A premise waits for the chapter's first edition, and then it entered it. */
export const PREMISE_LINES = {
  /** Under «принято», while no text of the chapter exists yet. */
  pending: 'в основу · до первой редакции',
  /** The same fact where no state word stands above it (a change's card). */
  pendingSentence: `${STATE_WORDS.accepted} в основу · до первой редакции`,
  /** Under «снято»: the chapter already has a premise of its own. */
  superseded: 'у главы уже есть замысел',
  /** The same fact where no state word stands above it (a change's card). */
  supersededSentence: `${STATE_WORDS.dropped}: у главы уже есть замысел`,
  refused: 'замысел не взят',
} as const;

export function premiseLandedLine(chapter: number): string {
  return `вошло в первую редакцию главы ${String(chapter)}`;
}

/** An attempt the machine tried and could not land: the filing keeps its word and waits. */
export const FAILED_ATTEMPT_LINE = 'машина не смогла внести — правка ждёт, её попробуют снова';

/** An attempt that came back with nothing usable: one sentence, and the filing still waits. */
export const ATTEMPT_LINE = 'попытка не удалась — правка ждёт';

/** A note (no kind, no proposed text) never lands text: its terminal is «замечание сохранено». */
export const NOTE_SAVED_LINE = 'замечание сохранено';

/** The full hall (BOOK-75): the reader is told they wait for a seat, not for a queue. */
export const CAPACITY_PLATE = 'Все места заняты. Вы ждёте места: кто-то уйдёт — и вы войдёте.';

/** Too many filings wait at once: the only answer is a later try. */
export const TOO_MANY_FILINGS = 'правок ждёт слишком много — попробуйте позже';

/**
 * The stop reasons, one sentence per way a pass can stop (BOOK-DOC-82). BOOK-219 owns the
 * register: a parked pass escalates the step and an escalated change is terminal, so no sentence
 * here promises a queue or a retry — each names what happened to the reader's edit and says
 * «правка остановлена».
 */
export type StopReason =
  | 'shape'
  | 'modelTimeout'
  | 'modelDown'
  | 'truncated'
  | 'refusal'
  | 'answerRejected'
  | 'engineDown'
  | 'rightsMissing'
  | 'frameChanged'
  | 'stepClosed'
  | 'reverted'
  | 'unverified'
  | 'rightsReverted'
  | 'rightsUnverified'
  | 'closeReverted'
  | 'closeStanding'
  | 'closeUncertain'
  | 'stopped'
  | 'gate';

export const STOP_REASONS: Readonly<Record<StopReason, string>> = {
  shape: FAILURE_LINES.ourFailure,
  modelTimeout: FAILURE_LINES.outOfTime,
  modelDown: FAILURE_LINES.ourFailure,
  truncated: FAILURE_LINES.ourFailure,
  refusal: FAILURE_LINES.ourFailure,
  answerRejected: FAILURE_LINES.ourFailure,
  engineDown: FAILURE_LINES.ourFailure,
  rightsMissing: FAILURE_LINES.ourFailure,
  frameChanged: FAILURE_LINES.ourFailure,
  stepClosed: FAILURE_LINES.ourFailure,
  reverted: FAILURE_LINES.ourFailure,
  unverified: FAILURE_LINES.ourFailure,
  rightsReverted: FAILURE_LINES.ourFailure,
  rightsUnverified: FAILURE_LINES.ourFailure,
  closeReverted: FAILURE_LINES.ourFailure,
  closeStanding: FAILURE_LINES.ourFailure,
  closeUncertain: FAILURE_LINES.ourFailure,
  stopped: FAILURE_LINES.ourFailure,
  gate: FAILURE_LINES.ourFailure,
};

/**
 * The key an engine code maps to; `null` for a code this table does not know. The code itself
 * stays in the process log and the transcript — a reader never sees one.
 */
export function stopReasonKey(code: string | null | undefined): StopReason | null {
  const value = (code ?? '').trim().toUpperCase();
  if (value === 'PROVIDER_SHAPE') return 'shape';
  if (value === 'PROVIDER_TIMEOUT') return 'modelTimeout';
  if (value === 'PROVIDER_UNREACHABLE' || value.startsWith('PROVIDER_HTTP_')) return 'modelDown';
  if (value === 'ANSWER_TRUNCATED') return 'truncated';
  if (value === 'ANSWER_REFUSAL') return 'refusal';
  if (value.startsWith('ANSWER_')) return 'answerRejected';
  if (value === 'ENGINE_TIMEOUT' || value === 'ENGINE_UNREACHABLE' || value === 'DB_BUSY') return 'engineDown';
  if (value.startsWith('RIGHTS')) return 'rightsMissing';
  if (value === 'FRAME_CHANGED') return 'frameChanged';
  if (value === 'STEP_CLOSED') return 'stepClosed';
  return null;
}

/** The reader's sentence for a code, and the generic stop for a code the table does not know. */
export function stopReason(code: string | null | undefined): string {
  return STOP_REASONS[stopReasonKey(code) ?? 'stopped'];
}

/**
 * The sentences a pass leaves when it stops without a code of its own. They land in
 * `changes.reason`, so they speak about the reader's edit; the technical detail stays in the log.
 * The register is BOOK-219's: a parked pass is a stopped edit, never a queued one.
 */
export const PASS_STOPS = {
  startMissing: FAILURE_LINES.ourFailure,
  promptMissing: FAILURE_LINES.ourFailure,
  costMissing: FAILURE_LINES.ourFailure,
  chapterMissing: FAILURE_LINES.ourFailure,
  revisedRejected: FAILURE_LINES.ourFailure,
  stepNotClosed: FAILURE_LINES.ourFailure,
  notAChapter: FAILURE_LINES.ourFailure,
} as const;

/** A notification's title: four words, no identity, no code — a lock screen is public. */
export function pushLanded(chapter: number): string {
  return `глава ${String(chapter)} написана`;
}

/** The paperwork's answer: the record exists, the letters did not change. */
export function pushAccepted(chapter: number): string {
  return `правка по главе ${String(chapter)} принята`;
}

/** The loudest word a notification may use, and only when nothing was written. */
export function pushRefused(chapter: number): string {
  return `правка по главе ${String(chapter)} отклонена`;
}

/** BOOK-225 — the rating, the one question before the prose, and the refusal without it. */
export const AGE_WORDS = {
  label: '18+',
  colophon: '18+ · насилие, кровь и взрослые темы',
  rulesHeading: 'кому это читать',
  rulesBody: 'Книге 18+. Внутри — насилие, кровь и взрослые темы: это жанр, и текст не смягчается.',
  gateLine: 'В книге есть насилие, кровь и взрослые темы.',
  forward: 'мне есть 18 — читать',
  leave: 'мне нет 18 — уйти',
  refusal: 'книга 18+ — сначала подтвердите, что вам есть 18',
} as const;

/* ── BOOK-DOC-84 §10.9 — the book's own counters and the ladder's words ─────────────────────── */

/** §10.2's internal kinds, mapped to the head word they take (§10.9's table). */
export type NowKind =
  | 'тихо'
  | 'читается'
  | 'повтор'
  | 'ждёт'
  | 'пишется'
  | 'проверяется'
  | 'доработка'
  | 'расширение'
  | 'нет связи'
  | 'сбой';

/**
 * The 1:1 rows of §10.9's table. `расширение` is deliberately absent: it keeps the surface's
 * word («правку читают» / «главу пишут») and its note is the author's line, never the head's.
 */
export const HEAD_WORD_OF: Record<Exclude<NowKind, 'расширение'>, HeadWord> = {
  тихо: 'idle',
  читается: 'reading',
  повтор: 'waiting',
  ждёт: 'waiting',
  пишется: 'drafting',
  проверяется: 'gates',
  доработка: 'drafting',
  'нет связи': 'offline',
  // A defect is not a kind the head prints: the machine runs nothing, and `тихо` is true.
  сбой: 'idle',
};

/** Attempts 1..6: the forms of a filing's try and of a fix to written text. */
export type AttemptForm = 'attempt' | 'fix';

const ORDINAL_FEMININE = ['первая', 'вторая', 'третья', 'четвёртая', 'пятая', 'шестая'] as const;
const GENITIVE_COUNT: Record<number, string> = { 5: 'пяти', 6: 'шести' };

const UNIT_FEMININE = [
  'ноль',
  'одна',
  'две',
  'три',
  'четыре',
  'пять',
  'шесть',
  'семь',
  'восемь',
  'девять',
  'десять',
  'одиннадцать',
  'двенадцать',
  'тринадцать',
  'четырнадцать',
  'пятнадцать',
  'шестнадцать',
  'семнадцать',
  'восемнадцать',
  'девятнадцать',
] as const;

const UNIT_MASCULINE = [
  'ноль',
  'один',
  'два',
  'три',
  'четыре',
  'пять',
  'шесть',
  'семь',
  'восемь',
  'девять',
  'десять',
  'одиннадцать',
  'двенадцать',
  'тринадцать',
  'четырнадцать',
  'пятнадцать',
  'шестнадцать',
  'семнадцать',
  'восемнадцать',
  'девятнадцать',
] as const;

const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят'] as const;

/** A whole number in words, 0..59 — the only range a counter or a minute can take. */
function cardinal(value: number, unit: readonly string[]): string {
  const n = Math.max(0, Math.min(59, Math.trunc(value)));
  if (n < 20) return unit[n] ?? 'ноль';
  const tens = TENS[Math.floor(n / 10)] ?? '';
  const rest = n % 10;
  return rest === 0 ? tens : `${tens} ${unit[rest] ?? ''}`.trim();
}

/** Russian plural for a counted noun: 1 → one, 2..4 → few, else many. */
function plural(n: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(n) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/**
 * §10.9: attempts 1..6, as the author's line prints them.
 *
 * `attemptWord(2, 5)` → `вторая из пяти`; `attemptWord(3, 5, 'fix')` → `третья поправка из пяти`;
 * the sixth is always the last one and always says so: `последняя, шестая`.
 */
export function attemptWord(n: number, max: number, form: AttemptForm = 'attempt'): string {
  const count = Math.max(5, Math.min(6, Math.trunc(max)));
  const number = Math.max(1, Math.min(6, Math.trunc(n)));
  if (number === 6) return form === 'fix' ? 'последняя, шестая поправка' : 'последняя, шестая';
  const ordinal = ORDINAL_FEMININE[number - 1] ?? 'первая';
  const of = GENITIVE_COUNT[count] ?? 'пяти';
  return form === 'fix' ? `${ordinal} поправка из ${of}` : `${ordinal} из ${of}`;
}

/**
 * §10.9: an elapsed time or a wait, in whole words.
 *
 * under 60 s → `меньше минуты`; 60–119 s → `минута`; then whole minutes; from an hour, hours;
 * from a day, days. A negative span is the same as zero (clocks disagree; a deadline does not).
 */
export function minutesWord(ms: number): string {
  const value = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (value < 60_000) return 'меньше минуты';
  if (value < 120_000) return 'минута';
  const totalMinutes = Math.floor(value / 60_000);
  if (totalMinutes < 60) {
    return `${cardinal(totalMinutes, UNIT_FEMININE)} ${plural(totalMinutes, 'минута', 'минуты', 'минут')}`;
  }
  const hours = Math.floor(totalMinutes / 60);
  if (hours < 24) {
    if (hours === 1) return 'час';
    return `${cardinal(hours, UNIT_MASCULINE)} ${plural(hours, 'час', 'часа', 'часов')}`;
  }
  const days = Math.floor(hours / 24);
  if (days === 1) return 'сутки';
  if (days === 2) return 'двое суток';
  if (days === 3) return 'трое суток';
  if (days === 4) return 'четверо суток';
  return `${cardinal(days, UNIT_FEMININE)} суток`;
}

/** §10.9: the queue's place. 0 → `следом`; the rest name the filings ahead, in words. */
export function aheadWord(n: number): string {
  const ahead = Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
  if (ahead === 0) return 'следом';
  const count = cardinal(ahead, UNIT_FEMININE);
  return `впереди ${count} ${plural(ahead, 'правка', 'правки', 'правок')}`;
}

/** §10.9: `0,05 $` measured, `≈ 0,05 $` estimated — two decimals, comma, space before the sign. */
export function moneyWord(usd: number, estimated = false): string {
  const value = Number.isFinite(usd) ? Math.max(0, usd) : 0;
  const amount = `${value.toFixed(2).replace('.', ',')} $`;
  return estimated ? `≈ ${amount}` : amount;
}

/** The four widenings the engine may name; the sentence is the reader's, the code is the fact. */
export type WidenedCode = 'wider-edit' | 'whole-chapter' | 'as-document' | 'stricter-check';

const WIDENED_WORDS: Record<WidenedCode, string> = {
  'wider-edit': 'правим шире: не строку, а абзац',
  'whole-chapter': 'правим шире: всю главу',
  'as-document': 'просим читать как документ',
  'stricter-check': 'проверяем строже',
};

/** §10.9: the widening in human words — never «переписывание вместо патча». */
export function widenedWord(code: string): string {
  return WIDENED_WORDS[code as WidenedCode] ?? '';
}

/** The runtime list, for a validator that must reject an unknown code rather than caption it. */
export const WIDENED_CODES = Object.keys(WIDENED_WORDS) as WidenedCode[];

/** Is this string one the engine may store as a widening code? */
export function isWidenedCode(value: unknown): value is WidenedCode {
  return typeof value === 'string' && (WIDENED_CODES as readonly string[]).includes(value);
}

// ── §11.1 — the head's own line ────────────────────────────────────────────
//
// The head is one status line now (BOOK-DOC-84 §11.1), not seven words, and its grammar lives
// here with the rest of the reader-visible vocabulary: `машина` is the one machine noun the head
// may print, `правка`/`глава`/`редакция`/`раунд`/`попытка`/`поправка` are the book's own nouns,
// and a gate keeps its three names. Every rendered word of the line comes from this block; the
// line's own composition (the separators, the clock) is here too, so a module that prints a
// status never invents a string.

/** The one machine noun the head may print (§11.1). */
export const MACHINE = 'машина';

/** What the machine is doing, as the head's verb — never a stage name, never a model. */
export const NOW_VERBS = {
  /** `машина читает правку 012` — a filing's reading or a writer's own read. */
  reading: 'читает',
  /** `машина пишет главу 1` — a draft or a revision that writes text. */
  writing: 'пишет',
  /** `машина меняет подход к правке 012` — the widening, in the reader's words. */
  approach: 'меняет подход к правке',
  /** `машина проверяет главу 1` — a gate round. */
  checking: 'проверяет',
  /** `машина правит по замечанию` — an iteration after a gate's finding. */
  fixing: 'правит по замечанию',
  /** `правка 012 ждёт` — a queue place or a retry, a wait and never a claim of work. */
  waiting: 'ждёт',
  /** `внесено` — the one outcome the book announces. */
  landed: 'внесено',
  /** `не дошло: …` — a work that ended without its text. */
  notDelivered: 'не дошло',
  /** `не принято: …` — a filing the book answered with a no. */
  refused: 'не принято',
  /** `нет связи` — the page cannot see the machine; it is not a stage. */
  offline: 'нет связи',
} as const;

/** The book's nouns around the verbs, so no surface spells them itself. */
export const NOW_NOUNS = {
  filing: 'правка',
  chapter: 'глава',
  /** The same chapter as the object of a verb: `пишет главу 1`, `проверяет главу 1`. */
  chapterAccusative: 'главу',
  edition: 'редакция',
  attempt: 'попытка',
  fix: 'поправка',
  round: 'раунд',
  /** `впереди` — the queue's place, then its number. */
  ahead: 'впереди',
} as const;

/** The three gates, in the head's own register (`редактор`/`консультант`/`права`). */
export const GATE_WORD: Record<string, string> = {
  editor: 'редактор',
  consultant: 'консультант',
  rights: 'права',
};

/** The separator of the head's parts, and the space it carries in the rendered line. */
export const LINE_SEPARATOR = '·';

/**
 * `правка 012` — a filing's number is its change's own sequence, padded to three figures (the
 * record and the trail print the same numeral). No change named ⇒ `правка` alone: a number that
 * no row carries is not invented (§11.1's honesty rule).
 */
export function filingWord(seq: number | null | undefined): string {
  if (typeof seq !== 'number' || !Number.isFinite(seq)) return NOW_NOUNS.filing;
  return `${NOW_NOUNS.filing} ${String(Math.trunc(seq)).padStart(3, '0')}`;
}

/** `глава 1`, `глава 7` — the book's own name for a chapter. */
export function chapterWord(n: number): string {
  return `${NOW_NOUNS.chapter} ${String(Math.trunc(n))}`;
}

/** `главу 1` — the same chapter as the object of a verb (`пишет`, `проверяет`). */
export function chapterAccusativeWord(n: number): string {
  return `${NOW_NOUNS.chapterAccusative} ${String(Math.trunc(n))}`;
}

/** `глава 1, редакция 13` — the write's own receipt. */
export function editionWord(n: number, rev: number): string {
  return `${chapterWord(n)}, ${NOW_NOUNS.edition} ${String(Math.trunc(rev))}`;
}

/** `попытка 1 из 5` — the frame's own numbers, never a default (§11.1). */
export function headAttemptWord(n: number, max: number): string {
  return `${NOW_NOUNS.attempt} ${String(Math.trunc(n))} из ${String(Math.trunc(max))}`;
}

/** `поправка 2 из 5` — an iteration that fixes text a gate has read. */
export function headFixWord(n: number, max: number): string {
  return `${NOW_NOUNS.fix} ${String(Math.trunc(n))} из ${String(Math.trunc(max))}`;
}

/** `впереди 2` — the queue's place, in the head's digits (the author's line keeps words). */
export function aheadDigitsWord(n: number): string {
  const ahead = Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
  return `${NOW_NOUNS.ahead} ${String(ahead)}`;
}

/** `редактор, раунд 1` — the gate and its round; a gate with no round is its name alone. */
export function gateRoundWord(gate: string | null | undefined, round: number | null | undefined): string {
  const name = gate === null || gate === undefined ? '' : (GATE_WORD[gate] ?? '');
  if (name.length === 0) return typeof round === 'number' ? `${NOW_NOUNS.round} ${String(round)}` : '';
  return typeof round === 'number' ? `${name}, ${NOW_NOUNS.round} ${String(round)}` : name;
}

const clockFormatter = new Intl.DateTimeFormat('ru-RU', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'Europe/Moscow',
});

/** `17:04` — the site's one timezone (Moscow, as every other moment of the book). */
export function clockWord(ms: number): string {
  const at = new Date(ms);
  if (Number.isNaN(at.getTime())) return '—';
  return clockFormatter.format(at);
}

/** The piece of a line the phone's step may drop, in this order (§11.1): id, clock, gate. */
export type LineDrop = 'filing' | 'time' | 'gate';

/**
 * One part of the head's line. A part is a clause (`правка 012`, `попытка 1 из 5`); a number the
 * grammar keeps inside a verb phrase (`машина читает правку 012`) travels as the part's `tail`,
 * so the phone hides the number and never a dangling separator.
 */
export type LinePart = {
  text: string;
  tail?: { text: string; drop: LineDrop };
  drop?: LineDrop;
};

/** The head's line: the parts and their separators — one function, one voice (§11.1). */
export function headLineWord(parts: readonly LinePart[]): string {
  return parts.map((part) => part.text + (part.tail?.text ?? '')).join(` ${LINE_SEPARATOR} `);
}

/** The line a reader sees at a width that has dropped `drops` — the phone's step, as text. */
export function visibleLineWord(parts: readonly LinePart[], drops: readonly LineDrop[] = []): string {
  const kept = parts
    .filter((part) => part.drop === undefined || !drops.includes(part.drop))
    .map((part) => ({
      text: part.text,
      ...(part.tail === undefined || drops.includes(part.tail.drop) ? {} : { tail: part.tail }),
    }));
  return headLineWord(kept);
}
