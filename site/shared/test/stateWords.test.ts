import { describe, expect, it } from 'vitest';

import { HARM_CASES } from '../src/disposition.ts';
import {
  ATTEMPT_LINE,
  ENGINE_SILENT_LINE,
  FAILURE_LINES,
  lockLine,
  outcomeLine,
  parseOutcomeLine,
  CAPACITY_PLATE,
  DROPPED_LINES,
  FAILED_ATTEMPT_LINE,
  OWN_WAITING_LINE,
  PASS_STOPS,
  REFUSAL_LINE,
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
    // BOOK-219's register: an attempt is a **count** (`attempt.ts`), so no attempt line may
    // promise a wait — the record carries the number, and only the counter decides the end.
    expect(FAILED_ATTEMPT_LINE).not.toBe(STOP_REASONS.stopped);
    expect(FAILED_ATTEMPT_LINE).not.toBe(STOP_REASONS.shape);
    expect(ATTEMPT_LINE).not.toBe(FAILED_ATTEMPT_LINE);
    expect(ATTEMPT_LINE.length).toBeGreaterThan(0);
    // The retired words are the owner's list: main's own line may say «ждёт» — what it may not do
    // is promise a queue, a cap or a halt.
    for (const line of [FAILED_ATTEMPT_LINE, ATTEMPT_LINE, ENGINE_SILENT_LINE]) {
      expect(line).not.toMatch(/в очереди|исчерпано|остановлено/u);
    }
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
    for (const key of ['shape', 'modelTimeout', 'modelDown', 'truncated', 'answerRejected', 'engineDown'] as const) {
      expect(STOP_REASONS[key], key).toMatch(/^не дошло: /u);
      expect(STOP_REASONS[key], key).toContain('правка не отклонена');
    }
    expect(STOP_REASONS.modelTimeout).toContain('не успели');
    // One sentence per fact: the refusal line IS the register's own — a second line for the same
    // fact is how a record starts lying.
    expect(REFUSAL_LINE).toBe(STOP_REASONS.refusal);
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
      // BOOK-219: the harm lock's four cases are four sentences, so it is walked case by case.
      for (const harmCase of lock === 'harm' ? HARM_CASES : ([null] as const)) {
        const line = outcomeLine({ kind: 'lock', lock, harmCase });
        // The lock decides the sentence, word for word.
        expect(line).toBe(lockLine(lock, harmCase));
        expect(parseOutcomeLine(line)).toEqual(
          harmCase === null ? { kind: 'lock', lock } : { kind: 'lock', lock, harmCase },
        );
        expect(line).not.toContain('прочитали как');
        seen.push(line);
      }
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
  });
});
