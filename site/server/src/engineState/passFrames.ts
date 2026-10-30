/**
 * BOOK-DOC-84 §2.1 #14/#16 — the pass's own frames, from the log the engine already writes.
 *
 * `step.opened` is a claim (`pass:accepted`), `step.closed` the close (`pass:closed`). Both read
 * the step's own row: its lane, its pass, its outcome — and, for `refused`, the writer's own
 * `refused` stage on that pass (a park), never an inference from a sentence. `sweep` is an
 * operator pass with no reader surface and is not announced.
 */

import {
  DESPERATE_ATTEMPT,
  DESPERATE_DEADLINE_MS,
  MAX_ATTEMPTS,
  STEP_WALL_MS,
  widenedWord,
  type PassAcceptedPayload,
  type PassClosedPayload,
  type PassKind,
  type ServerEventType,
  type WidenedNote,
} from '@book/shared';

import type { Db } from '../db/db.ts';
import { readCascadeRow, readStepRow } from './changes.ts';
import type { StepRow } from './rows.ts';

export type PassEmit = (type: Exclude<ServerEventType, 'hello' | 'state:snapshot'>, data: unknown) => void;

export type PassNarratorDeps = { db: Db; emit: PassEmit };

/** The pass domain's cursor, primed past the log a restart must not replay. */
export class PassNarrator {
  private cursor = 0;
  private readonly deps: PassNarratorDeps;

  constructor(deps: PassNarratorDeps) {
    this.deps = deps;
  }

  prime(replay: boolean): void {
    if (replay) {
      this.cursor = 0;
      return;
    }
    const row = this.deps.db.prepare('SELECT MAX(hseq) AS hseq FROM events').get() as { hseq: number | null };
    this.cursor = row.hseq ?? 0;
  }


  /** `step.opened` → `pass:accepted`; `step.closed` → `pass:closed`; nothing else. */
  /** One poll: every `step.opened`/`step.closed` past the cursor, in `hseq` order. */
  tick(): number {
    const rows = this.deps.db
      .prepare(
        `SELECT hseq, at, kind, step_id, chapter, payload FROM events
          WHERE hseq > ? AND kind IN ('step.opened','step.closed') ORDER BY hseq`,
      )
      .all(this.cursor) as Array<{ hseq: number; at: string; kind: string; step_id: string | null; chapter: number | null; payload: string }>;
    let emitted = 0;
    for (const row of rows) {
      this.cursor = row.hseq;
      if (row.step_id === null) continue;
      const step = readStepRow(this.deps.db, row.step_id);
      if (step === undefined) continue;
      const pass = passKindOf(step.pass);
      if (pass === null) continue;
      if (row.kind === 'step.opened') {
        const accepted = this.acceptedPayload(step, pass, row.at);
        // A front pass has no chapter to open: its claim would be a number the step never named.
        if (accepted === null) continue;
        this.deps.emit('pass:accepted', accepted);
        emitted += 1;
        continue;
      }
      this.deps.emit('pass:closed', this.closedPayload(step, pass, row.at));
      emitted += 1;
    }
    return emitted;
  }

  private acceptedPayload(step: StepRow, pass: PassKind, at: string): PassAcceptedPayload | null {
    // A change's claim is `change:processing`; this frame is the draft/premise claim, and a
    // premise is not in the filing queue (BOOK-7), so it has no place in line to announce.
    // BOOK-220 — a `front` step has no chapter (`live.passes` names it `'front'`), so a claim
    // that needs one is not invented: the pass is announced by its stages and its close.
    if (step.chapter === null) return null;
    // §10.8: the attempt is the step's own lease count; a desperate step is always 6 of 6.
    const leases = this.deps.db.prepare('SELECT COUNT(*) AS n FROM leases WHERE step_id = ?').get(step.step_id) as {
      n: number;
    };
    const desperate = step.desperate === 1;
    const attempt = desperate ? DESPERATE_ATTEMPT : Math.max(1, Math.min(MAX_ATTEMPTS, leases.n));
    const widened: WidenedNote | null =
      step.widened === null ? null : { code: step.widened as WidenedNote['code'], sentence: widenedWord(step.widened) };
    const atMs = Date.parse(at);
    return {
      stepId: step.step_id,
      chapter: step.chapter,
      lane: step.lane,
      pass,
      premiseChangeId: step.premise_change,
      at: atMs,
      ahead: 0,
      attempt,
      maxAttempts: desperate ? DESPERATE_ATTEMPT : Math.max(attempt, MAX_ATTEMPTS),
      widened,
      desperate,
      // §10.8: the attempt's own bound — a desperate attempt is a dispatch (180 s), not work.
      deadlineAt: atMs + (desperate ? DESPERATE_DEADLINE_MS : STEP_WALL_MS),
      // §10.8: a re-issued attempt (more than one lease) says when it came back; a first claim
      // has nothing to announce as a retry.
      retryAt: attempt > 1 ? atMs : null,
    };
  }

  private closedPayload(step: StepRow, pass: PassKind, at: string): PassClosedPayload {
    // BOOK-DOC-84 #16: the step's own outcome, and `refused` only when the writer said so — its
    // `refused` stage is that pass's own word for a park, never an inference from a sentence.
    const refused =
      step.outcome === 'escalated' &&
      this.deps.db.prepare(`SELECT 1 AS one FROM pass_stages WHERE pass_id = ? AND stage = 'refused' LIMIT 1`).get(step.step_id) !==
        undefined;
    const outcome: PassClosedPayload['outcome'] =
      step.outcome === null
        ? 'gone'
        : step.outcome === 'interrupted'
          ? 'interrupted'
          : step.outcome === 'escalated'
            ? refused
              ? 'refused'
              : 'escalated'
            : step.outcome === 'holds' || step.outcome === 'evaluated'
              ? 'holds'
              : 'closed';
    const spend = this.deps.db.prepare('SELECT usd, priced, tokens_in, tokens_out FROM pass_spend WHERE pass_id = ?').get(step.step_id) as
      | { usd: number; priced: number; tokens_in: number; tokens_out: number }
      | undefined;
    return {
      stepId: step.step_id,
      changeId: this.changeOfStep(step),
      chapter: step.chapter,
      pass,
      outcome,
      sentence: step.note ?? '',
      at: Date.parse(at),
      // The engine recorded an interrupted close: the pass did not land its own close.
      closeFailed: outcome === 'interrupted',
      costUsd: spend === undefined || spend.priced !== 1 ? null : spend.usd,
      tokens: spend === undefined ? null : { in: spend.tokens_in, out: spend.tokens_out },
    };
  }


  /**
   * Which change a step serves: a cascade's own change, else the lease's (a `change` pass leases
   * the change it repairs), else the premise a draft consumes. `null` for a plain chapter draft.
   */
  private changeOfStep(step: StepRow): string | null {
    if (step.cascade_id !== null) {
      const cascade = readCascadeRow(this.deps.db, step.cascade_id);
      if (cascade !== undefined) return cascade.change_id;
    }
    if (step.lease_id !== null) {
      const lease = this.deps.db.prepare('SELECT change_id FROM leases WHERE id = ?').get(step.lease_id) as
        | { change_id: string | null }
        | undefined;
      if (lease !== undefined && lease.change_id !== null) return lease.change_id;
    }
    return step.premise_change;
  }


}

/** The five pass kinds a reader's page names; `sweep` is an operator pass with no surface. */
export function passKindOf(pass: StepRow['pass']): PassKind | null {
  switch (pass) {
    case 'draft':
    case 'change':
    case 'cascade':
    case 'front':
    case 'ending':
      return pass;
    default:
      return null;
  }
}
