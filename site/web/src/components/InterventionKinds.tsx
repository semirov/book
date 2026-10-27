import {
  INTERVENTION_KINDS,
  INTERVENTION_KIND_HINT,
  INTERVENTION_KIND_LABELS,
  INTERVENTION_RULE_COPY,
  type InterventionKind,
} from '@book/shared';

import { draftKindLine } from '../lib/composer.ts';

/**
 * BOOK-16 — the four kinds, as a plain choice.
 *
 * A fieldset of four radios, the rule in one line, and the draft's own state: which world-fact
 * is about to be brought in, or that nothing is chosen yet. No icons, no cards, no pre-selected
 * value — the reader names the kind or the composer refuses the send. It is a component of its
 * own so the labels, the hint and the "nothing chosen" state can be asserted without a browser.
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
    <fieldset className="composer-kinds">
      <legend className="composer-label">{INTERVENTION_KIND_HINT}</legend>
      {INTERVENTION_KINDS.map((value) => (
        <label className="composer-kind" key={value}>
          <input
            type="radio"
            name="intervention-kind"
            value={value}
            checked={kind === value}
            onChange={() => onPick(value)}
            disabled={disabled}
          />
          {INTERVENTION_KIND_LABELS[value]}
        </label>
      ))}
      <p className="composer-kind-state" data-kind={kind ?? 'none'} role="status">
        {draftKindLine(kind)}
      </p>
      <p className="fine">{INTERVENTION_RULE_COPY}</p>
    </fieldset>
  );
}
