import { describe, expect, it } from 'vitest';

import {
  ATTEMPT_LINE,
  HEAD_WORDS,
  HEAD_WORD_OF,
  WIDENED_CODES,
  aheadWord,
  attemptWord,
  isWidenedCode,
  minutesWord,
  moneyWord,
  widenedWord,
  FAILURE_LINES,
  LOCK_LINES,
  outcomeLine,
  parseOutcomeLine,
  CAPACITY_PLATE,
  DROPPED_LINES,
  FAILED_ATTEMPT_LINE,
  OWN_WAITING_LINE,
  PASS_STOPS,
  PREMISE_LINES,
  STATE_LINES,
  STATE_WORDS,
  STOP_REASONS,
  TOO_MANY_FILINGS,
  chapterLine,
  droppedLine,
  landedSentence,
  landedTail,
  premiseLandedLine,
  pushAccepted,
  pushLanded,
  pushRefused,
  registrationLine,
  reviseLine,
  stopReason,
  stopReasonKey,
  turnLine,
  waitingLine,
} from '../src/stateWords.ts';
import { outcomeOfChain } from '../src/disposition.ts';
import { WAITING_FOR_CHAPTER_LINE, ordinalWord, queueLine } from '../src/naming.ts';

/**
 * BOOK-218 — the reader's vocabulary, line by line (BOOK-DOC-82).
 *
 * The module is the only place a state word or a state line is spelled, so this file pins each
 * helper the surfaces call: the word, the line under it, the thread's sentence, a change's turn,
 * the attempt lines, the reasons a stopped pass leaves, and the notification titles. A copy
 * change that skips a surface fails here before it reaches a reader.
 */

describe('the second line under a state word', () => {
  it('names the reader’s own wait, and anyone’s', () => {
    expect(waitingLine(true)).toBe(OWN_WAITING_LINE);
    expect(waitingLine(false)).toBe(STATE_LINES.waiting);
    expect(OWN_WAITING_LINE).toBe(`ваша — ${STATE_LINES.waiting}`);
  });

  it('names the chapter a change is writing, landed or not', () => {
    expect(chapterLine(7)).toBe('глава 7');
    // BOOK-218 line 10 — the landing's fact, in words: the edition never prints as a digit.
    expect(landedTail(7)).toBe('в главу 7');
    expect(landedTail(7, 4)).toBe('в главу 7. это четвёртая редакция');
    expect(landedSentence(1, 3)).toBe('внесено в главу 1. это третья редакция');
    expect(premiseLandedLine(7)).toBe('вошло в первую редакцию главы 7');
  });

  it('says a count and a bound in words, and shortens the tail past its own range', () => {
    // `впереди две` (line 6) and `из пяти` (line 9) are the module's own word forms.
    expect(turnLine(3)).toBe('правка ждёт своей минуты: впереди две');
    expect(turnLine(21)).toBe('правка ждёт своей минуты: впереди двадцать');
    // Past the range the tail is shortened, and the reason stays.
    expect(turnLine(23)).toBe('правка ждёт своей минуты');
    expect(reviseLine(2, 5)).toBe('редактор просит поправить одно место · вторая поправка из пяти');
    expect(reviseLine(9, 10)).toBe('редактор просит поправить одно место · девятая поправка из десяти');
    // A count the module cannot say in words is not printed as a digit.
    expect(reviseLine(2, 11)).toBe('редактор просит поправить одно место');
    expect(ordinalWord(1)).toBe('первая');
    expect(ordinalWord(20)).toBe('двадцатая');
    expect(ordinalWord(21)).toBe('двадцать первая');
    expect(ordinalWord(67)).toBe('шестьдесят седьмая');
    expect(ordinalWord(0)).toBeNull();
    expect(ordinalWord(100)).toBeNull();
    expect(ordinalWord(2.5)).toBeNull();
    // An edition the book cannot name in words keeps the chapter and drops the edition.
    expect(landedTail(7, 100)).toBe('в главу 7');
  });

  it('keeps the two ways a filing is dropped apart', () => {
    expect(droppedLine('superseded')).toBe(DROPPED_LINES.superseded);
    expect(droppedLine('expired')).toBe(DROPPED_LINES.expired);
    expect(DROPPED_LINES.superseded).not.toBe(DROPPED_LINES.expired);
  });

  it('names the paperwork’s mode, and defaults to the book’s own', () => {
    expect(registrationLine('поправка')).toBe('поправка · фраза не изменилась');
    expect(registrationLine()).toBe('оформление · фраза не изменилась');
  });

  it('keeps a premise’s four lines on one vocabulary', () => {
    expect(PREMISE_LINES.pendingSentence).toBe(`${STATE_WORDS.accepted} в основу · до первой редакции`);
    expect(PREMISE_LINES.supersededSentence).toBe(`${STATE_WORDS.dropped}: ${PREMISE_LINES.superseded}`);
    expect(PREMISE_LINES.refused).not.toBe(PREMISE_LINES.superseded);
  });
});

