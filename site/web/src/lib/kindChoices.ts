import {
  EDIT_MAX_CHARS,
  INTERVENTION_KIND_HINT,
  INTERVENTION_KIND_LABELS,
  INTERVENTION_KINDS,
  type InterventionKind,
} from '@book/shared';

import { formatNumber } from './format.ts';

/**
 * BOOK-DOC-34 §2.3 — the form's one copy table (BOOK-57).
 *
 * A kind is a world-fact, so the choice says what will appear in the book, not what the
 * reader will fix. Each kind then asks its own question: a document wants an issuer and a
 * number, a decision wants the price, a testimony wants what confirms it. One row per kind
 * per shape, so a kind that arrives without copy fails the gate instead of printing a blank.
 *
 * The note is not a fifth kind: it left the grid and became a quiet action under the form.
 * Nothing here names a note as a choice, because nothing in the grid may claim a kind.
 */

export const KIND_MEANINGS: Readonly<Record<InterventionKind, string>> = {
  document: 'в книге появится бумага: акт, справка, протокол — с номером и подписью',
  decision: 'человек решает иначе: назовите решение и его цену',
  testimony: 'свидетель видел: показание, запись, то, чего в книге не было',
  erasure: 'из книги уходит деталь: назовите её и что останется на её месте',
};

/** The wording field's label, one per kind: the question a paragraph asks. */
export const KIND_WORDING_LABELS: Readonly<Record<InterventionKind, string>> = {
  document: 'текст бумаги',
  decision: 'решение и цена',
  testimony: 'показание',
  erasure: 'что уходит и что остаётся',
};

/** The wording field's placeholder, one per kind: what a paragraph wants in the field. */
export const KIND_WORDING_PLACEHOLDERS: Readonly<Record<InterventionKind, string>> = {
  document: 'кто выдал · номер · кому адресован',
  decision: 'кто решает · что решает · чем платит',
  testimony: 'кто видел · что · чем подтверждается',
  erasure: 'что уходит · что остаётся на его месте',
};

/**
 * An empty chapter takes a premise, and a premise is one act, not four forms: the label stays
 * «замысел главы» for every kind, and only the placeholder says which act opens the chapter.
 */
export const KIND_PREMISE_PLACEHOLDERS: Readonly<Record<InterventionKind, string>> = {
  document: 'какая бумага открывает главу · кто выдал · номер',
  decision: 'кто решает в начале главы · что · чем платит',
  testimony: 'кто свидетель · что видел · чем подтверждается',
  erasure: 'что уходит из главы · что остаётся вместо',
};

/** Before a kind is chosen the field is still a field: it says what it waits for. */
export const WORDING_LABEL_NEUTRAL = 'текст правки';
export const WORDING_PLACEHOLDER_NEUTRAL = 'сначала выберите тип — от него зависит, что здесь писать';

export const PREMISE_LABEL = 'замысел главы';

/** The note path — a quiet action under the form, not a row of the grid. */
export const NOTE_ACTION_LABEL = 'сказать о тексте — без правки';
export const NOTE_FIELD_LABEL = 'замечание к тексту';
export const NOTE_PLACEHOLDER = 'что не читается: повтор, сбой, деталь не на месте';
export const NOTE_FATE_LINE =
  'замечание увидят читатели; писатель прочитает его, если дойдёт до этой главы, и не обязан выполнять';
export const NOTE_BUDGET_LINE = 'замечание не тратит правку дня';

/**
 * «до 10 000 знаков · одна правка в сутки» — the form's one bounds line, built from the
 * guard's own constant and the site's non-breaking grouping, so the copy cannot drift.
 */
export const FORM_BOUNDS_LINE = `до ${formatNumber(EDIT_MAX_CHARS)} знаков · одна правка в сутки`;

export const KIND_PROMPT = INTERVENTION_KIND_HINT;

/** The rows of the grid, in order: the four kinds, and no fifth row. */
export function kindChoices(): Array<{ id: InterventionKind; label: string; meaning: string }> {
  return INTERVENTION_KINDS.map((kind) => ({
    id: kind,
    label: INTERVENTION_KIND_LABELS[kind],
    meaning: KIND_MEANINGS[kind],
  }));
}

/** The shape both resolvers read: what the form knows before it prints a field. */
export type WordingState = {
  noteOnly: boolean;
  blockId: string | null;
  kind: InterventionKind | null;
};

/** The label of the field the reader writes in: a note, a premise, or the chosen kind. */
export function wordingLabel(draft: WordingState): string {
  if (draft.noteOnly) return NOTE_FIELD_LABEL;
  if (draft.blockId === null) return PREMISE_LABEL;
  return draft.kind === null ? WORDING_LABEL_NEUTRAL : KIND_WORDING_LABELS[draft.kind];
}

/** The placeholder of that field: the same three shapes, one table per kind. */
export function wordingPlaceholder(draft: WordingState): string {
  if (draft.noteOnly) return NOTE_PLACEHOLDER;
  if (draft.kind === null) return WORDING_PLACEHOLDER_NEUTRAL;
  return draft.blockId === null
    ? KIND_PREMISE_PLACEHOLDERS[draft.kind]
    : KIND_WORDING_PLACEHOLDERS[draft.kind];
}
