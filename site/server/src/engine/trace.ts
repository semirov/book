/**
 * `trace` (ARCHITECTURE.md §6A.8): one change or one step, reconstructed from rows.
 *
 * This is the operator's view of a ripple and the acceptance criterion of M3 — every step
 * with its two verdicts, in order. It reads; it never repairs. The CLI prints it as text,
 * the internal API returns the same object as JSON, so the two cannot disagree.
 */

import type {
  CascadeOutcome,
  CascadeStatus,
  ChangeOutcome,
  ChangeStatus,
  ChangeTrace,
  Finding,
  GateRole,
  Relevance,
  StepOutcome,
  StepPass,
  StepTrace,
  WriterAssignment,
} from '@book/shared';
import {
  CHAPTER_CHARS, TOTAL_CHAPTERS, normalizeInterventionKind, normalizeScopeHint, parseSeams } from '@book/shared';

import { findLiveSentence } from '../sentences/store.ts';
import type { StepRow, VerdictRow } from './store.ts';
import * as store from './store.ts';
import { premiseOfStep } from './premise.ts';
import type { EngineDeps } from './types.ts';

export type TraceResult =
  | { kind: 'change'; change: ChangeTrace }
  | { kind: 'step'; step: StepTrace; changeId: string | null; cascadeId: string | null };

function json<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function gateOf(row: VerdictRow): StepTrace['gates'][number] {
  return {
    role: row.role as GateRole,
    // Only the two prose roles reach here (`stepTraceOf` filters Gate B out): a rights answer
    // is a different enum and is read from the step's own scan and change, not as a finding.
    verdict: row.verdict as 'HOLDS' | 'GAP',
    findings: json(row.findings, []),
    cycles: row.cycles,
    model: row.model,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    at: row.at,
    late: row.late === 1,
  };
}

/** Gate B's answer, when it exists: the enum plus the rule id it named (never a finding). */
function rightsOf(rows: readonly VerdictRow[]): StepTrace['rights'] {
  const row = rows.find((candidate) => candidate.role === 'rights');
  if (row === undefined) return null;
  const rule = (json<Array<{ rule?: unknown }>>(row.findings, [])[0]?.rule ?? null) as string | null;
  return { verdict: row.verdict === 'CLEAR' ? 'CLEAR' : 'REFUSED', rule, at: row.at };
}

export function stepTrace(deps: EngineDeps, stepId: string): StepTrace | null {
  const row = store.getStep(deps.db, stepId);
  if (!row) return null;
  return stepTraceOf(deps, row);
}

export function stepTraceOf(deps: EngineDeps, row: StepRow): StepTrace {
  return {
    step: {
      stepId: row.step_id,
      cascadeId: row.cascade_id,
      seq: row.seq,
      wave: row.wave,
      lane: row.lane,
      pass: row.pass as StepPass,
      chapter: row.chapter,
      boundary: row.boundary,
      state: row.outcome === null ? 'open' : 'closed',
      outcome: row.outcome as StepOutcome | null,
      revBefore: row.rev_before,
      revAfter: row.rev_after,
      cycle: row.cycle,
      landedAt: row.landed_at,
      seamsIn: parseSeams(json(row.seams_in, [])),
      seamsOut: parseSeams(json(row.seams_out, [])),
      blocksTouched: row.blocks_touched,
      charsDelta: row.chars_delta,
      model: row.model,
      tokensIn: row.tokens_in,
      tokensOut: row.tokens_out,
      session: row.session,
      leaseId: row.lease_id,
      at: row.at,
      closedAt: row.closed_at,
      note: row.note,
    },
    gates: store
      .listVerdicts(deps.db, row.step_id)
      // BOOK-61: Gate B is conditional and answers CLEAR/REFUSED — a different enum and a
      // different question. It is printed as its own line (`rights`), never as a third gate.
      .filter((verdict) => verdict.role !== 'rights')
      .map(gateOf),
    rights: rightsOf(store.listVerdicts(deps.db, row.step_id)),
  };
}

