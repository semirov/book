/**
 * BOOK-16 — the kind of an intervention, checked where it is stored.
 *
 * One rule at one boundary: an intervention (a request that carries `proposedText`) must
 * declare exactly one of the four kinds, and a note must not declare one — a kind with no
 * intervention would be a field the reader filled in for nothing, and dropping it silently
 * is the kind of no-op this project refuses. The rule itself lives in
 * `shared/src/intervention.ts`; this module only decides between "this request is an
 * intervention" and "this request is a note", which the shared validator cannot know.
 */

import { validateInterventionKind, type InterventionKind } from '@book/shared';

export type InterventionKindCheck =
  | { ok: true; kind: InterventionKind | null }
  | { ok: false; code: string; message: string };

export function checkInterventionKind(raw: unknown, hasProposedText: boolean): InterventionKindCheck {
  if (!hasProposedText) {
    const empty = raw === undefined || raw === null || (typeof raw === 'string' && raw.trim().length === 0);
    if (empty) return { ok: true, kind: null };
    return {
      ok: false,
      code: 'INTERVENTION_KIND_WITHOUT_TEXT',
      message: 'тип вмешательства — только для своей правки: выберите «предложить свой вариант»',
    };
  }
  const verdict = validateInterventionKind(raw);
  if (!verdict.ok) return { ok: false, code: verdict.code, message: verdict.reason };
  return { ok: true, kind: verdict.kind };
}
