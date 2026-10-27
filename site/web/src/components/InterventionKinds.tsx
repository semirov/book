import { INTERVENTION_RULE_COPY, type InterventionKind } from '@book/shared';

import { draftKindLine } from '../lib/composer.ts';
import { kindChoices, KIND_PROMPT, NOTE_KIND_LABEL } from '../lib/kindChoices.ts';

/**
 * BOOK-DOC-34 §2.3 — the five rows of the form.
 *
 * Four kinds and the quiet fifth row: a note without a type. Each row says what will appear
 * in the book, so the choice is a fact, not a category. Nothing is pre-selected — the reader
 * names what they bring, or the form refuses the send (BOOK-16).
 */
export function InterventionKinds({
  kind,
  noteOnly = false,
  disabled = false,
  onPick,
}: {
  kind: InterventionKind | null;
  noteOnly?: boolean;
  disabled?: boolean;
  onPick: (choice: { kind: InterventionKind | null; noteOnly: boolean }) => void;
}) {
  return (
    <fieldset className="kinds">
      <legend className="field-label">{KIND_PROMPT}</legend>
      {kindChoices().map((row) => {
        const checked = row.id === null ? noteOnly : !noteOnly && kind === row.id;
        return (
          <label className={`kind${row.id === null ? ' kind-note' : ''}`} key={row.id ?? 'note'} data-picked={checked ? 'true' : undefined}>
            <input
              type="radio"
              name="intervention-kind"
              value={row.id ?? 'note'}
              checked={checked}
              onChange={() => onPick({ kind: row.id, noteOnly: row.id === null })}
              disabled={disabled}
            />
            <span className="kind-word">{row.label}</span>
            <span className="kind-meaning">{row.meaning}</span>
          </label>
        );
      })}
      <p className="kind-state" data-kind={noteOnly ? 'note' : (kind ?? 'none')} role="status">
        {noteOnly ? `вносится: ${NOTE_KIND_LABEL}` : draftKindLine(kind)}
      </p>
      <p className="fine">{INTERVENTION_RULE_COPY}</p>
    </fieldset>
  );
}
