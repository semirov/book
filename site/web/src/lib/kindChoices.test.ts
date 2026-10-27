import { EDIT_MAX_CHARS, INTERVENTION_KINDS, INTERVENTION_KIND_LABELS } from '@book/shared';

import { describe, expect, it } from 'vitest';

import { formatNumber } from './format.ts';
import {
  FORM_BOUNDS_LINE,
  KIND_MEANINGS,
  KIND_PREMISE_PLACEHOLDERS,
  KIND_WORDING_LABELS,
  KIND_WORDING_PLACEHOLDERS,
  kindChoices,
  NOTE_ACTION_LABEL,
  NOTE_BUDGET_LINE,
  NOTE_FATE_LINE,
  NOTE_FIELD_LABEL,
  NOTE_PLACEHOLDER,
  PREMISE_LABEL,
  WORDING_LABEL_NEUTRAL,
  WORDING_PLACEHOLDER_NEUTRAL,
  wordingLabel,
  wordingPlaceholder,
} from './kindChoices.ts';

/**
 * BOOK-57 — the one copy table of the form.
 *
 * Every kind has a row in each shape (meaning, paragraph label, paragraph placeholder,
 * premise placeholder), so a kind that arrives without copy fails here instead of printing
 * a blank field. The note is not a row: it is a quiet action of its own, and nothing in the
 * grid claims it.
 */

const PARAGRAPH = { noteOnly: false, blockId: 'ch08#aa11bb22' } as const;
const PREMISE = { noteOnly: false, blockId: null } as const;
const NOTE = { noteOnly: true, blockId: 'ch08#aa11bb22' } as const;

describe('the rows of the grid', () => {
  it('has exactly one row per kind, and no fifth row', () => {
    const rows = kindChoices();
    expect(rows).toHaveLength(INTERVENTION_KINDS.length);
    expect(rows.map((row) => row.id)).toEqual([...INTERVENTION_KINDS]);
    for (const row of rows) expect(row.id).not.toBeNull();
  });

  it('names the four kinds in the book’s order', () => {
    expect(kindChoices().map((row) => row.label)).toEqual([
      'документ',
      'решение героя',
      'свидетельство',
      'стёртая деталь',
    ]);
  });

  it('gives every kind a non-empty entry in every shape', () => {
    for (const kind of INTERVENTION_KINDS) {
      expect(KIND_MEANINGS[kind].trim().length, kind).toBeGreaterThan(20);
      expect(KIND_WORDING_LABELS[kind].trim().length, kind).toBeGreaterThan(0);
      expect(KIND_WORDING_PLACEHOLDERS[kind].trim().length, kind).toBeGreaterThan(0);
      expect(KIND_PREMISE_PLACEHOLDERS[kind].trim().length, kind).toBeGreaterThan(0);
    }
  });

  it('asks a different question per kind: labels and placeholders are all distinct', () => {
    // One label, one placeholder, one premise placeholder per kind: a copy-pasted row would
    // pass a non-empty check and fail here.
    expect(new Set(Object.values(KIND_WORDING_LABELS)).size).toBe(INTERVENTION_KINDS.length);
    const placeholders = INTERVENTION_KINDS.map((kind) => KIND_WORDING_PLACEHOLDERS[kind]);
    expect(new Set(placeholders).size).toBe(INTERVENTION_KINDS.length);
    const premises = INTERVENTION_KINDS.map((kind) => KIND_PREMISE_PLACEHOLDERS[kind]);
    expect(new Set(premises).size).toBe(INTERVENTION_KINDS.length);
  });

  it('prints the deck’s own words, kind by kind', () => {
    expect(KIND_WORDING_LABELS.document).toBe('текст бумаги');
    expect(KIND_WORDING_LABELS.decision).toBe('решение и цена');
    expect(KIND_WORDING_LABELS.testimony).toBe('показание');
    expect(KIND_WORDING_LABELS.erasure).toBe('что уходит и что остаётся');

    expect(KIND_WORDING_PLACEHOLDERS.document).toBe('кто выдал · номер · кому адресован');
    expect(KIND_WORDING_PLACEHOLDERS.decision).toBe('кто решает · что решает · чем платит');
    expect(KIND_WORDING_PLACEHOLDERS.testimony).toBe('кто видел · что · чем подтверждается');
    expect(KIND_WORDING_PLACEHOLDERS.erasure).toBe('что уходит · что остаётся на его месте');

    expect(KIND_PREMISE_PLACEHOLDERS.document).toBe('какая бумага открывает главу · кто выдал · номер');
    expect(KIND_PREMISE_PLACEHOLDERS.decision).toBe('кто решает в начале главы · что · чем платит');
    expect(KIND_PREMISE_PLACEHOLDERS.testimony).toBe('кто свидетель · что видел · чем подтверждается');
    expect(KIND_PREMISE_PLACEHOLDERS.erasure).toBe('что уходит из главы · что остаётся вместо');
  });

  it('says what appears in the book, and the testimony line is the changed one', () => {
    expect(KIND_MEANINGS.document).toBe('в книге появится бумага: акт, справка, протокол — с номером и подписью');
    expect(KIND_MEANINGS.decision).toBe('человек решает иначе: назовите решение и его цену');
    expect(KIND_MEANINGS.testimony).toBe('свидетель видел: показание, запись, то, чего в книге не было');
    expect(KIND_MEANINGS.erasure).toBe('из книги уходит деталь: назовите её и что останется на её месте');
  });

  it('claims no kind for the note: no row carries a note word', () => {
    for (const row of kindChoices()) {
      const text = `${row.label} ${row.meaning}`.toLowerCase();
      expect(text, row.id).not.toContain('замечан');
      expect(text, row.id).not.toContain('без типа');
      expect(row.label).toBe(INTERVENTION_KIND_LABELS[row.id]);
    }
  });
});

