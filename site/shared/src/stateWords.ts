/**
 * BOOK-218 — the reader's vocabulary, in one place (BOOK-DOC-82), and its only implementation.
 * Every surface that prints what happened to a reader's edit reads from here: the state word and its
 * line, the thread, a change's turn, the attempts, the hall, the too-many refusal, a stopped pass's
 * `changes.reason` — and, since BOOK-225, the rating and the gate. None spells its own copy, so one
 * row cannot be told two ways; the words are the book's nouns, never the machinery's: no queue, lane,
 * pass, triage, verdict or gate.
 */

import type { RetroMode } from './change.ts';
import type { CarrierKind, Disposition, DispositionLock, HarmCase } from './disposition.ts';
import { DEFAULT_FRAME_MODE } from './frame.ts';
import { boundWord, countWord, ordinalWord } from './naming.ts';
/** The running head's deck, one word about **now**; `idle` is an internal kind with no rendered
 * word (owner, 2026-10-29) — its entry is empty, and nothing prints a line when nothing happens. */
export const HEAD_WORDS = {
  idle: '',
  reading: 'правку читают',
  waiting: 'правка ждёт',
  drafting: 'главу пишут',
  gates: 'главу проверяют',
  landed: 'внесено',
  offline: 'связи нет',
} as const;

export type HeadWord = keyof typeof HEAD_WORDS;

/** The sentences a reader reads about a filing and the page (BOOK-218). */
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
 * The verdict word `не принято` leads, so a surface that prints the word above takes `lockTail`.
 * BOOK-219 narrows `harm` to four cases (`HarmCase`): harm **inside** the story is the genre, so
 * the blanket line is gone; a row with no case flag reads as the law's own category.
 */
export const HARM_LOCK_LINES: Readonly<Record<HarmCase, string>> = {
  'minor-sexual': 'не принято: с ребёнком и сексом — нельзя',
  'real-person': 'не принято: это про реального человека — так нельзя',
  instructions: 'не принято: это инструкция, как причинить вред человеку, — в книге такого не будет',
  unpublishable: 'не принято: это незаконно публиковать',
};

export const LOCK_LINES: Readonly<Record<DispositionLock, string>> = {
  rights: 'не принято: это чужой текст, а чужое мы не переписываем',
  harm: HARM_LOCK_LINES.unpublishable,
  frame: 'не принято: у этой главы есть рамка, и её не сдвигают',
  finale: 'не принято: финал уже назван, его не меняют',
};

/** One lock's sentence, naming the harm case when the lock is `harm`. */
export function lockLine(lock: DispositionLock, harmCase: HarmCase | null = null): string {
  if (lock === 'harm') return HARM_LOCK_LINES[harmCase ?? 'unpublishable'];
  return LOCK_LINES[lock];
}

/** One lock's sentence without the verdict word in front of it: `это чужой текст, …`. */
export function lockTail(lock: DispositionLock, harmCase: HarmCase | null = null): string {
  return lockLine(lock, harmCase).slice(`${STATE_WORDS.refused}: `.length);
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

/** BOOK-219 — a filing no read could answer: no code, no hour, no queue, no another try. */
export const TRIAGE_REFUSED_LINE = 'прочитать заявку не удалось — заявка отклонена';

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
  /** BOOK-219: the harm lock carries its case, because its four cases are four sentences. */
  | { kind: 'lock'; lock: DispositionLock; harmCase?: HarmCase | null }
  | { kind: 'failure'; failure: FailureCase };

/**
 * **The one place a reason line is made** (owner, 2026-10-29). A lock decides its own sentence,
 * our failure never carries a reading, and a reading is only ever an accepted outcome. Every
 * surface prints this string and nothing beside it, so two verdicts cannot meet on one row.
 */
export function outcomeLine(outcome: Outcome): string {
  switch (outcome.kind) {
    case 'lock':
      return lockLine(outcome.lock, outcome.harmCase ?? null);
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
  const harmCase = (Object.keys(HARM_LOCK_LINES) as HarmCase[]).find((key) => HARM_LOCK_LINES[key] === line);
  if (harmCase !== undefined) return { kind: 'lock', lock: 'harm', harmCase };
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

/** An attempt the machine could not finish: BOOK-219 counts it, and no line promises a wait. */
export const FAILED_ATTEMPT_LINE = 'ответ пришёл не по форме — попытка зачтена';

/** An attempt that came back with nothing usable: one sentence, and the attempt is spent. */
export const ATTEMPT_LINE = 'попытка не удалась — попытка зачтена';

/** The engine itself did not answer: the attempt is not spent, the call never finished. */
export const ENGINE_SILENT_LINE = 'движок не ответил — попытка не завершилась';

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
export * from './liveWords.ts';
