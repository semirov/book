/**
 * The v1 evidence, replayed as fixtures (BOOK-185, BOOK-DOC-77 §3).
 *
 * The first live pass on ch01–ch05 produced three defects the schema could not see: a place
 * registered as a `name`, a quote that did not contain the value it was offered for, and a
 * document key whose words lost their spaces. This file is the record of each one, with the
 * smallest block of prose that states it.
 *
 * What the validator can and cannot do is part of the record: it can refuse a name that carries a
 * digit (a room, a street number), and it cannot tell that `Калининград` is a city — that
 * classification is the prompt's job (`prompt.ts` §2), and the test below says so instead of
 * pretending the gate is stronger than it is.
 */

import { describe, expect, it } from 'vitest';

import { documentKey, keyOf } from '../../src/graph/keys.ts';
import { monthOf, supportCore, supportProblem } from '../../src/graph/quote.ts';
import { mergeRecall } from '../../src/graph/recall.ts';
import type { LooseAnswer } from '../../src/graph/schema.ts';
import { validateAnswer, type Block, type ValidateResult } from '../../src/graph/validate.ts';

/** One block per defect, each its own sentence so a quote is never split across a paragraph. */
export const BLOCKS: Block[] = [
  { id: 's1', text: '— Андрюш, я вчера разговаривала с Любой из ЖЭКа, она назвала бланк номер один-четыре.' },
  { id: 's2', text: 'Я подписал.' },
  { id: 's3', text: 'Я подписал поправку.' },
  { id: 's4', text: 'Дело закрыто.' },
  { id: 's5', text: 'Заявление о прекращении лежит в архиве.' },
  { id: 's6', text: 'Дата в акте — четырнадцатое сентября.' },
  { id: 's7', text: 'Печать и подпись на месте.' },
  { id: 's8', text: 'Билет до Калининграда лежал в кармане.' },
  { id: 's9', text: 'Комната 1-04 на втором этаже.' },
  { id: 's10', text: 'Он посмотрел мой паспорт и вернул его.' },
  { id: 's11', text: 'Отзыв не подавался.' },
  // The live ch15 refusal of v2: a four-letter object, written in another case.
  { id: 's12', text: 'Я подписал свою явку.' },
];

function run(facts: LooseAnswer['facts']): ValidateResult {
  return validateAnswer({
    chapter: 5,
    blocks: BLOCKS,
    established: [],
    threads: [],
    answer: { facts, uses: [], edges: [], threads: [] },
  });
}

const JEK_QUOTE = 'Андрюш, я вчера разговаривала с Любой из ЖЭКа';

describe('a name is a person, and the validator only sees digits', () => {
  it('accepts a place as a name: the prompt has to refuse it, not the form check', () => {
    const result = run([{ kind: 'name', value: 'Калининград', quote: 'Билет до Калининграда' }]);
    expect(result.rejects).toEqual([]);
    expect(result.facts[0]?.key).toBe('name:калининград');
  });

  it('refuses a name that carries a number, because a room and a house are not people', () => {
    const result = run([{ kind: 'name', value: 'комната 1-04', quote: 'Комната 1-04 на втором этаже' }]);
    expect(result.facts).toEqual([]);
    expect(result.rejects.map((reject) => reject.code)).toEqual(['VALUE_UNPARSEABLE']);
    expect(keyOf('name', 'Полярная 4')).toEqual({ ok: false });
  });

  it('matches a name by its stem, so an inflected telling is the same person', () => {
    expect(supportProblem('name', 'name:пенькова', 'Допрос вела Пенькову')).toBeNull();
    expect(supportProblem('name', 'name:пенькова', 'В комнате никого не было')).toContain('name');
  });
});

