import { INTERVENTION_KINDS } from '@book/shared';

import { describe, expect, it } from 'vitest';

import { KIND_MEANINGS, kindChoices, NOTE_KIND_LABEL, NOTE_KIND_MEANING } from './kindChoices.ts';

describe('the kind rows of the form', () => {
  it('names four kinds and one quiet fifth row, all with a meaning', () => {
    const rows = kindChoices();
    expect(rows).toHaveLength(INTERVENTION_KINDS.length + 1);
    expect(rows.at(-1)).toEqual({ id: null, label: NOTE_KIND_LABEL, meaning: NOTE_KIND_MEANING });
    for (const kind of INTERVENTION_KINDS) expect(KIND_MEANINGS[kind].length).toBeGreaterThan(20);
  });

  it('says of the note row that it spends nothing: no write, no wave, no day edit (BOOK-59)', () => {
    // The reader has just spent the day's edit, or is about to: the quiet row must say which.
    expect(NOTE_KIND_MEANING).toBe('сказать о тексте, ничего не внося · правку дня не тратит');
    const meaning = NOTE_KIND_MEANING.toLowerCase();
    expect(meaning).not.toContain('волн');
    expect(meaning).not.toContain('проверк');
  });

  it('describes what appears in the book, not what is being fixed', () => {
    expect(kindChoices()[0]?.meaning).toContain('в книге появится бумага');
    expect(kindChoices().map((row) => row.label)).toEqual([
      'документ',
      'решение героя',
      'свидетельство',
      'стёртая деталь',
      'просто замечание — без типа',
    ]);
  });
});