describe('the lines the other surfaces print', () => {
  it('says how many filings are in work, never a queue place (BOOK-218 §5)', () => {
    // The owner's latest words, ordered after the table was written: they are the module's.
    expect(queueLine(0)).toBe('правок в работе нет');
    expect(queueLine(1)).toBe('в работе 1 правка');
    expect(queueLine(3)).toBe('в работе 3 правки');
    expect(queueLine(11)).toBe('в работе 11 правок');
    // A depth that is not a number is no depth at all.
    expect(queueLine(Number.NaN)).toBe(queueLine(0));
    expect(queueLine(-4)).toBe(queueLine(0));
    for (const depth of [0, 1, 3, 11]) expect(queueLine(depth)).not.toContain('очеред');
  });

  it('gives a change its turn, the next one first (BOOK-218 line 6)', () => {
    // The sentence is the owner's; the count is the tail, and it is said in words.
    expect(turnLine(1)).toBe('правка ждёт своей минуты');
    expect(turnLine(0)).toBe('правка ждёт своей минуты');
    expect(turnLine(null)).toBe('правка ждёт своей минуты');
    // `position` is the place among the filings in work, so two are ahead of the third.
    expect(turnLine(2)).toBe('правка ждёт своей минуты: впереди одна');
    expect(turnLine(3)).toBe('правка ждёт своей минуты: впереди две');
    expect(turnLine(6)).toBe('правка ждёт своей минуты: впереди пять');
    // Past twenty ahead the tail is dropped, and the reason stays.
    expect(turnLine(30)).toBe('правка ждёт своей минуты');
    for (const position of [1, 2, 3, 6]) expect(turnLine(position)).not.toContain('очеред');
  });

  it('keeps the attempt lines distinct: a machine that could not, and nothing usable', () => {
    // An attempt the filing survived is not a stopped pass: the filing keeps its word and the
    // retry is promised, while a park stops the edit for good (BOOK-219).
    expect(FAILED_ATTEMPT_LINE).not.toBe(STOP_REASONS.stopped);
    expect(FAILED_ATTEMPT_LINE).toContain('правка ждёт');
    expect(ATTEMPT_LINE).not.toBe(FAILED_ATTEMPT_LINE);
    expect(ATTEMPT_LINE).toContain('правка ждёт');
    expect(TOO_MANY_FILINGS).not.toContain('очеред');
    expect(CAPACITY_PLATE).toContain('ждёте места');
    expect(WAITING_FOR_CHAPTER_LINE).toBe('ждёт своей главы');
  });

  it('names the four fields a notification may carry, and nothing else', () => {
    expect(pushLanded(7)).toBe('глава 7 написана');
    expect(pushAccepted(7)).toBe('правка по главе 7 принята');
    expect(pushRefused(7)).toBe('правка по главе 7 отклонена');
    for (const title of [pushLanded(7), pushAccepted(7), pushRefused(7)]) {
      expect(title).not.toMatch(/[A-Z]{2,}_[A-Z]/u);
    }
  });
});

