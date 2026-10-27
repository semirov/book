import type { InterventionKind } from '@book/shared';

import { draftKindLine } from '../lib/composer.ts';
import { FORM_BOUNDS_LINE, KIND_PROMPT, kindChoices } from '../lib/kindChoices.ts';

/**
 * BOOK-DOC-34 §2.3 — the four rows of the form.
 *
 * Each row says what will appear in the book, so the choice is a fact, not a category.
 * Nothing is pre-selected — the reader names what they bring, or the form refuses the send
 * (BOOK-16). BOOK-57: the note left the grid for a quiet action under the form, so this
 * fieldset holds exactly four rows and no fifth one, and the bounds line replaces the
 * lecture that used to close it.
 */
export function InterventionKinds({
  kind,
  disabled = false,
  onPick,
}: {
  kind: InterventionKind | null;
  disabled?: boolean;
  onPick: (kind: InterventionKind) => void;
}) {
  return (
    <fieldset className="kinds">
      <legend className="field-label">{KIND_PROMPT}</legend>
      {kindChoices().map((row) => (
        <label className="kind" key={row.id} data-picked={kind === row.id ? 'true' : undefined}>
          <input
            type="radio"
            name="intervention-kind"
            className="ym-disable-keys"
            value={row.id}
            checked={kind === row.id}
            onChange={() => onPick(row.id)}
            disabled={disabled}
          />
          <span className="kind-word">{row.label}</span>
          <span className="kind-meaning">{row.meaning}</span>
        </label>
      ))}
      <p className="kind-state" data-kind={kind ?? 'none'} role="status">
        {draftKindLine(kind)}
      </p>
      <p className="fine">{FORM_BOUNDS_LINE}</p>
    </fieldset>
  );
}
