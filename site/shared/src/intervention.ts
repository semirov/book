/**
 * BOOK-16 / BOOK-DOC-4 rule 1 — an intervention is **one of four kinds**.
 *
 * A reader's intervention is a world-fact, not a prose correction: a document is brought in,
 * a character's decision changes, a testimony is added, a detail is erased. The four kinds
 * are one closed set with stable English ids and one Russian label table; the composer, the
 * HTTP API and the triage CLI all read this file, so a kind cannot mean two things in two
 * processes and a new kind cannot appear on one surface alone.
 *
 * The ids are stored (in SQLite and in the batch file a model reads); the labels are the only
 * words a reader ever sees. A row written before BOOK-16 has no kind — `null` is legitimate
 * for that history — while every **new** intervention must carry one, which is what
 * `validateInterventionKind` says at each boundary that accepts reader input.
 */

import { EDIT_MAX_CHARS } from './comment.ts';

export const INTERVENTION_KINDS = ['document', 'decision', 'testimony', 'erasure'] as const;

export type InterventionKind = (typeof INTERVENTION_KINDS)[number];

/** The only words a reader sees for a kind. Lowercase, no taxonomy, no code. */
export const INTERVENTION_KIND_LABELS: Readonly<Record<InterventionKind, string>> = {
  document: 'документ',
  decision: 'решение героя',
  testimony: 'свидетельство',
  erasure: 'стёртая деталь',
};

/** «документ · решение героя · свидетельство · стёртая деталь» — one list, one order. */
export const INTERVENTION_KIND_LIST = INTERVENTION_KINDS.map(
  (kind) => INTERVENTION_KIND_LABELS[kind],
).join(' · ');

/** The composer's one line before the four choices. */
export const INTERVENTION_KIND_HINT = `что вы вносите: ${INTERVENTION_KIND_LIST}`;

/**
 * «10 000» with the non-breaking space the site groups every number with (`lib/format.ts`):
 * a bound in copy has to read like the bound in the counter beside it.
 */
const EDIT_MAX_GROUPED = String(EDIT_MAX_CHARS).replace(/\B(?=(\d{3})+(?!\d))/gu, '\u00a0');

/**
 * The rule in one sentence, for `/rules` and the composer: an intervention is the reader's
 * own wording *and* its kind — a world-fact, not a prose correction — with the length and day
 * bounds. Numbers come from `comment.ts`, so copy cannot drift from the guard.
 */
export const INTERVENTION_RULE_COPY =
  `вмешательство — своя правка одного из четырёх типов (${INTERVENTION_KIND_LIST}), факт мира, ` +
  `а не правка прозы: до ${EDIT_MAX_GROUPED} знаков, одна правка в сутки`;

export type InterventionKindFailureCode = 'INTERVENTION_KIND_REQUIRED' | 'INTERVENTION_KIND_UNKNOWN';

export type InterventionKindVerdict =
  | { ok: true; kind: InterventionKind }
  | { ok: false; code: InterventionKindFailureCode; reason: string };

export function isInterventionKind(value: unknown): value is InterventionKind {
  return typeof value === 'string' && (INTERVENTION_KINDS as readonly string[]).includes(value);
}

/**
 * A stored or inbound value → one of the four, or `null`. An unknown value is **dropped**, not
 * kept: this is the read path (a row, a batch line), and a kind the build does not know is not
 * a kind it may print. A boundary that accepts a *new* intervention uses
 * `validateInterventionKind` instead, which refuses rather than drops.
 */
export function normalizeInterventionKind(value: unknown): InterventionKind | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return isInterventionKind(trimmed) ? trimmed : null;
}

/** The Russian label of a stored value, or `null` when there is no kind to print. */
export function interventionKindLabel(value: unknown): string | null {
  const kind = normalizeInterventionKind(value);
  return kind === null ? null : INTERVENTION_KIND_LABELS[kind];
}

/**
 * A new intervention's kind: required and closed. The same function runs in the composer,
 * at `POST /api/comments` (inside the service, after the CAPTCHA) and in the triage CLI, so
 * "a new intervention always has exactly one kind" is one definition, not three.
 */
export function validateInterventionKind(raw: unknown): InterventionKindVerdict {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim().length === 0)) {
    return {
      ok: false,
      code: 'INTERVENTION_KIND_REQUIRED',
      reason: `выберите, что вы вносите: ${INTERVENTION_KIND_LIST}`,
    };
  }
  const kind = normalizeInterventionKind(raw);
  if (kind === null) {
    return {
      ok: false,
      code: 'INTERVENTION_KIND_UNKNOWN',
      reason: `такого типа вмешательства нет: ${INTERVENTION_KIND_LIST}`,
    };
  }
  return { ok: true, kind };
}