describe('the reason a stopped pass leaves', () => {
  it('maps every family of engine code onto one sentence', () => {
    expect(stopReasonKey('PROVIDER_SHAPE')).toBe('shape');
    expect(stopReasonKey('PROVIDER_TIMEOUT')).toBe('modelTimeout');
    expect(stopReasonKey('PROVIDER_UNREACHABLE')).toBe('modelDown');
    expect(stopReasonKey('PROVIDER_HTTP_500')).toBe('modelDown');
    expect(stopReasonKey('ANSWER_TRUNCATED')).toBe('truncated');
    expect(stopReasonKey('ANSWER_REFUSAL')).toBe('refusal');
    expect(stopReasonKey('ANSWER_UNPARSED')).toBe('answerRejected');
    expect(stopReasonKey('ENGINE_TIMEOUT')).toBe('engineDown');
    expect(stopReasonKey('DB_BUSY')).toBe('engineDown');
    expect(stopReasonKey('RIGHTS_REFUSED')).toBe('rightsMissing');
    expect(stopReasonKey('FRAME_CHANGED')).toBe('frameChanged');
    expect(stopReasonKey('STEP_CLOSED')).toBe('stepClosed');
    // A code the table does not know is not a sentence: the generic stop stands.
    expect(stopReasonKey('SOMETHING_ELSE')).toBeNull();
    expect(stopReason('SOMETHING_ELSE')).toBe(STOP_REASONS.stopped);
    expect(stopReason(null)).toBe(STOP_REASONS.stopped);
  });

  it('says what happened to the reader’s edit, never a code or a machine noun', () => {
    for (const sentence of [...Object.values(STOP_REASONS), ...Object.values(PASS_STOPS)]) {
      expect(sentence).not.toMatch(/[A-Z]{2,}_[A-Z]/u);
      expect(sentence).not.toContain('очеред');
      expect(sentence.length).toBeLessThanOrEqual(200);
    }
    // BOOK-218 — the only reason vocabulary: our failure (`не дошло`) and the edit not rejected.
    for (const key of ['shape', 'modelTimeout', 'modelDown', 'truncated', 'refusal', 'answerRejected', 'engineDown'] as const) {
      expect(STOP_REASONS[key], key).toMatch(/^не дошло: /u);
      expect(STOP_REASONS[key], key).toContain('правка не отклонена');
    }
    expect(STOP_REASONS.modelTimeout).toContain('не успели');
  });
});