export function changeTraceOf(deps: EngineDeps, changeId: string): ChangeTrace | null {
  const change = store.getChange(deps.db, changeId);
  if (!change) return null;
  const cascade = change.cascade_id ? store.getCascade(deps.db, change.cascade_id) : undefined;
  return {
    change: {
      id: change.id,
      seq: change.seq,
      kind: change.kind as ChangeTrace['change']['kind'],
      chapter: change.chapter,
      intent: change.intent,
      status: change.status as ChangeStatus,
      outcome: change.outcome as ChangeOutcome | null,
      reason: change.reason,
      premise: change.premise === 1,
      relevance: json<Relevance | null>(change.relevance, null),
      cascadeId: change.cascade_id,
      enqueuedAt: change.enqueued_at,
      startedAt: change.started_at,
      finishedAt: change.finished_at,
      attempts: change.attempts,
      model: change.model,
      tokensIn: change.tokens_in,
      tokensOut: change.tokens_out,
    },
    cascade: cascade
      ? {
          id: cascade.id,
          status: cascade.status as CascadeStatus,
          outcome: cascade.outcome as CascadeOutcome | null,
          wave: cascade.wave,
          depthForward: cascade.depth_fwd,
          depthBackward: cascade.depth_bwd,
          steps: store.listCascadeSteps(deps.db, cascade.id).map((step) => stepTraceOf(deps, step)),
        }
      : null,
  };
}

export function readTrace(deps: EngineDeps, identifier: string): TraceResult | null {
  if (identifier.startsWith('chg_')) {
    const change = changeTraceOf(deps, identifier);
    return change ? { kind: 'change', change } : null;
  }
  const row = store.getStep(deps.db, identifier);
  if (!row) return null;
  const step = stepTraceOf(deps, row);
  const cascade = row.cascade_id ? store.getCascade(deps.db, row.cascade_id) : undefined;
  const lease = deps.db
    .prepare('SELECT change_id FROM leases WHERE step_id = ? ORDER BY acquired_at DESC LIMIT 1')
    .get(row.step_id) as { change_id: string | null } | undefined;
  return {
    kind: 'step',
    step,
    changeId: cascade?.change_id ?? lease?.change_id ?? null,
    cascadeId: row.cascade_id,
  };
}

/**
 * BOOK-173 §3: does this change's anchor point at a sentence the book still holds? The anchor is
 * the JSON `changes` has always carried (`{blockIds, quote, prefix, suffix}`), and v25 added the
 * `sentenceIds` the filing was anchored to. One live row is enough: a quote that no longer matches
 * keeps its block anchor and reads `false` here, which is the honest answer — the pass rewrites.
 */
function hasLiveSentenceAnchor(db: EngineDeps['db'], raw: string | null): boolean {
  const anchor = json<{ sentenceIds?: unknown } | null>(raw, null);
  const ids = anchor?.sentenceIds;
  if (!Array.isArray(ids)) return false;
  return ids.some((id) => typeof id === 'string' && id.length > 0 && findLiveSentence(db, id) !== null);
}

/**
 * BOOK-206 (ADR-045): the filing's own read, from the newest attempt of the comment a change
 * names (`changes.source_comment`). `awaitingRead` is the one state the patch path must never run
 * in — the attempt is `submitted` and no verdict is stored, so the reading is either in flight or
 * not yet bought. A settled attempt with no verdict is **not** that state: an operator's own
 * decision, or a row written before BOOK-206, is the read.
 */
function triageOf(
  db: EngineDeps['db'],
  change: store.ChangeRow,
): { verdict: 'FITS' | 'OFF' | null; awaitingRead: boolean } {
  const commentId = change.source_comment;
  if (commentId === null || commentId === undefined) return { verdict: null, awaitingRead: false };
  const row = db
    .prepare(`SELECT outcome, verdict FROM comment_attempts WHERE comment_id = ? ORDER BY n DESC LIMIT 1`)
    .get(commentId) as { outcome: string | null; verdict: string | null } | undefined;
  if (row === undefined) return { verdict: null, awaitingRead: false };
  const stored = row.verdict === null ? null : json<{ verdict?: unknown }>(row.verdict, {}).verdict;
  return {
    verdict: stored === 'FITS' || stored === 'OFF' ? stored : null,
    awaitingRead: row.outcome === 'submitted' && row.verdict === null,
  };
}

