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
import { toIso } from '../util/time.ts';
import { changeForStep, readRightsScan } from './helpers.ts';
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

/**
 * BOOK-173 §7 / BOOK-DOC-80: the plan a gate judges the change against — the closure without its
 * patches (`nodes`/`edges`), the patches the writer produced, and the caps frozen at estimate.
 * `null` only when the step has no plan and the step is not a change/cascade that owed one.
 */
export type PlanEnvelope = {
  outcome: string;
  nodes: unknown[];
  edges: unknown[];
  patches: unknown[];
  bounds: Record<string, unknown>;
};

/**
 * Read the plan of the step's change. A step with no change (a draft, an operator edit) and a
 * change with no plan row (a no-op landing, a change made before plans existed) answer `null`.
 */
export function planEnvelopeOf(db: Db, step: StepRow): PlanEnvelope | null {
  const change = changeForStep(db, step);
  if (change === undefined) return null;
  const row = db
    .prepare('SELECT outcome, closure, patches, bounds FROM change_plans WHERE change_id = ? ORDER BY created_at DESC, id DESC LIMIT 1')
    .get(change.id) as { outcome: string; closure: string; patches: string; bounds: string } | undefined;
  if (row === undefined) return null;
  const closure = JSON.parse(row.closure) as { nodes?: unknown[]; edges?: unknown[] };
  return {
    outcome: row.outcome,
    nodes: closure.nodes ?? [],
    edges: closure.edges ?? [],
    patches: JSON.parse(row.patches) as unknown[],
    bounds: JSON.parse(row.bounds) as Record<string, unknown>,
  };
}

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
  /**
   * BOOK-173 §7: the plan of the step's change — what the closure said this landing is judged
   * against. `null` for a step with no plan (see `planEnvelopeOf`).
   */
  plan: PlanEnvelope | null;
  expiresAt: string;
};

const SEVERITIES = new Set<FindingSeverity>(['blocker', 'major', 'minor']);

/**
 * BOOK-222 — the sha of the text a gate reads. A step's text is its **candidate** while the pass
 * is open (nothing is published before the verdict) and its `landed_sha` once the text is served
 * (a non-provisional landing, a reopened step). `null` means there is no text to read yet.
 */
export function gateTextSha(step: StepRow): string | null {
  return step.candidate_sha ?? step.landed_sha;
}

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

/**
 * §10.8 — what blocks, by the requirements the attempt runs under. Before the widening only a
 * `blocker` stops the text; a widened attempt (the third failure widened the rules) treats a
 * `major` as blocking too. The set is explicit, so no severity silently becomes advisory.
 */
export function hasBlocker(findings: readonly Finding[], widened = false): boolean {
  return findings.some((finding) => finding.severity === 'blocker' || (widened && finding.severity === 'major'));
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
  const textSha = gateTextSha(step);
  if (textSha === null) {
    refuse('NOT_LANDED', 409, `step ${step.step_id} has no landed text and no candidate — a gate cannot bless a file it has not seen`);
  }
  // BOOK-173 §7: a dispatched gate always sees the plan its change stands on — for a **ripple**.
  // The engine writes the plan row in the same transaction that gives a change the `ripple`
  // outcome (`settleLanding`), so a change that says `ripple` and has no plan is an inconsistency:
  // refuse instead of judging the consequences against nothing. A cascade/change that is not a
  // ripple (a continuity cascade, a no-op, a pass that never wrote) legitimately has no closure,
  // and a gate reads it with `plan: null`.
  const change = step.pass === 'change' || step.pass === 'cascade' ? changeForStep(deps.db, step) : undefined;
  if (change?.outcome === 'ripple' && planEnvelopeOf(deps.db, step) === null) {
    refuse('PLAN_MISSING', 409, `change ${change.id} closed as a ripple but has no plan`);
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
    landed_sha: textSha,
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
  const textSha = gateTextSha(step);
  if (textSha === null) {
    refuse('NOT_LANDED', 409, 'a verdict for a step with no text is refused (§6A.11)');
  }
  if (dispatch.landed_sha !== null && dispatch.landed_sha !== textSha) {
    // BOOK-222: the gate read one text and the step now holds another. Its answer describes a
    // text nobody will serve, so it is refused — a gate blesses the candidate it was handed.
    refuse('CANDIDATE_MOVED', 409, `the text moved under the ${answer.role} gate — read the new candidate`);
  }

  const findings = normalizeFindings(answer.findings);
  // §10.8: a widened step checks stricter — `major` blocks as well as `blocker`.
  const widened = step.widened !== null;
  const downgraded = answer.verdict === 'GAP' && !hasBlocker(findings, widened);
  const verdict: 'HOLDS' | 'GAP' = downgraded ? 'HOLDS' : answer.verdict;
  const blocking = verdict === 'GAP' && hasBlocker(findings, widened);
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
    source: 'model',
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
      source: 'model',
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
  // §10.8: a widened attempt checks stricter — the rights gate is no longer skippable on a clean
  // scan; the step cannot close without its answer.
  if (step.widened !== null && getVerdict(db, step.step_id, RIGHTS_ROLE) === undefined) {
    missing.push(RIGHTS_ROLE);
  }
  return missing;
}

/** A `GAP` with a blocker on record for one role — the raw fact, before any cap is applied. */
export function blockingVerdict(db: Db, stepId: string, role: GateRole): boolean {
  const verdict = getVerdict(db, stepId, role);
  if (!verdict || verdict.verdict !== 'GAP') return false;
  const step = db.prepare('SELECT widened FROM steps WHERE step_id = ?').get(stepId) as
    | { widened: string | null }
    | undefined;
  return hasBlocker(normalizeFindings(JSON.parse(verdict.findings) as unknown), step?.widened != null);
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
  plan: PlanEnvelope | null = null,
): GateAssignment {
  return {
    stepId: step.step_id,
    role: dispatch.role as GateRole,
    session: dispatch.session,
    pass: step.pass,
    chapter: step.chapter,
    boundary: step.boundary,
    cycle: step.cycle,
    // BOOK-222: the sha the gate is handed is the step's text — the **candidate** while the pass
    // is open, the published landing otherwise.
    landedSha: gateTextSha(step),
    note: step.note,
    indexSlice,
    plan,
    expiresAt: dispatch.expires_at,
  };
}

// ── Gate B on prose — the conditional rights role (BOOK-61) ───────────────────

/**
 * What a rights session receives. It is its own shape, not a `GateAssignment`: the question is
 * different (may this text be in the book?), the answer is a different enum, and the scan that
 * demanded it is the whole brief — a rule id and the block it hit, never the book.
 */

// BOOK-222: the rights gate's own half (its dispatch and its answer) lives in `rightsVerdict.ts`,
// where a step's **candidate** sha is what it is handed; re-exported so no call site moved.
export {
  openRightsDispatch,
  recordRightsVerdict,
  type RightsAnswer,
  type RightsAssignment,
} from './rightsVerdict.ts';
