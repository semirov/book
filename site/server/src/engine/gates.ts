/**
 * The two hidden gates (ARCHITECTURE.md §6B.3, §6B.4).
 *
 * The engine does not judge prose and does not call a model: it enforces completeness,
 * order and the cycle cap. A step cannot close without both verdicts; a consultant verdict
 * cannot exist before the editor's; a verdict cannot arrive from a session that was not
 * handed the step; and a `GAP` without a `blocker` is a matter of taste, which the engine
 * downgrades to `HOLDS` and records.
 *
 * BOOK-76 — the cap's consequence splits by role: an editor blocker is published with its
 * finding, a consultant blocker stops the step instead. «Physics failed» and «prose judged»
 * are not the same fact and must not share one outcome.
 */

import type { Finding, FindingSeverity, GateRole } from '@book/shared';
import { normalizeRetroMode } from '@book/shared';

import type { Db } from '../db/db.ts';
import { isRightsRule, rightsRefusalLine, type RightsRuleId } from '../rights/rules.ts';
import { toIso } from '../util/time.ts';
import { readRightsScan } from './helpers.ts';
import { requirePipelineModel } from './model.ts';
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

/**
 * BOOK-61 — Gate B is **conditional**: the `rights` role exists only when a step's scan
 * flagged. It is not in `GATE_ROLES`, because a step does not owe that answer; it owes it
 * only when the deterministic scan could not clear the text.
 */
export const RIGHTS_ROLE = 'rights' as const;

/** The passes that write prose of their own — the ones Gate B always answers. */
export const PROSE_PASSES: ReadonlySet<string> = new Set(['draft', 'change', 'cascade', 'sweep']);

export type MissingVerdict = GateRole | typeof RIGHTS_ROLE;

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

/** A blocker stops the step outright; a major demands a repair pass before any close. */
export function hasBlocker(findings: readonly Finding[]): boolean {
  return findings.some((finding) => finding.severity === 'blocker');
}

