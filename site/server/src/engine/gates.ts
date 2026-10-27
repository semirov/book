/**
 * The two hidden gates (ARCHITECTURE.md §6B.3, §6B.4).
 *
 * The engine does not judge prose and does not call a model: it enforces completeness,
 * order and the cycle cap. A step cannot close without both verdicts; a consultant verdict
 * cannot exist before the editor's; a verdict cannot arrive from a session that was not
 * handed the step; and a `GAP` without a `blocker` is a matter of taste, which the engine
 * downgrades to `HOLDS` and records.
 */

import type { Finding, FindingSeverity, GateRole } from '@book/shared';
import { normalizeRetroMode } from '@book/shared';

import type { Db } from '../db/db.ts';
import { toIso } from '../util/time.ts';
import {
  deleteDispatch,
  getDispatch,
  getVerdict,
  upsertDispatch,
  upsertVerdict,
  type DispatchRow,
  type StepRow,
  type VerdictRow,
} from './store.ts';
import { refuse, type EngineDeps } from './types.ts';

export const GATE_ROLES: readonly GateRole[] = ['editor', 'consultant'];

export type GateAssignment = {
  stepId: string;
  role: GateRole;
  session: string;
  pass: string;
  chapter: number | null;
  boundary: string;
  cycle: number;
  landedSha: string | null;
  /** The writer's own report, ≤200 chars — the only account a gate is given (§6B.1). */
  note: string | null;
  /**
   * BOOK-18: the path to a derived index slice for this chapter and its neighbours. It is
   * `null` for the consultant, for a `front` step (there is no chapter to slice) and when
   * the index could not be built — the slice is optional, never a precondition of a gate.
   */
  indexSlice: string | null;
  expiresAt: string;
};

const SEVERITIES = new Set<FindingSeverity>(['blocker', 'major', 'minor']);

function text(value: unknown, max: number): string {
  const raw = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
  return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
}

/** Findings are data: unknown shapes are dropped, never trusted to be well-formed. */
export function normalizeFindings(raw: unknown): Finding[] {
  if (!Array.isArray(raw)) return [];
  const findings: Finding[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const severity = SEVERITIES.has(record.severity as FindingSeverity)
      ? (record.severity as FindingSeverity)
      : 'major';
    const defect = text(record.defect, 1_000);
    if (defect.length === 0) continue;
    findings.push({
      severity,
      location: text(record.location, 300),
      defect,
      fix: text(record.fix, 1_000),
      // One of the three retroactive modes, or nothing: an unknown word is dropped like any
      // other untrusted field, never stored as a fourth mode (§6B.3, `style/VOICE.md`).
      mode: normalizeRetroMode(record.mode),
    });
  }
  return findings;
}

export function hasBlocker(findings: readonly Finding[]): boolean {
  return findings.some((finding) => finding.severity === 'blocker');
}

/** Hand the step to a gate session, or resume the session that already holds it. */
export function openDispatch(
  deps: EngineDeps,
  step: StepRow,
  role: GateRole,
  session: string,
): DispatchRow {
  const now = deps.clock.now();
  const at = toIso(now);

  if (step.outcome !== null) refuse('STEP_CLOSED', 409, `step ${step.step_id} is closed`);
  if (step.landed_at === null) {
    refuse('NOT_LANDED', 409, `step ${step.step_id} has no landed text — a gate cannot bless a file it has not seen`);
  }
  if (getVerdict(deps.db, step.step_id, role)) {
    refuse('GATE_ANSWERED', 409, `the ${role} gate already answered step ${step.step_id}`);
  }
  if (role === 'consultant' && !getVerdict(deps.db, step.step_id, 'editor')) {
    refuse('GATE_ORDER', 422, 'the editor answers before the science consultant (§6A.11)');
  }

  const existing = getDispatch(deps.db, step.step_id, role);
  if (existing && existing.session !== session && existing.expires_at > at) {
    refuse('GATE_TAKEN', 409, `step ${step.step_id} is being read by another ${role} session`);
  }
  const expiresAt = toIso(now + deps.config.gateTtlMs);
  const dispatch: DispatchRow = {
    step_id: step.step_id,
    role,
    session,
    dispatched_at: existing && existing.session === session ? existing.dispatched_at : at,
    expires_at: expiresAt,
  };
  upsertDispatch(deps.db, dispatch);
  return dispatch;
}

export type GateAnswer = {
  role: GateRole;
  verdict: 'HOLDS' | 'GAP';
  /** Untrusted shape: normalised here, never trusted from the session. */
  findings: unknown;
  model: string;
  tokensIn: number;
  tokensOut: number;
};