describe('one reason line per outcome (BOOK-218, owner 2026-10-29)', () => {
  const readings = ['as_said', 'through_paper', 'refused_in_world'] as const;
  const locks = ['rights', 'harm', 'frame', 'finale'] as const;
  const failures = ['ourFailure', 'outOfTime', 'attemptsSpent'] as const;

  it('walks every outcome — 3 readings, 4 locks, 3 failures — and gives each exactly one line', () => {
    const seen: string[] = [];
    for (const reading of readings) {
      const carriers = reading === 'through_paper' ? ([null, 'registry_discrepancy'] as const) : ([null] as const);
      for (const carrierKind of carriers) {
        const line = outcomeLine({ kind: 'reading', reading, carrierKind });
        const outcome = parseOutcomeLine(line);
        expect(outcome, line).toMatchObject({ kind: 'reading', reading });
        // A reading is one sentence: no second verdict word inside it.
        expect(line.match(/не дошло|не принято/gu) ?? []).toHaveLength(0);
        expect(line.split('\n')).toHaveLength(1);
        seen.push(line);
      }
    }
    for (const lock of locks) {
      const line = outcomeLine({ kind: 'lock', lock });
      // The lock decides the sentence, word for word.
      expect(line).toBe(LOCK_LINES[lock]);
      expect(parseOutcomeLine(line)).toEqual({ kind: 'lock', lock });
      expect(line).not.toContain('прочитали как');
      seen.push(line);
    }
    for (const failure of failures) {
      const line = outcomeLine({ kind: 'failure', failure });
      expect(line).toBe(FAILURE_LINES[failure]);
      expect(parseOutcomeLine(line)).toEqual({ kind: 'failure', failure });
      // Our failure never carries a reading: the edit was not judged, so nothing was read.
      expect(line).not.toContain('прочитали как');
      seen.push(line);
    }
    // The vocabulary is closed and every sentence answers what happened and what to do.
    expect(new Set(seen).size).toBe(seen.length);
    for (const line of seen) expect(line.length).toBeGreaterThan(20);
    for (const line of Object.values(FAILURE_LINES)) expect(line).toContain('нажмите «повторить»');
  });

  it('lets a stored chain decide: a lock names itself, a chain with no lock is our failure', () => {
    expect(outcomeOfChain({ disposition: 'inadmissible', lock: 'finale', carrierKind: null })).toEqual({
      kind: 'lock',
      lock: 'finale',
    });
    expect(outcomeOfChain({ disposition: 'inadmissible', lock: null, carrierKind: null })).toEqual({
      kind: 'failure',
      failure: 'ourFailure',
    });
    expect(outcomeOfChain({ disposition: 'through_paper', lock: null, carrierKind: 'speech' })).toEqual({
      kind: 'reading',
      reading: 'through_paper',
      carrierKind: 'speech',
    });

/* ── BOOK-DOC-84 §10.9 — the copy contract over the whole output ──────────────── */

/** The words a reader was promised never to see (§10.9). */
const MACHINE_NOUNS = [
  'модель',
  'LLM',
  'триаж',
  'вердикт',
  'гейт',
  'итерация',
  'сокет',
  'лейн',
  'очередь',
];

/** The counter is never printed as `2 / 5`. */
const SLASH_NUMBER = /\d\s*\/\s*\d/u;

/** Every rule violation in one string, or `null` — a range test asserts once, not per item. */
function violationOf(text: string): string | null {
  for (const noun of MACHINE_NOUNS) {
    if (text.toLowerCase().includes(noun.toLowerCase())) return `"${text}" names ${noun}`;
  }
  if (SLASH_NUMBER.test(text)) return `"${text}" prints a slash counter`;
  return null;
}

function assertHuman(text: string): void {
  expect(violationOf(text)).toBeNull();
}

describe('§10.9 — the seven head words', () => {
  it('are exactly the owner’s seven strings', () => {
    expect(Object.values(HEAD_WORDS)).toEqual([
      'тихо',
      'правку читают',
      'правка ждёт',
      'главу пишут',
      'главу проверяют',
      'внесено',
      'связи нет',
    ]);
  });

  it('map every derived kind to a head word, and a defect to `тихо`', () => {
    for (const kind of Object.values(HEAD_WORD_OF)) expect(HEAD_WORDS[kind]).toBeTruthy();
    expect(HEAD_WORDS[HEAD_WORD_OF['сбой']]).toBe('тихо');
  });

  it('all pass the two rules', () => {
    for (const word of Object.values(HEAD_WORDS)) assertHuman(word);
  });
});

describe('§10.9 — attempts 1..6', () => {
  it('print exactly the listed forms', () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => attemptWord(n, 5))).toEqual([
      'первая из пяти',
      'вторая из пяти',
      'третья из пяти',
      'четвёртая из пяти',
      'пятая из пяти',
      'последняя, шестая',
    ]);
  });

  it('take the fix noun for written text', () => {
    expect(attemptWord(3, 5, 'fix')).toBe('третья поправка из пяти');
    expect(attemptWord(4, 5, 'fix')).toBe('четвёртая поправка из пяти');
    expect(attemptWord(6, 6, 'fix')).toBe('последняя, шестая поправка');
  });

  it('a desperate sixth is the last of six, and every form is human', () => {
    expect(attemptWord(6, 6)).toBe('последняя, шестая');
    for (let n = 1; n <= 6; n += 1) {
      for (const form of ['attempt', 'fix'] as const) {
        for (const max of [5, 6]) assertHuman(attemptWord(n, max, form));
      }
    }
  });
});

describe('§10.9 — elapsed and waits', () => {
  it('uses whole words from a second to three days', () => {
    expect(minutesWord(0)).toBe('меньше минуты');
    expect(minutesWord(59_000)).toBe('меньше минуты');
    expect(minutesWord(60_000)).toBe('минута');
    expect(minutesWord(119_000)).toBe('минута');
    expect(minutesWord(2 * 60_000)).toBe('две минуты');
    expect(minutesWord(4 * 60_000)).toBe('четыре минуты');
    expect(minutesWord(5 * 60_000)).toBe('пять минут');
    expect(minutesWord(21 * 60_000)).toBe('двадцать одна минута');
    expect(minutesWord(60 * 60_000)).toBe('час');
    expect(minutesWord(2 * 60 * 60_000)).toBe('два часа');
    expect(minutesWord(5 * 60 * 60_000)).toBe('пять часов');
    expect(minutesWord(24 * 60 * 60_000)).toBe('сутки');
    expect(minutesWord(2 * 24 * 60 * 60_000)).toBe('двое суток');
    expect(minutesWord(3 * 24 * 60 * 60_000)).toBe('трое суток');
  });

  it('holds the rules across the whole range (0 s … 3 days, every step)', () => {
    const bad: string[] = [];
    for (let ms = 0; ms <= 3 * 24 * 60 * 60_000; ms += 60_000) {
      const text = minutesWord(ms);
      if (violationOf(text) !== null) bad.push(text);
    }
    expect(bad.slice(0, 5)).toEqual([]);
    // Every hour and every day boundary is covered too (the step above is one minute).
    for (const hours of [1, 2, 5, 11, 21, 23]) {
      expect(violationOf(minutesWord(hours * 60 * 60_000))).toBeNull();
    }
  });
});

describe('§10.9 — the queue', () => {
  it('names the place in words', () => {
    expect(aheadWord(0)).toBe('следом');
    expect(aheadWord(1)).toBe('впереди одна правка');
    expect(aheadWord(2)).toBe('впереди две правки');
    expect(aheadWord(3)).toBe('впереди три правки');
    expect(aheadWord(4)).toBe('впереди четыре правки');
    expect(aheadWord(5)).toBe('впереди пять правок');
    expect(aheadWord(21)).toBe('впереди двадцать одна правка');
  });

  it('holds the rules for 0..50', () => {
    const all = Array.from({ length: 51 }, (_, n) => aheadWord(n));
    expect(all.filter((text) => violationOf(text) !== null)).toEqual([]);
  });
});

describe('§10.9 — the price', () => {
  it('is two decimals, a comma and a space before the sign', () => {
    expect(moneyWord(0.05)).toBe('0,05 $');
    expect(moneyWord(1.2)).toBe('1,20 $');
    expect(moneyWord(0)).toBe('0,00 $');
  });

  it('keeps the estimate’s mark', () => {
    expect(moneyWord(0.05, true)).toBe('≈ 0,05 $');
  });

  it('holds the machine-noun rule for 0 … 100 $', () => {
    const bad: string[] = [];
    for (let cents = 0; cents <= 10_000; cents += 1) {
      const text = moneyWord(cents / 100, cents % 2 === 0);
      if (violationOf(text) !== null) bad.push(text);
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });
});

describe('§10.9 — the widening', () => {
  it('is the four human sentences', () => {
    expect(widenedWord('wider-edit')).toBe('правим шире: не строку, а абзац');
    expect(widenedWord('whole-chapter')).toBe('правим шире: всю главу');
    expect(widenedWord('as-document')).toBe('просим читать как документ');
    expect(widenedWord('stricter-check')).toBe('проверяем строже');
    expect(widenedWord('unknown')).toBe('');
  });

  it('validates codes instead of captioning anything', () => {
    for (const code of WIDENED_CODES) {
      expect(isWidenedCode(code)).toBe(true);
      assertHuman(widenedWord(code));
    }
    expect(isWidenedCode('переписывание вместо патча')).toBe(false);
