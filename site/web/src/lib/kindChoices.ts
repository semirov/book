import { INTERVENTION_KIND_HINT, INTERVENTION_KIND_LABELS, INTERVENTION_KINDS, type InterventionKind } from '@book/shared';

/**
 * BOOK-DOC-34 §2.3 — the meaning of each kind, and the fifth row that ends the taxonomy.
 *
 * A kind is a world-fact, so the choice says what will appear in the book, not what the
 * reader will fix. The last row is the note path: it keeps the thread usable on the day the
 * reader's edit is spent, and it sends no kind at all. Nothing is ever pre-selected.
 */

export const KIND_MEANINGS: Readonly<Record<InterventionKind, string>> = {
  document: 'в книге появится бумага: акт, справка, протокол — с номером и подписью',
  decision: 'человек решает иначе: назовите решение и его цену',
  testimony: 'свидетель видел: показание, запись, деталь, которой не было',
  erasure: 'из книги уходит деталь: назовите её и что останется на её месте',
};

export const NOTE_KIND_LABEL = 'просто замечание — без типа';
export const NOTE_KIND_MEANING = 'сказать о тексте, ничего не внося';

export const KIND_PROMPT = INTERVENTION_KIND_HINT;

/** The rows in order: four kinds, then the quiet fifth row. */
export function kindChoices(): Array<{ id: InterventionKind | null; label: string; meaning: string }> {
  return [
    ...INTERVENTION_KINDS.map((kind) => ({ id: kind, label: INTERVENTION_KIND_LABELS[kind], meaning: KIND_MEANINGS[kind] })),
    { id: null, label: NOTE_KIND_LABEL, meaning: NOTE_KIND_MEANING },
  ];
}
