/**
 * BOOK-DOC-84 §10.9/§11.1 — the copy contract of the live page over its whole output, and the
 * head line's grammar. Split from `stateWords.test.ts` at the arch bound.
 */

import { describe, expect, it } from 'vitest';

import {
  HEAD_WORDS,
  HEAD_WORD_OF,
  WIDENED_CODES,
  aheadDigitsWord,
  aheadWord,
  CAPACITY_HEAD_WORD,
  offlineWord,
  attemptWord,
  chapterAccusativeWord,
  chapterWord,
  clockWord,
  editionWord,
  filingWord,
  gateRoundWord,
  headAttemptWord,
  headFixWord,
  headLineWord,
  isWidenedCode,
  minutesWord,
  moneyWord,
  NOW_VERBS,
  visibleLineWord,
  widenedWord,
  type LinePart,
} from '../src/stateWords.ts';


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

describe('§10.9 — the head words, with idle rendered as nothing', () => {
  it('keeps `idle` as an internal kind and prints no word for it', () => {
    // Owner, 2026-10-29: «если ничего не происходит — строку не показываем». The key stays so
    // the derivation can name the state; its rendered value is empty, and nothing prints it.
    expect(HEAD_WORDS.idle).toBe('');
    expect(Object.values(HEAD_WORDS)).toEqual([
      '',
      'правку читают',
      'правка ждёт',
      'главу пишут',
      'главу проверяют',
      'внесено',
      'связи нет',
    ]);
  });

  it('maps every derived kind to a word, and idle/defect to the empty internal kind', () => {
    for (const kind of Object.keys(HEAD_WORD_OF) as (keyof typeof HEAD_WORD_OF)[]) {
      if (kind === 'тихо' || kind === 'сбой') expect(HEAD_WORDS[HEAD_WORD_OF[kind]]).toBe('');
      else expect(HEAD_WORDS[HEAD_WORD_OF[kind]]).toBeTruthy();
    }
    expect(HEAD_WORDS[HEAD_WORD_OF['сбой']]).toBe('');
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
  });
});

describe('§11.1 — the head’s line', () => {
  it('prints the filing, the chapter, the edition and the gate in the book’s nouns', () => {
    expect(filingWord(12)).toBe('правка 012');
    expect(filingWord(7)).toBe('правка 007');
    expect(filingWord(1234)).toBe('правка 1234');
    // No row carried a number ⇒ the noun alone: a number nobody wrote is never invented.
    expect(filingWord(null)).toBe('правка');
    expect(filingWord(undefined)).toBe('правка');
    expect(chapterWord(1)).toBe('глава 1');
    expect(chapterAccusativeWord(7)).toBe('главу 7');
    expect(editionWord(1, 13)).toBe('глава 1, редакция 13');
    expect(headAttemptWord(1, 5)).toBe('попытка 1 из 5');
    expect(headAttemptWord(6, 6)).toBe('попытка 6 из 6');
    expect(headFixWord(2, 5)).toBe('поправка 2 из 5');
    expect(aheadDigitsWord(2)).toBe('впереди 2');
    expect(gateRoundWord('editor', 1)).toBe('редактор, раунд 1');
    expect(gateRoundWord('consultant', null)).toBe('консультант');
    expect(gateRoundWord('rights', 3)).toBe('права, раунд 3');
    expect(gateRoundWord(null, null)).toBe('');
  });

  it('composes the line and its parts from one place', () => {
    const parts: LinePart[] = [
      { text: 'машина читает правку', tail: { text: ' 012', drop: 'filing' } },
      { text: 'попытка 1 из 5' },
      { text: '17:04', drop: 'time' },
    ];
    expect(headLineWord(parts)).toBe('машина читает правку 012 · попытка 1 из 5 · 17:04');
    expect(visibleLineWord(parts, ['filing', 'time'])).toBe('машина читает правку · попытка 1 из 5');
    expect(visibleLineWord(parts)).toBe('машина читает правку 012 · попытка 1 из 5 · 17:04');
  });

  it('prints the clock in the site’s one timezone', () => {
    expect(clockWord(Date.parse('2026-10-29T14:04:00Z'))).toBe('17:04');
    expect(clockWord(Date.parse('2026-10-29T21:00:00Z'))).toBe('00:00');
    expect(clockWord(Number.NaN)).toBe('—');
  });

  it('holds the two rules over the whole range of every builder', () => {
    const bad: string[] = [];
    for (let n = 1; n <= 1_000; n += 1) {
      for (const text of [filingWord(n), chapterWord(n), chapterAccusativeWord(n), editionWord(n, n)]) {
        if (violationOf(text) !== null) bad.push(text);
      }
    }
    for (let n = 1; n <= 6; n += 1) {
      for (const text of [headAttemptWord(n, 5), headAttemptWord(n, 6), headFixWord(n, 5)]) {
        if (violationOf(text) !== null) bad.push(text);
      }
    }
    for (let n = 0; n <= 50; n += 1) {
      const text = aheadDigitsWord(n);
      if (violationOf(text) !== null) bad.push(text);
    }
    for (const gate of ['editor', 'consultant', 'rights']) {
      for (let round = 1; round <= 5; round += 1) {
        const text = gateRoundWord(gate, round);
        if (violationOf(text) !== null) bad.push(text);
      }
    }
    // Every minute of a day, so a two-digit hour and a midnight are covered too.
    for (let minute = 0; minute < 24 * 60; minute += 1) {
      const text = clockWord(Date.parse('2026-10-29T00:00:00Z') + minute * 60_000);
      if (/\d\s*\/\s*\d/u.test(text)) bad.push(text);
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });
});

describe('§11.1 — the connection’s words, in the vocabulary and nowhere else', () => {
  it('says nothing before the second failure, the fact from the second, the retry from the fourth', () => {
    expect(offlineWord(0)).toBeNull();
    expect(offlineWord(1)).toBeNull();
    expect(offlineWord(2)).toBe('связи нет');
    expect(offlineWord(3)).toBe('связи нет');
    expect(offlineWord(4)).toBe('связи нет · пробуем снова');
    expect(offlineWord(9)).toBe('связи нет · пробуем снова');
  });

  it('names the connection the same way the head’s deck does, so one fact has one word', () => {
    expect(NOW_VERBS.offline).toBe(HEAD_WORDS.offline);
  });

  it('gives the full hall its own word: no lost connection, no machine noun', () => {
    // The plate says there are no seats and the page waits for one (`stateWords.ts`
    // `CAPACITY_PLATE`); the head says the same thing short, and never «связи нет».
    expect(CAPACITY_HEAD_WORD).toBe('мест нет · ждём места');
    expect(CAPACITY_HEAD_WORD).not.toContain('связи нет');
    assertHuman(CAPACITY_HEAD_WORD);
    for (const attempts of [2, 3, 4, 6]) assertHuman(offlineWord(attempts) ?? '');
  });
});
