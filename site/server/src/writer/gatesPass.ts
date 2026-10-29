/**
 * The gates a pass runs, in one place (BOOK-173, BOOK-DOC-80 §"The tiers").
 *
 * Two shapes, one interface. The **full pair** is what a chapter has always got: the editor, then
 * the consultant when the editor asked for no revision, then Gate B, with one revision cycle for
 * the whole pass. `local only` is the new shape: the pair is not run at all — the local judge
 * (`verify/tier1.ts`) already answered the prose question and the policy (`verify/policy.ts`)
 * decided the change did not need a chapter read. Gate B still runs: the law's question is not a
 * prose judgement, and a clean scan costs no call («скан чистый, модель не звана»).
 *
 * It lives outside `pass.ts` because the pass is at the 500-line wall and this is a rule with its
 * own branch, not a step of the sequence: `pass.ts` decides *whether* a pair is needed, this module
 * says what running one means.
 */

import type { GateRoleName, GateFinding } from './gates.ts';
import type { GateRun, Lane } from './passLane.ts';
import { failureOf, isTransportFailure, readerFallbacks, type Failure } from './reasons.ts';

/** One gate's revision in a pass, whatever the engine's cycle cap allows. */
const MAX_REVISIONS = 1;

export type GatesOutcome =
  /**
   * The gates spoke (or were not asked): the pass goes on to `landed` and `done`. `survived` is a
   * failure the pass lived through — the close's refusal (`VERDICTS_REQUIRED`) is what brings it
   * back into words, which is why the pass keeps it.
   */
  | {
      kind: 'done';
      survived: Failure | null;
      /** The text as it stands after the last revision, when a revision landed. */
      revised?: string;
    }
  /** The pass must stop: a rights refusal closed the step, or a gate broke the pass. */
  | { kind: 'park'; failure: Failure; fallback: string; revised?: string }
  /** Gate B refused the text and the engine closed the step: no `done`, no revision. */
  | { kind: 'rights' };

export type GatesInput = {
  lane: Lane;
  log: (line: string) => void;
  /** Whether the pair runs at all. `local only` runs Gate B alone. */
  full: boolean;
  /** The lane's per-role record: a revision clears the verdicts the engine already took. */
  answered: Record<GateRoleName | 'rights', boolean>;
};

type Round =
  | { ok: true; editor: GateRun; consultant: GateRun | null; rightsClosed: boolean }
  | { ok: false; failure: Failure };

/**
 * One gate round: the editor, then the consultant when the editor asks for no revision, then
 * Gate B. A failure here is the pass's failure with its own code, never a bare `Error`.
 */
async function gateRound(lane: Lane, refusal?: string | null): Promise<Round> {
  try {
    const editor = await lane.runGate('editor', refusal ?? null);
    const consultant = editor.revise ? null : await lane.runGate('consultant', refusal ?? null);
    // BOOK-61: Gate B last, and it may close the step itself — a refusal is a decision about
    // the text, so there is nothing left for this pass to finish.
    const rights = await lane.runRightsGate();
    return { ok: true, editor, consultant, rightsClosed: rights.closed };
  } catch (error) {
    return { ok: false, failure: failureOf(error) };
  }
}

/** Gate B alone, for a change the pair did not read. */
async function rightsOnly(input: GatesInput): Promise<GatesOutcome> {
  try {
    const rights = await input.lane.runRightsGate();
    return rights.closed ? { kind: 'rights' } : { kind: 'done', survived: null };
  } catch (error) {
    const failure = failureOf(error);
    // A rights answer is not auxiliary: the step cannot close without it.
    return { kind: 'park', failure, fallback: readerFallbacks.gate };
  }
}

/**
 * Run the gates this change needs. A refusal the engine states (`LEASE_RELEASED`, `STEP_CLOSED`)
 * comes back as `park` with its code: the caller asks `goneOf` first, because a step the engine
 * took away is a scheduling event and not a park.
 */
export async function runGates(input: GatesInput): Promise<GatesOutcome> {
  if (!input.full) return rightsOnly(input);

  let revisions = 0;
  let failed: Failure | null = null;
  /** The last revision this pass landed: what its own way back must read (BOOK-173 + BOOK-219). */
  let revised: string | undefined;
  for (;;) {
    let round = await gateRound(input.lane);
    // A transport failure and a refused answer both get one retry; the parse failure carries
    // its own reason back to the model, so the second answer can be the one that parses.
    if (!round.ok && (isTransportFailure(round.failure) || round.failure.code === 'GATE_UNPARSED')) {
      input.log(`[writer] гейт не спрошен (${round.failure.code ?? 'транспорт'}): ${round.failure.detail.slice(0, 200)} — повтор`);
      round = await gateRound(input.lane, round.failure.detail);
    }
    if (!round.ok) {
      // A rights failure is not auxiliary: the step cannot close without an answer, so the
      // pass stops here with a sentence instead of walking into `RIGHTS_REQUIRED`.
      const code = round.failure.code ?? '';
      if (code.startsWith('RIGHTS') || code === 'GATE_UNPARSED') {
        return { kind: 'park', failure: round.failure, fallback: readerFallbacks.gate, ...(revised === undefined ? {} : { revised }) };
      }
      failed = round.failure;
      break;
    }
    const { editor, consultant, rightsClosed } = round;
    if (rightsClosed) return { kind: 'rights' };
    if (!editor.revise && consultant?.revise !== true) break;
    if (revisions >= MAX_REVISIONS) break;
    revisions += 1;
    const findings: GateFinding[] = [...editor.findings, ...(consultant?.findings ?? [])];
    const next = await input.lane.reviseText(findings);
    if (next === null) {
      return {
        kind: 'park',
        failure: { code: null, detail: 'правка после замечаний гейта не прошла проверку' },
        fallback: readerFallbacks.stopped,
        ...(revised === undefined ? {} : { revised }),
      };
    }
    revised = next;
    input.answered.editor = false;
    input.answered.consultant = false;
    input.answered.rights = false;
  }
  if (failed !== null) {
    // Remembered, not fatal: the transcript is where a survived failure is proved.
    input.log(`[writer] гейт не ответил (${failed.code ?? 'без кода'}): ${failed.detail} — шаг закрывается`);
    input.lane.remember(failed);
  }
  return { kind: 'done', survived: failed, ...(revised === undefined ? {} : { revised }) };
}
