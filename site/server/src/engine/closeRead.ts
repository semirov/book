/**
 * The small readers a close needs (ARCHITECTURE.md §6A.4 steps 7–9, §6A.6): the outcome a
 * cascade maps to, the stop's public words, the chapter's revision and a step as facts.
 *
 * They live apart from `close.ts` — not because they are a rule of their own, but because that
 * file is at the arch bound and these four are pure reads. `close.ts` imports and re-exports them,
 * so every caller keeps one surface.
 */

import { parseSeams, type CascadeOutcome, type ChangeOutcome } from '@book/shared';

import type { Db } from '../db/db.ts';
import { closeReason, type CascadeStepFact, type CloseCopyKey } from './cascade.ts';
import type * as store from './store.ts';

export function changeOutcomeOf(cascade: CascadeOutcome): ChangeOutcome {
  if (!cascade.startsWith('escalated:')) return 'applied';
  const reason = cascade.slice('escalated:'.length);
  if (
    reason === 'budget' || reason === 'oscillation' || reason === 'origin' || reason === 'delta' ||
    reason === 'finding' || reason === 'ending' || reason === 'science' || reason === 'rights' ||
    reason === 'gate_timeout'
  ) {
    return reason;
  }
  return 'origin';
}

const ESCALATION_COPY: Record<string, CloseCopyKey> = {
  budget: 'budget',
  oscillation: 'oscillation',
  origin: 'origin',
  delta: 'delta',
  ending: 'ending',
  finding: 'finding',
  // BOOK-76: a stop by the physics pass reads «не входит в книгу», not «правка опубликована».
  science: 'science',
  // BOOK-61: Gate B's stop reads «не принято» — never the prose gates' two outcomes.
  rights: 'rights',
  gate_timeout: 'gate',
};

/** The public reason for a stop, in the words the stop table uses (§6A.6). */
export function escalationCopy(outcome: CascadeOutcome): string {
  const suffix = outcome.startsWith('escalated:') ? outcome.slice('escalated:'.length) : 'origin';
  return closeReason(ESCALATION_COPY[suffix] ?? 'origin');
}

export function currentRev(db: Db, chapter: number): number {
  const row = db.prepare('SELECT rev FROM chapters WHERE n = ?').get(chapter) as { rev: number } | undefined;
  return row?.rev ?? 0;
}

export function stepFacts(row: store.StepRow): CascadeStepFact {
  return {
    seq: row.seq,
    pass: row.pass,
    chapter: row.chapter,
    lane: row.lane,
    wave: row.wave,
    outcome: row.outcome,
    seamsIn: parseSeams(safeJson(row.seams_in)),
    seamsOut: parseSeams(safeJson(row.seams_out)),
  };
}

function safeJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}