export type RecordedVerdict = {
  verdict: VerdictRow;
  /** What the writer must do next. */
  action: 'close' | 'revise' | 'publish_with_finding';
  /** 1 = the engine downgraded a blockerless GAP to HOLDS. */
  downgraded: boolean;
  late: boolean;
};

/**
 * Record one verdict. Order, dispatch and the shared cycle counter are enforced here; the
 * only thing not enforced is whether the gate actually read the text — that residual is
 * stated in §19.14 and is the reason the verdict is provenance, not proof.
 */
export function recordVerdict(
  deps: EngineDeps,
  step: StepRow,
  answer: GateAnswer,
  session: string,
): RecordedVerdict {
  const db = deps.db;
  const now = deps.clock.now();
  const at = toIso(now);
  if (answer.role === 'consultant' && !getVerdict(db, step.step_id, 'editor')) {
    refuse('GATE_ORDER', 422, 'the consultant may not answer before the editor');
  }
  const dispatch = getDispatch(db, step.step_id, answer.role);
  if (!dispatch) {
    refuse('GATE_NOT_DISPATCHED', 409, `no ${answer.role} was dispatched for step ${step.step_id}`);
  }
  if (dispatch.session !== session) {
    refuse('GATE_NOT_DISPATCHED', 409, `step ${step.step_id} was dispatched to another session`);
  }
  if (step.landed_at === null) {
    refuse('NOT_LANDED', 409, 'a verdict for an unlanded file is refused (§6A.11)');
  }

  const findings = normalizeFindings(answer.findings);
  const downgraded = answer.verdict === 'GAP' && !hasBlocker(findings);
  const verdict: 'HOLDS' | 'GAP' = downgraded ? 'HOLDS' : answer.verdict;
  const blocking = verdict === 'GAP' && hasBlocker(findings);
  const cycles = step.cycle;
  const late = dispatch.expires_at <= at;

  upsertVerdict(db, {
    step_id: step.step_id,
    role: answer.role,
    verdict,
    findings: JSON.stringify(findings),
    cycles,
    model: text(answer.model, 120) || 'stub',
    tokens_in: Math.max(0, Math.trunc(answer.tokensIn)),
    tokens_out: Math.max(0, Math.trunc(answer.tokensOut)),
    at,
    late: late ? 1 : 0,
  });

  // The assignment is consumed by the answer; a revision will be dispatched again.
  deleteDispatch(db, step.step_id, answer.role);

  let action: RecordedVerdict['action'] = 'close';
  if (blocking) {
    if (step.pass === 'ending') {
      // ADR-024: the ending is never rewritten; a blocker escalates at close.
      action = 'close';
    } else {
      action = cycles >= deps.config.gateCycles ? 'publish_with_finding' : 'revise';
    }
  }

  return {
    verdict: {
      step_id: step.step_id,
      role: answer.role,
      verdict,
      findings: JSON.stringify(findings),
      cycles,
      model: text(answer.model, 120) || 'stub',
      tokens_in: Math.max(0, Math.trunc(answer.tokensIn)),
      tokens_out: Math.max(0, Math.trunc(answer.tokensOut)),
      at,
      late: late ? 1 : 0,
    },
    action,
    downgraded,
    late,
  };
}

/** Both verdicts, in order, or a refusal that names what is missing. */
export function missingVerdicts(db: Db, stepId: string): GateRole[] {
  return GATE_ROLES.filter((role) => getVerdict(db, stepId, role) === undefined);
}

/** A step is closed `published_with_finding` when a blocker survived the cycle cap. */
export function survivedFinding(db: Db, stepId: string, gateCycles: number, cycle: number): boolean {
  if (cycle < gateCycles) return false;
  return GATE_ROLES.some((role) => {
    const verdict = getVerdict(db, stepId, role);
    if (!verdict || verdict.verdict !== 'GAP') return false;
    const findings = normalizeFindings(JSON.parse(verdict.findings) as unknown);
    return hasBlocker(findings);
  });
}

export function assignmentOf(
  step: StepRow,
  dispatch: DispatchRow,
  indexSlice: string | null = null,
): GateAssignment {
  return {
    stepId: step.step_id,
    role: dispatch.role,
    session: dispatch.session,
    pass: step.pass,
    chapter: step.chapter,
    boundary: step.boundary,
    cycle: step.cycle,
    landedSha: step.landed_sha,
    note: step.note,
    indexSlice,
    expiresAt: dispatch.expires_at,
  };
}