describe('the bounds line (replaces the lecture)', () => {
  it('is the deck’s one line, grouped with the non-breaking space', () => {
    expect(FORM_BOUNDS_LINE).toBe('до 10\u00a0000 знаков · одна правка в сутки');
    expect(FORM_BOUNDS_LINE).toBe(`до ${formatNumber(EDIT_MAX_CHARS)} знаков · одна правка в сутки`);
  });

  it('no longer explains the taxonomy', () => {
    expect(FORM_BOUNDS_LINE.toLowerCase()).not.toContain('вмешательство');
    expect(FORM_BOUNDS_LINE.toLowerCase()).not.toContain('четырёх');
  });
});

describe('the note, outside the grid', () => {
  it('has its own action, field and two quiet lines', () => {
    expect(NOTE_ACTION_LABEL).toBe('сказать о тексте — без правки');
    expect(NOTE_FIELD_LABEL).toBe('замечание к тексту');
    expect(NOTE_PLACEHOLDER).toBe('что не читается: повтор, сбой, деталь не на месте');
    expect(NOTE_FATE_LINE).toBe(
      'замечание увидят читатели; писатель прочитает его, если дойдёт до этой главы, и не обязан выполнять',
    );
    expect(NOTE_BUDGET_LINE).toBe('замечание не тратит правку дня');
  });
});

describe('the field’s label and placeholder follow the shape', () => {
  it('before a kind is chosen, the field says what it waits for', () => {
    const draft = { ...PARAGRAPH, kind: null };
    expect(wordingLabel(draft)).toBe(WORDING_LABEL_NEUTRAL);
    expect(WORDING_LABEL_NEUTRAL).toBe('текст правки');
    expect(wordingPlaceholder(draft)).toBe(WORDING_PLACEHOLDER_NEUTRAL);
    expect(WORDING_PLACEHOLDER_NEUTRAL).toBe('сначала выберите тип — от него зависит, что здесь писать');
    // A premise keeps its own label even before a kind is named.
    expect(wordingLabel({ ...PREMISE, kind: null })).toBe(PREMISE_LABEL);
    expect(wordingPlaceholder({ ...PREMISE, kind: null })).toBe(WORDING_PLACEHOLDER_NEUTRAL);
  });

  it('a paragraph asks the chosen kind’s question', () => {
    for (const kind of INTERVENTION_KINDS) {
      expect(wordingLabel({ ...PARAGRAPH, kind }), kind).toBe(KIND_WORDING_LABELS[kind]);
      expect(wordingPlaceholder({ ...PARAGRAPH, kind }), kind).toBe(KIND_WORDING_PLACEHOLDERS[kind]);
    }
  });

  it('a premise keeps one label and only its placeholder changes', () => {
    for (const kind of INTERVENTION_KINDS) {
      expect(wordingLabel({ ...PREMISE, kind }), kind).toBe('замысел главы');
      expect(wordingPlaceholder({ ...PREMISE, kind }), kind).toBe(KIND_PREMISE_PLACEHOLDERS[kind]);
    }
  });

  it('a note asks for its own text, whatever the kind was', () => {
    expect(wordingLabel({ ...NOTE, kind: null })).toBe(NOTE_FIELD_LABEL);
    expect(wordingPlaceholder({ ...NOTE, kind: null })).toBe(NOTE_PLACEHOLDER);
    expect(wordingLabel({ ...NOTE, blockId: null, kind: 'document' })).toBe(NOTE_FIELD_LABEL);
    expect(wordingPlaceholder({ ...NOTE, blockId: null, kind: 'document' })).toBe(NOTE_PLACEHOLDER);
  });
});
