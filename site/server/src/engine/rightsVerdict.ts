/**
 * Gate B's own half of `engine/gates.ts` (BOOK-61, BOOK-222): the dispatch of a flagged step to a
 * rights session, and the answer it records.
 *
 * It lives apart from `gates.ts` at the arch bound. The rule it enforces is the same one the prose
 * gates follow: a step cannot be answered by a session that was not handed it, an answer describes
 * the text the gate was handed (a step's **candidate** while the pass is open), and a `REFUSED`
 * must name a rule of the closed table — a refusal nobody can print is a silent refusal.
 */

import { isRightsRule, rightsRefusalLine } from '../rights/rules.ts';
import type { RightsRuleId } from '../rights/rules.ts';
import { toIso } from '../util/time.ts';
import { readRightsScan } from './helpers.ts';
import { gateTextSha } from './gates.ts';
import { deleteDispatch, getDispatch, getVerdict, upsertDispatch, upsertVerdict, type StepRow, type VerdictRow } from './store.ts';
import { refuse, type EngineDeps } from './types.ts';

/** One bounded line of an answer's prose fields. */
function text(value: unknown, max: number): string {
  const raw = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
  return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
}

export const RIGHTS_ROLE = 'rights' as const;

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
  const textSha = gateTextSha(step);
  if (textSha === null) {
    refuse('NOT_LANDED', 409, `step ${step.step_id} has no landed text and no candidate — a gate cannot bless a file it has not seen`);
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
    landed_sha: textSha,
  });
  return {
    stepId: step.step_id,
    role: RIGHTS_ROLE,
    session,
    pass: step.pass,
    chapter: step.chapter,
    landedSha: textSha,
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
  const textSha = gateTextSha(step);
  if (textSha === null) refuse('NOT_LANDED', 409, 'a verdict for a step with no text is refused (§6A.11)');
  if (dispatch.landed_sha !== null && dispatch.landed_sha !== textSha) {
    refuse('CANDIDATE_MOVED', 409, 'the text moved under the rights gate — read the new candidate');
  }
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
    source: 'model',
  };
  upsertVerdict(db, row);
  // The assignment is consumed by the answer, exactly as a prose gate's is.
  deleteDispatch(db, step.step_id, RIGHTS_ROLE);
  return { verdict: row.verdict as 'CLEAR' | 'REFUSED', rule: answer.rule === null ? null : (answer.rule as RightsRuleId) };
}
