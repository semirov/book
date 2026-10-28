import { describe, expect, it } from 'vitest';

import {
  documentInstances,
  movedComponents,
  norm,
  STATUS_VERBS,
} from '../../../src/ledger/graph/components.ts';

/**
 * The four names of BOOK-DOC-75 §1.2, each on a sentence from the book's own register, and the
 * answer that matters most: an edit that moved nothing must move nothing.
 */
describe('movedComponents — which component of a fact an edit moved', () => {
  it('value: a digit or a date changed', () => {
    expect([...movedComponents('Срок — тридцать дней.', 'Срок — сорок пять дней.')]).toEqual([]);
    expect([...movedComponents('Срок исполнения 30 дней.', 'Срок исполнения 45 дней.')]).toEqual(['value']);
    expect([...movedComponents('Акт от 14.09.2065.', 'Акт от 15.09.2065.')]).toEqual(['value']);
    expect([...movedComponents('Блоки в 1-04.', 'Блоки в 1-05.')]).toEqual(['value']);
  });

  it('identity: the noun plus its number names another paper', () => {
    expect([...movedComponents('Акт 4-У подшит в дело.', 'Акт 5-У подшит в дело.')]).toEqual(['value', 'identity']);
    expect([...movedComponents('Протокол 14-УП выдан.', 'Протокол 15-УП выдан.')]).toEqual(['value', 'identity']);
    // A bucket (a noun with no number) is not an identity — one class replaced by another is a
    // thing that stopped existing, nothing more.
    expect([...movedComponents('Заявление лежит в деле.', 'Акт лежит в деле.')]).toEqual(['existence']);
    // Dropping the number is an instance leaving the book.
    expect([...movedComponents('Акт 4-У лежит в деле.', 'Акт лежит в деле.')]).toEqual(['value', 'identity']);
  });

  it('status: a verb of the closed list changed', () => {
    expect([...movedComponents('Акт 65/11877/арх выдан.', 'Акт 65/11877/арх аннулирован.')]).toEqual(['status']);
    expect([...movedComponents('Приказ подписан.', 'Приказ отозван.')]).toEqual(['status']);
    expect(STATUS_VERBS).toContain('выдан');
    expect(STATUS_VERBS).toContain('утратил');
  });

  it('existence: a thing the removed text named is gone from the new text', () => {
    expect([...movedComponents('Ковалёв вошёл в комнату.', 'Он вошёл в комнату.')]).toEqual(['existence']);
    expect([...movedComponents('Справка лежала в деле.', 'Бумага лежала в деле.')]).toEqual(['existence']);
    // An inflection is not a loss: the word is still there.
    expect([...movedComponents('Акт лежал в деле.', 'Акты лежали в деле.')]).toEqual([]);
  });

  it('moves nothing for an identical text, a comma, or a change of tone', () => {
    expect([...movedComponents('Он сказал сухо.', 'Он сказал сухо.')]).toEqual([]);
    expect([...movedComponents('Он сказал сухо, и вышел.', 'Он сказал сухо и вышел.')]).toEqual([]);
    expect([...movedComponents('Он сказал сухо.', 'Он сказал суше.')]).toEqual([]);
    expect([...movedComponents('', '')]).toEqual([]);
  });
});

describe('the closed vocabulary is exported, not guessed', () => {
  it('documentInstances reads the instance, not the noun', () => {
    const found = documentInstances('Протокол 14-УП и акт 65/11877/арх лежали рядом, а заявление — нет.');
    expect(found.map((instance) => instance.key)).toEqual([
      'протокол 14-уп',
      'акт 65/11877/арх',
      'заявление',
    ]);
  });

  it('norm folds case, ё and whitespace once, for both sides of an edit', () => {
    expect(norm('  Ёлка   Зелёная ')).toBe('елка зеленая');
  });
});