/** BOOK-179: a major is not a taste. `HOLDS` means no majors and no blockers; minors are notes. */
export function hasMajorOrBlocker(findings: readonly Finding[]): boolean {
  return findings.some((finding) => finding.severity === 'blocker' || finding.severity === 'major');
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
  /** 1 = the engine downgraded a minors-only GAP to HOLDS. */
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
  // ADR-038: a verdict names the model that answered, and it must be the pipeline's — refused
  // before the dispatch is consumed, so a refused verdict changes nothing.
  const model = requirePipelineModel(deps.config, answer.model, 'verdict');
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
  // BOOK-179 (the editor's finding, 2026-10-28): a GAP is downgraded only when **all** its
  // findings are minors. A major survives: the chapter is not healthy, and the pass must repair.
  const downgraded = answer.verdict === 'GAP' && !hasMajorOrBlocker(findings);
  const verdict: 'HOLDS' | 'GAP' = downgraded ? 'HOLDS' : answer.verdict;
  const blocking = verdict === 'GAP';
  const cycles = step.cycle;
  const late = dispatch.expires_at <= at;

  upsertVerdict(db, {
    step_id: step.step_id,
    role: answer.role,
    verdict,
    findings: JSON.stringify(findings),
    cycles,
    model,
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
    } else if (cycles >= deps.config.gateCycles) {
      // BOOK-76: the cap publishes a prose judgement with its finding, but a physics claim
      // that does not hold never lands — the step stops and the ripple decides what follows.
      action = answer.role === 'consultant' ? 'close' : 'publish_with_finding';
    } else {
      action = 'revise';
    }
  }

  return {
    verdict: {
      step_id: step.step_id,
      role: answer.role,
      verdict,
      findings: JSON.stringify(findings),
      cycles,
      model,
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
export function missingVerdicts(db: Db, step: StepRow): MissingVerdict[] {
  const missing: MissingVerdict[] = GATE_ROLES.filter((role) => getVerdict(db, step.step_id, role) === undefined);
  // BOOK-61: a **flagged** scan makes Gate B mandatory — the law's question is answered before
  // the step closes. A clean scan is answered too by this lane (the owner, 2026-10-28: a clean
  // verdict, not a skip), but it is not a precondition of a close: a caller that never asks
  // closes on the two prose verdicts, exactly as before this rule existed.
  if (readRightsScan(step)?.verdict === 'flag' && getVerdict(db, step.step_id, RIGHTS_ROLE) === undefined) {
    missing.push(RIGHTS_ROLE);
  }
  return missing;
}

/** A `GAP` with a blocker on record for one role — the raw fact, before any cap is applied. */
export function blockingVerdict(db: Db, stepId: string, role: GateRole): boolean {
  const verdict = getVerdict(db, stepId, role);
  if (!verdict || verdict.verdict !== 'GAP') return false;
  // After the downgrade rule a GAP always carries a major or a blocker: it blocks the close.
  return hasMajorOrBlocker(normalizeFindings(JSON.parse(verdict.findings) as unknown));
}

/**
 * A blocker that survived the cycle cap, scoped to one role (BOOK-76). An editor's is
 * published with its finding; a consultant's stops the step — the two consequences are not
 * interchangeable, so the question is asked per role rather than per step.
 */
export function survivedBlocker(
  db: Db,
  stepId: string,
  gateCycles: number,
  cycle: number,
  role: GateRole,
): boolean {
  return cycle >= gateCycles && blockingVerdict(db, stepId, role);
}

export function assignmentOf(
  step: StepRow,
  dispatch: DispatchRow,
  indexSlice: string | null = null,
): GateAssignment {
  return {
    stepId: step.step_id,
    role: dispatch.role as GateRole,
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

// ── Gate B on prose — the conditional rights role (BOOK-61) ───────────────────

/**
 * What a rights session receives. It is its own shape, not a `GateAssignment`: the question is
 * different (may this text be in the book?), the answer is a different enum, and the scan that
 * demanded it is the whole brief — a rule id and the block it hit, never the book.
 */
export type RightsAssignment = {
  stepId: string;
  role: typeof RIGHTS_ROLE;
  session: string;
  pass: string;
  chapter: number | null;
  landedSha: string | null;
  /** The rule the scan flagged, so the session does not have to guess the question; `null` = clean. */
  rule: string | null;
  block: number | null;
  expiresAt: string;
};

/** Hand a flagged step to a rights session. Order does not apply: B is not one of the two prose gates. */
export function openRightsDispatch(deps: EngineDeps, step: StepRow, session: string): RightsAssignment {
  const now = deps.clock.now();
  const at = toIso(now);
  if (step.outcome !== null) refuse('STEP_CLOSED', 409, `step ${step.step_id} is closed`);
  if (step.landed_at === null) {
    refuse('NOT_LANDED', 409, `step ${step.step_id} has no landed text — a gate cannot bless a file it has not seen`);
  }
  // A `clear` scan is still answered (owner, 2026-10-28): the writer submits the clean verdict
  // mechanically, so the record says what was checked instead of saying nothing. A `flag` is the
  // question this gate exists for, and `rule` names it.
  const scan = readRightsScan(step);
  const rule = scan?.verdict === 'flag' ? scan.rule : null;
  if (getVerdict(deps.db, step.step_id, RIGHTS_ROLE)) {
    refuse('GATE_ANSWERED', 409, `the rights gate already answered step ${step.step_id}`);
  }
  const existing = getDispatch(deps.db, step.step_id, RIGHTS_ROLE);
  if (existing && existing.session !== session && existing.expires_at > at) {
    refuse('GATE_TAKEN', 409, `step ${step.step_id} is being read by another rights session`);
  }
  const expiresAt = toIso(now + deps.config.gateTtlMs);
  upsertDispatch(deps.db, {
    step_id: step.step_id,
    role: RIGHTS_ROLE,
    session,
    dispatched_at: existing && existing.session === session ? existing.dispatched_at : at,
    expires_at: expiresAt,
  });
  return {
    stepId: step.step_id,
    role: RIGHTS_ROLE,
    session,
    pass: step.pass,
    chapter: step.chapter,
    landedSha: step.landed_sha,
    rule,
    block: scan !== null && scan.verdict === 'flag' ? (scan.block ?? null) : null,
    expiresAt,
  };
}

export type RightsAnswer = {
  role: typeof RIGHTS_ROLE;
  verdict: 'CLEAR' | 'REFUSED';
  /** Required for `REFUSED` (an id from `rights/rules.ts`), forbidden for `CLEAR`. */
  rule: string | null;
  model: string;
  tokensIn: number;
  tokensOut: number;
};

/**
 * Record Gate B's answer for a step. The engine validates the rule against the closed table
 * and refuses a refusal it cannot print — a `REFUSED` without a sentence would be a silent
 * refusal, and a `CLEAR` that names a rule would be a second, contradictory answer. Nothing
 * here judges prose; it stores what the session said, under the session it was handed.
 */
export function recordRightsVerdict(
  deps: EngineDeps,
  step: StepRow,
  answer: RightsAnswer,
  session: string,
): { verdict: 'CLEAR' | 'REFUSED'; rule: string | null } {
  const db = deps.db;
  const at = toIso(deps.clock.now());
  const dispatch = getDispatch(db, step.step_id, RIGHTS_ROLE);
  if (!dispatch) refuse('GATE_NOT_DISPATCHED', 409, `no rights gate was dispatched for step ${step.step_id}`);
  if (dispatch.session !== session) {
    refuse('GATE_NOT_DISPATCHED', 409, `step ${step.step_id} was dispatched to another session`);
  }
  if (step.landed_at === null) refuse('NOT_LANDED', 409, 'a verdict for an unlanded file is refused (§6A.11)');
  if (answer.verdict === 'CLEAR' && answer.rule !== null) {
    refuse('RIGHTS_RULE_WITH_CLEAR', 422, 'a CLEAR names no rule');
  }
  if (answer.verdict === 'REFUSED') {
    if (answer.rule === null) refuse('RIGHTS_RULE_REQUIRED', 422, 'a REFUSED needs a rule id');
    if (!isRightsRule(answer.rule) || rightsRefusalLine(answer.rule) === null) {
      refuse('RIGHTS_RULE_UNKNOWN', 422, `${answer.rule} is not in the rights table`);
    }
  }

  const findings = answer.rule === null ? [] : [{ rule: answer.rule }];
  const row: Omit<VerdictRow, 'late'> & { late: number } = {
    step_id: step.step_id,
    role: RIGHTS_ROLE,
    verdict: answer.verdict,
    findings: JSON.stringify(findings),
    cycles: step.cycle,
    model: text(answer.model, 120) || 'stub',
    tokens_in: Math.max(0, Math.trunc(answer.tokensIn)),
    tokens_out: Math.max(0, Math.trunc(answer.tokensOut)),
    at,
    late: dispatch.expires_at <= at ? 1 : 0,
  };
  upsertVerdict(db, row);
  // The assignment is consumed by the answer, exactly as a prose gate's is.
  deleteDispatch(db, step.step_id, RIGHTS_ROLE);
  return { verdict: row.verdict as 'CLEAR' | 'REFUSED', rule: answer.rule === null ? null : (answer.rule as RightsRuleId) };
}