describe('the quote must prove the value it is offered for', () => {
  it('refuses the v1 document whose quote is a ЖЭК sentence', () => {
    const result = run([{ kind: 'document', value: 'один-четыре', quote: JEK_QUOTE }]);
    expect(result.facts).toEqual([]);
    expect(result.rejects).toHaveLength(1);
    expect(result.rejects[0]).toMatchObject({ code: 'QUOTE_DOES_NOT_SUPPORT_VALUE', path: 'facts[0]', quote: JEK_QUOTE });
    expect(result.rejects[0]?.item).toMatchObject({ value: 'один-четыре' });
    expect(result.rejects[0]?.reason).toContain('document number');
  });

  it('accepts the same document when the quote carries it', () => {
    const result = run([{ kind: 'document', value: 'один-четыре', quote: 'бланк номер один-четыре' }]);
    expect(result.rejects).toEqual([]);
    expect(result.facts[0]?.key).toBe('document:один-четыре');
  });

  it('refuses a decision whose object the sentence never names', () => {
    const result = run([{ kind: 'decision', value: 'подписать@поправка', quote: 'Я подписал.' }]);
    expect(result.facts).toEqual([]);
    expect(result.rejects.map((reject) => reject.code)).toEqual(['QUOTE_DOES_NOT_SUPPORT_VALUE']);
    expect(result.rejects[0]?.reason).toContain('object');
  });

  it('accepts the decision when the object is in the quote', () => {
    const result = run([{ kind: 'decision', value: 'подписать@поправка', quote: 'Я подписал поправку.' }]);
    expect(result.rejects).toEqual([]);
    expect(result.facts[0]?.key).toBe('decision:подписать@поправка');
  });

  it('refuses an absence whose ended state the text does not use', () => {
    const result = run([{ kind: 'absence', value: 'дело@существование', quote: 'Дело закрыто.' }]);
    expect(result.facts).toEqual([]);
    expect(result.rejects.map((reject) => reject.code)).toEqual(['QUOTE_DOES_NOT_SUPPORT_VALUE']);
    expect(result.rejects[0]?.reason).toContain('absence');
  });

  it('accepts the absence when the ended state is a word the text says', () => {
    const result = run([{ kind: 'absence', value: 'дело@закрыто', quote: 'Дело закрыто.' }]);
    expect(result.rejects).toEqual([]);
    expect(result.facts[0]?.key).toBe('absence:дело@закрыто');
  });

  it('accepts a four-letter object in another case: the live ch15 «свою явку»', () => {
    const result = run([{ kind: 'decision', value: 'подписать@явка', quote: 'Я подписал свою явку' }]);
    expect(result.rejects).toEqual([]);
    expect(result.facts[0]?.key).toBe('decision:подписать@явка');
  });

  it('accepts a date written in words through its month', () => {
    const result = run([{ kind: 'date', value: '2065-09-14', quote: 'Дата в акте — четырнадцатое сентября' }]);
    expect(result.rejects).toEqual([]);
    expect(result.facts[0]?.key).toBe('date:2065-09-14');
    expect(monthOf('сентября')).toBe(9);
  });

  it('refuses a date whose quote states no date at all', () => {
    const result = run([{ kind: 'date', value: '2065-09-14', quote: 'Печать и подпись на месте' }]);
    expect(result.facts).toEqual([]);
    expect(result.rejects.map((reject) => reject.code)).toEqual(['QUOTE_DOES_NOT_SUPPORT_VALUE']);
  });
});

