/**
 * Narrow row shapes and the few pure helpers both engine readers share.
 *
 * The site only reads these tables (§4.2): the engine owns the writes. Keeping the row
 * types here — not importing the engine's `store.ts` — means the site cannot accidentally
 * pull a write helper into a request path.
 */

import { normalizeSeamBoundary, type InterventionKind, type SeamBoundary, type StepPass } from '@book/shared';

import type { Db } from '../db/db.ts';

export type ChangeRow = {
  seq: number;
  id: string;
  kind: 'reader_edit' | 'accepted_comment' | 'continuity' | 'operator';
  /** BOOK-16 — the kind of the source intervention (null for other changes and old rows). */
  intervention_kind: InterventionKind | null;
  chapter: number;
  intent: string;
  source_comment: string | null;
  base_rev: number;
  scope_hint: 'phrase' | 'chapter';
  status: 'pending' | 'processing' | 'stale' | 'done' | 'void' | 'escalated' | 'failed';
  relevance: string | null;
  outcome: string | null;
  reason: string | null;
  cascade_id: string | null;
  model: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_rub: number;
  enqueued_at: string;
  started_at: string | null;
  finished_at: string | null;
  attempts: number;
};

export type CascadeRow = {
  id: string;
  change_id: string;
  status: 'open' | 'closed' | 'escalated' | 'aborted';
  outcome: string | null;
  wave: number;
  depth_fwd: number;
  depth_bwd: number;
  step_count: number;
  tokens: number;
  budget: string;
  opened_at: string;
  closed_at: string | null;
};

export type StepRow = {
  step_id: string;
  cascade_id: string | null;
  seq: number;
  wave: number;
  lane: 'forward' | 'backward' | null;
  pass: StepPass;
  chapter: number | null;
  boundary: string;
  outcome:
    | 'rewritten'
    | 'holds'
    | 'published_with_finding'
    | 'evaluated'
    | 'escalated'
    | 'interrupted'
    | null;
  rev_before: number | null;
  rev_after: number | null;
  seams_in: string | null;
  seams_out: string | null;
  blocks_touched: number | null;
  chars_delta: number | null;
  cost_rub: number;
  tokens_in: number;
  tokens_out: number;
  hseq_from: number | null;
  hseq_to: number | null;
  lease_id: string | null;
  session: string | null;
  at: string;
  ms: number | null;
  note: string | null;
  cycle: number;
  closed_at: string | null;
};

export type LeaseRow = {
  id: string;
  step_id: string;
  change_id: string | null;
  cascade_id: string | null;
  lane: 'forward' | 'backward' | null;
  chapter: number | null;
  is_front: number;
  kind: StepPass;
  session: string;
  acquired_at: string;
  released_at: string | null;
};

export const CHANGE_COLUMNS = `seq, id, kind, chapter, intent, source_comment, base_rev, scope_hint, status,
  relevance, outcome, reason, cascade_id, model, tokens_in, tokens_out, cost_rub,
  enqueued_at, started_at, finished_at, attempts`;

export function safeJson<T>(raw: string | null): T | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function metaValue(db: Db, key: string): string | null {
  const row = db.prepare('SELECT v FROM meta WHERE k = ?').get(key) as { v: string } | undefined;
  return row?.v ?? null;
}

export function countRows(db: Db, sql: string, ...params: Array<string | number>): number {
  const row = db.prepare(sql).get(...params) as { n: number } | undefined;
  return row?.n ?? 0;
}

/** `boundary` is text in the DB; the public seam vocabulary is one shape (§6A.5). */
export function boundaryOf(text: string, pass: StepPass, chapter: number | null): SeamBoundary {
  const parsed = normalizeSeamBoundary(text);
  if (parsed !== null) return parsed;
  if (pass === 'front') return 'front';
  if (chapter === 67) return 'ending';
  return chapter === null ? 'front' : Math.max(2, chapter);
}

export function chapterOfStep(step: StepRow): number | 'front' | null {
  return step.chapter ?? (step.pass === 'front' ? 'front' : null);
}