/** The writer's assignment, derived from the step (never a stored prompt, §6B.2). */
export function writerAssignment(
  deps: EngineDeps,
  step: StepRow,
  leaseId: string,
  changeId: string | null,
): WriterAssignment {
  const cascade = step.cascade_id ? store.getCascade(deps.db, step.cascade_id) : undefined;
  const change = changeId ? store.getChange(deps.db, changeId) : undefined;
  const budget = cascade ? json<{ maxWave: number; maxSteps: number; maxWallMs: number }>(cascade.budget, {
    maxWave: 0,
    maxSteps: 0,
    maxWallMs: 0,
  }) : null;
  // What sent the writer back: the findings of the verdict that forced the last revision.
  // Stored on the step because a re-land replaces the verdict row (one row per role).
  const gapFindings = step.cycle > 0 ? json<Finding[]>(step.last_findings, []) : [];
  return {
    stepId: step.step_id,
    leaseId,
    pass: step.pass as StepPass,
    chapter: step.pass === 'front' ? 'front' : (step.chapter ?? 1),
    neighbours:
      step.chapter === null
        ? { before: null, after: null }
        : {
            before: step.chapter > 1 ? step.chapter - 1 : null,
            after: step.chapter < TOTAL_CHAPTERS ? step.chapter + 1 : null,
          },
    expectation: step.pass === 'draft' ? { chars: { min: CHAPTER_CHARS.min, max: CHAPTER_CHARS.max } } : null,
    intent: change ? { value: change.intent, untrusted: true } : null,
    // BOOK-173: the filing's own width, from the change row; a step without a change has none.
    scopeHint: change === undefined ? null : normalizeScopeHint(change.scope_hint),
    // BOOK-173 §3: does the address the filing was made at still exist? `changes.anchor` names the
    // block ids and, from v25, the sentence ids (ADR-044 §5) — «live» is a row, never a string: an
    // id whose sentence has been erased since is history, and a patch aimed at history would
    // re-key the very sentences the filing was about.
    sentenceAnchor: change !== undefined && hasLiveSentenceAnchor(deps.db, change.anchor),
    // BOOK-206: the filing's own read travels with the assignment, so the patch path can ask
    // «has anyone judged these words?» from a fact rather than assuming the site's order.
    triage: change === undefined ? { verdict: null, awaitingRead: false } : triageOf(deps.db, change),
    // BOOK-16: the writer is told which world-fact the intervention brings, as one id, so a
    // document is written as a document and not as a prose polish. Null when there is none.
    interventionKind: change === undefined ? null : normalizeInterventionKind(change.intervention_kind),
    // BOOK-7: the first pass of a chapter with a premise receives it here — one goal, its
    // kind, and nothing that could identify the reader.
    premise: premiseOfStep(deps.db, step),
    seamsIn: parseSeams(json(step.seams_in, [])),
    cycle: step.cycle,
    findings: step.cycle > 0 && gapFindings.length > 0 ? gapFindings : null,
    relevance: change ? json<Relevance | null>(change.relevance, null) : null,
    landed: step.landed_at !== null,
    verdicts: {
      editor: store.getVerdict(deps.db, step.step_id, 'editor') !== undefined,
      consultant: store.getVerdict(deps.db, step.step_id, 'consultant') !== undefined,
      rights: store.getVerdict(deps.db, step.step_id, 'rights') !== undefined,
    },
    budget:
      cascade && budget
        ? {
            wave: step.wave,
            maxWave: budget.maxWave,
            steps: cascade.step_count,
            maxSteps: budget.maxSteps,
            deadline: new Date(Date.parse(cascade.opened_at) + budget.maxWallMs).toISOString(),
          }
        : null,
    changeId: changeId ?? null,
    cascadeId: step.cascade_id,
  };
}