describe('a date is the same day and the same month', () => {
  // BOOK-185 defect 5: `hasMonthWord` alone «proved» any date in a quote with any month word, so a
  // fabricated value passed the guard the redesign exists for.
  it('accepts the numeric form, with the year', () => {
    expect(supportProblem('date', 'date:2065-09-14', 'Акт датирован 14.09.2065.')).toBeNull();
    expect(supportProblem('date', 'date:2065-09-14', 'Акт датирован 2065-09-14.')).toBeNull();
  });

  it('accepts the word form when the day and the month both match', () => {
    expect(supportProblem('date', 'date:2065-09-14', 'Дата в акте — четырнадцатое сентября')).toBeNull();
    expect(supportProblem('date', 'date:2065-09-14', 'Акт от 14-го сентября.')).toBeNull();
    expect(supportProblem('date', 'date:2065-09-14', 'Акт от четырнадцатого сентября.')).toBeNull();
    expect(supportProblem('date', 'date:--09-14', 'Акт от четырнадцатое сентября.')).toBeNull();
    // A two-word day, and the day written after the month.
    expect(supportProblem('date', 'date:2065-09-21', 'Акт от двадцать первого сентября.')).toBeNull();
    expect(supportProblem('date', 'date:2065-09-14', 'Акт от сентября 14-го.')).toBeNull();
  });

  it('refuses a word date of another month, however plausible', () => {
    expect(supportProblem('date', 'date:2065-09-14', 'Третьего мая он ушёл.')).not.toBeNull();
    expect(supportProblem('date', 'date:2065-09-14', 'В сентябре он ушёл.')).not.toBeNull();
  });

  it('refuses a word date of another day in the right month', () => {
    expect(supportProblem('date', 'date:2065-09-14', 'Акт от пятнадцатого сентября.')).not.toBeNull();
    expect(supportProblem('date', 'date:2065-09-14', 'Акт от 13.09.2065.')).not.toBeNull();
  });

  it('refuses a numeric date whose year is another one', () => {
    expect(supportProblem('date', 'date:2065-09-14', 'Акт от 14.09.2064.')).not.toBeNull();
    expect(supportProblem('date', 'date:2065-09-14', 'Акт от 12.03.2065.')).not.toBeNull();
  });

  it('proves a promise deadline by the same matcher', () => {
    expect(supportProblem('promise', 'promise:вернуться@--02-19', 'Обещал вернуться 19.02.')).toBeNull();
    expect(supportProblem('promise', 'promise:вернуться@--02-19', 'Обещал вернуться девятнадцатого февраля.')).toBeNull();
    expect(supportProblem('promise', 'promise:вернуться@--02-19', 'Обещал вернуться к августу.')).not.toBeNull();
  });

  it('refuses a document number that is part of a longer one', () => {
    expect(supportProblem('document', 'document:12', 'Приказ 121 подшит.')).not.toBeNull();
    expect(supportProblem('document', 'document:12', 'Приказ 112 подшит.')).not.toBeNull();
    expect(supportProblem('document', 'document:12', 'Приказ 12 подшит.')).toBeNull();
    expect(supportProblem('document', 'document:', 'Приказ 12 подшит.')).not.toBeNull();
  });

  it('refuses a re-labelled use whose quote does not prove the value', () => {
    // A `use` of a key this answer asserts becomes a mention, and a mention used to skip the
    // support question: the quote still has to prove the value it is offered for.
    const result = validateAnswer({
      chapter: 5,
      blocks: BLOCKS,
      established: [],
      threads: [],
      answer: {
        facts: [{ kind: 'document', value: 'один-четыре', quote: 'бланк номер один-четыре' }],
        uses: [{ kind: 'document', value: 'один-четыре', quote: 'Печать и подпись на месте' }],
        edges: [],
        threads: [],
      },
    });
    expect(result.rejects).toHaveLength(1);
    expect(result.rejects[0]).toMatchObject({
      code: 'QUOTE_DOES_NOT_SUPPORT_VALUE',
      path: 'uses[0]',
      quote: 'Печать и подпись на месте',
    });
    expect(result.facts.map((fact) => fact.role)).toEqual(['assert']);
    expect(result.uses).toEqual([]);
  });
});

describe('the v2 misreadings the prompt must refuse at classification, not at form', () => {
  // A passport and a pamphlet are things, and an act that did not happen is not an ended
  // existence — but «thing» against «document» is meaning, and this file judges form only. The
  // ruling lives in `prompt.ts` §2 (asserted in `prompt.test.ts`); these two tests say so instead
  // of letting a reader believe the validator is stricter than it is.
  it('accepts document:паспорт when the quote names a passport and no number', () => {
    const result = run([{ kind: 'document', value: 'паспорт', quote: 'посмотрел мой паспорт' }]);
    expect(result.rejects).toEqual([]);
    expect(result.facts[0]?.key).toBe('document:паспорт');
  });

  it('accepts absence:отзыв@не подавался, because a missing record parses as a half-fact', () => {
    const result = run([{ kind: 'absence', value: 'отзыв@не подавался', quote: 'Отзыв не подавался' }]);
    expect(result.rejects).toEqual([]);
    expect(result.facts[0]?.key).toBe('absence:отзыв@не подавался');
  });
});

describe('a use carries the same question as a fact', () => {
  const ESTABLISHED = [
    { id: 'fact_doc', key: 'document:65-11877-арх', kind: 'document' as const, chapter: 3, term: '65/11877/арх' },
  ];

  it('refuses a use whose quote never mentions the thing it claims to use', () => {
    const result = validateAnswer({
      chapter: 5,
      blocks: BLOCKS,
      established: ESTABLISHED,
      threads: [],
      answer: {
        facts: [],
        uses: [{ kind: 'document', value: '65/11877/арх', quote: 'Печать и подпись на месте' }],
        edges: [],
        threads: [],
      },
    });
    expect(result.uses).toEqual([]);
    expect(result.rejects.map((reject) => reject.code)).toEqual(['QUOTE_DOES_NOT_SUPPORT_VALUE']);
    expect(result.rejects[0]?.path).toBe('uses[0]');
  });

  it('accepts a use whose quote names the document', () => {
    const result = validateAnswer({
      chapter: 5,
      blocks: [{ id: 'u1', text: 'Он положил на стол дело № 65/11877/арх.' }],
      established: ESTABLISHED,
      threads: [],
      answer: {
        facts: [],
        uses: [{ kind: 'document', value: '65/11877/арх', quote: 'дело № 65/11877/арх' }],
        edges: [],
        threads: [],
      },
    });
    expect(result.rejects).toEqual([]);
    expect(result.uses[0]?.role).toBe('use');
    expect(result.uses[0]?.factId).toBe('fact_doc');
  });
});

describe('a document key keeps the words and their spaces', () => {
  it('normalises a number, a title and a hyphenated index', () => {
    expect(documentKey('65/11877/арх')).toBe('65-11877-арх');
    expect(documentKey('65 / 11877 / арх')).toBe('65-11877-арх');
    expect(documentKey('№ 65/11877/арх')).toBe('65-11877-арх');
    expect(documentKey('заявление о прекращении')).toBe('заявление о прекращении');
    expect(documentKey('А-039')).toBe('а-039');
  });

  it('makes the six spellings of a code one key, and leaves a title a title', () => {
    // BOOK-185 defect 4: `/` and a space between two parts of a code are one separator, so the
    // extract pass's `4-У/арх` and the recall's `4-У арх` are one document, not two.
    expect(documentKey('4-У/арх')).toBe('4-у-арх');
    expect(documentKey('4-У арх')).toBe('4-у-арх');
    expect(documentKey('65/11877/арх')).toBe('65-11877-арх');
    expect(documentKey('65 11877 арх')).toBe('65-11877-арх');
    expect(documentKey('заявление о прекращении')).toBe('заявление о прекращении');
    expect(documentKey('заявление 4-К')).toBe('заявление 4-к');
    expect(keyOf('document', '4-У/арх')).toEqual(keyOf('document', '4-У арх'));
  });

  it('refuses a document value with no letter and no digit left', () => {
    expect(documentKey('   ')).toBeNull();
    expect(documentKey('— —')).toBeNull();
    expect(keyOf('document', '/ /')).toEqual({ ok: false });
  });

  it('keeps the spaces in the key and matches the same words in the quote', () => {
    expect(keyOf('document', 'Заявление   о прекращении')).toEqual({
      ok: true,
      key: 'document:заявление о прекращении',
    });
    const result = run([
      { kind: 'document', value: 'заявление о прекращении', quote: 'Заявление о прекращении лежит в архиве' },
    ]);
    expect(result.rejects).toEqual([]);
    expect(result.facts[0]?.key).toBe('document:заявление о прекращении');
    // The v1 key form is the same fact: the comparison is on the alphanumeric core.
    expect(supportCore('заявление о прекращении')).toBe(supportCore('заявлениеопрекращении'));
    expect(supportProblem('document', 'document:заявлениеопрекращении', 'Заявление о прекращении')).toBeNull();
  });
});

describe('a restatement is a mention, never a second fact', () => {
  it('collapses two keys of one core value inside one answer', () => {
    const result = run([
      { kind: 'document', value: 'один-четыре', quote: 'бланк номер один-четыре' },
      { kind: 'document', value: 'один четыре', quote: 'бланк номер один-четыре' },
    ]);
    expect(result.rejects).toEqual([]);
    expect(result.facts.map((fact) => [fact.key, fact.role])).toEqual([
      ['document:один-четыре', 'assert'],
      ['document:один-четыре', 'mention'],
    ]);
    expect(result.duplicates.facts).toBe(1);
  });

  it('collapses a recall restatement that arrives under another key', () => {
    const first = run([
      { kind: 'document', value: 'заявление о прекращении', quote: 'Заявление о прекращении лежит в архиве' },
    ]);
    const recall = run([
      { kind: 'document', value: 'заявлениеопрекращении', quote: 'Заявление о прекращении лежит в архиве' },
    ]);
    expect(recall.facts[0]?.key).toBe('document:заявлениеопрекращении');

    const merged = mergeRecall({ chapter: 5, first, recall });
    expect(merged.added.facts).toBe(0);
    expect(merged.answer.facts.map((fact) => [fact.key, fact.role])).toEqual([
      ['document:заявление о прекращении', 'assert'],
      ['document:заявление о прекращении', 'mention'],
    ]);
  });

  it('collapses a recall restatement that arrives with the same quote', () => {
    const first = run([
      { kind: 'document', value: 'заявление о прекращении', quote: 'Заявление о прекращении лежит в архиве' },
    ]);
    const recall = run([{ kind: 'document', value: 'заявление', quote: 'Заявление о прекращении лежит в архиве' }]);
    expect(recall.facts[0]?.key).toBe('document:заявление');

    const merged = mergeRecall({ chapter: 5, first, recall });
    expect(merged.added.facts).toBe(0);
    expect(merged.answer.facts[1]).toMatchObject({ key: 'document:заявление о прекращении', role: 'mention' });
  });
});
