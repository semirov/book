/**
 * A ripple chapter's close never writes the origin's verification record (BOOK-173 review,
 * BOOK-DOC-80 §"The record").
 *
 * `change_plans` is one row per change, and its `chapter` is the change's own. A ripple chapter is
 * its own normal pass with its own lease — a lease that carries the **origin's** `changeId` — so
 * the close used to update that one row by id alone: a ripple chapter that ran locally rewrote the
 * origin's `gates_mode` `full` → `local only`, replaced its judge's word and price, and reset
 * `sample_requested`, dropping a queued sample and pointing the audit at the wrong chapter.
 *
 * The record is now keyed by `(change_id, chapter)` and the closing step: the origin's own landing
 * writes it, a ripple chapter's close writes nothing and carries the code on `step.closed`
 * (`verificationRefused`). Both directions are pinned here — a full origin under a local ripple,
 * and a local origin whose queued sample a full ripple must not clear.
 */

import type { WriterAssignment } from '@book/shared';
import { describe, expect, it } from 'vitest';

import type { GateAssignment } from '../../src/engine/gates.ts';
import { storePlan, type RipplePlan } from '../../src/ledger/graph/plan.ts';
import { markWriterBoot, sampleQueue } from '../../src/ledger/graph/verification.ts';
import { PIPELINE_MODEL, chapterText, createEngineFixture, submitRights, type Fixture } from './helpers.ts';

const ORIGIN = 5;
const RIPPLE = 12;

const ORIGIN_BLOCK = 'Допуск всё ещё выдан.';
const RIPPLE_BLOCK = 'По допуску прошли.';

function fixture(): Fixture {
  return createEngineFixture({
    chapters: {
      [ORIGIN]: chapterText('Пятая глава', ['Смена выдала пропуск.', ORIGIN_BLOCK]),
      [RIPPLE]: chapterText('Двенадцатая глава', ['Сторож ждал у ворот.', RIPPLE_BLOCK]),
    },
  });
}

/** The chapter's own text with one phrase replaced — a patch, not a rewrite. */
function patched(fixtureNow: Fixture, chapter: number, from: string, to: string): string {
  const raw = fixtureNow.readChapter(chapter);
  if (raw === null || !raw.includes(from)) throw new Error(`fixture ch${String(chapter)} has no «${from}»`);
  return raw.replace(from, to);
}

function verdict(fixtureNow: Fixture, role: 'editor' | 'consultant'): void {
  const gate = fixtureNow.engine.next({ role, session: `${role}-1` }) as GateAssignment | null;
  if (!gate) throw new Error(`no ${role} assignment`);
  fixtureNow.engine.verdict(gate.stepId, {
    role,
    session: gate.session,
    verdict: 'HOLDS',
    findings: [],
    model: PIPELINE_MODEL,
    tokensIn: 100,
    tokensOut: 10,
  });
}

type OriginPass = { changeId: string; stepId: string; leaseId: string };

/** The origin's own landing: a point patch on a written chapter. */
function landOrigin(fixtureNow: Fixture): OriginPass {
  const enqueued = fixtureNow.engine.enqueue({
    kind: 'operator',
    chapter: ORIGIN,
    intent: 'в главе 5 меняется статус допуска',
    scopeHint: 'phrase',
  });
  const assignment = fixtureNow.engine.next({ for: 'fwd', session: 'writer-origin' }) as WriterAssignment | null;
  if (assignment === null) throw new Error('the fixture offered no origin pass');
  fixtureNow.engine.start(assignment.leaseId);
  fixtureNow.writeChapter(ORIGIN, patched(fixtureNow, ORIGIN, ORIGIN_BLOCK, 'Допуск отозван.'));
  fixtureNow.engine.land(assignment.leaseId);
  return { changeId: enqueued.id, stepId: assignment.stepId, leaseId: assignment.leaseId };
}

/**
 * The change the origin closed, as the ripple the engine records: a plan whose one mandatory node
 * is the chapter about to be patched. The engine plans the closure at the origin's land; this
 * fixture chapter has no earlier revision to diff against, so the test writes the plan the land
 * would have frozen (`storePlan` is idempotent per change, exactly as there).
 */
function seedRipplePlan(fixtureNow: Fixture, changeId: string): void {
  const plan: RipplePlan = {
    changeId,
    chapter: ORIGIN,
    outcome: 'ripple',
    proven: true,
    seeds: [],
    nodes: [
      {
        factId: 'f:doc:допуск@ch12#status',
        chapter: RIPPLE,
        blockId: null,
        mandatory: true,
        reason: 'CAUSE_CHANGED:edg_doc_12',
        direction: 'descendant',
        hops: 1,
        via: '',
        quote: RIPPLE_BLOCK,
      },
    ],
    edges: [],
    edgeDetail: [],
    patches: [],
    closureSize: { nodes: 1, edges: 0, chapters: 2, parts: 1 },
    chaptersTouched: [ORIGIN, RIPPLE],
    bounds: { chars: 4_000, usd: 0.6, iterations: 4, nodes: 1_500, edges: 3_000 },
    unresolved: [],
    truncated: false,
  };
  storePlan(fixtureNow.db, plan, '2026-10-25T09:00:00Z');
}

/** The ripple chapter's own pass: a lease carrying the origin's `changeId`, landed but not closed. */
function landRippleChapter(fixtureNow: Fixture, changeId: string): WriterAssignment {
  const own = fixtureNow.engine.openChapterPass(RIPPLE, 'writer-ripple', changeId) as WriterAssignment | null;
  if (own === null) throw new Error('the ripple door opened no step');
  fixtureNow.engine.start(own.leaseId);
  fixtureNow.writeChapter(RIPPLE, patched(fixtureNow, RIPPLE, RIPPLE_BLOCK, 'Допуск не проверили.'));
  fixtureNow.engine.land(own.leaseId);
  return own;
}

type PlanRecord = {
  gates_mode: string | null;
  tier1_verdict: string | null;
  tier1_usd: number | null;
  sample_requested: number;
};

function record(fixtureNow: Fixture, changeId: string): PlanRecord {
  return fixtureNow.db
    .prepare('SELECT gates_mode, tier1_verdict, tier1_usd, sample_requested FROM change_plans WHERE change_id = ?')
    .get(changeId) as PlanRecord;
}

function closedPayload(fixtureNow: Fixture, stepId: string): Record<string, unknown> {
  const row = fixtureNow.db
    .prepare(`SELECT payload FROM events WHERE kind = 'step.closed' AND step_id = ?`)
    .get(stepId) as { payload: string };
  return JSON.parse(row.payload) as Record<string, unknown>;
}

describe('a ripple chapter closes beside the origin’s record', () => {
  it('a ripple chapter that ran locally leaves the origin’s full pair and its sample flag alone', () => {
    const fixtureNow = fixture();
    try {
      const origin = landOrigin(fixtureNow);
      seedRipplePlan(fixtureNow, origin.changeId);
      verdict(fixtureNow, 'editor');
      verdict(fixtureNow, 'consultant');
      submitRights(fixtureNow);
      fixtureNow.engine.done(origin.leaseId, {
        seams: [],
        model: PIPELINE_MODEL,
        verification: { gatesMode: 'full', why: 'closure_non_empty', tier1Verdict: 'HOLDS', tier1Usd: 0.004 },
      });
      expect(record(fixtureNow, origin.changeId)).toEqual({
        gates_mode: 'full',
        tier1_verdict: 'HOLDS',
        tier1_usd: 0.004,
        sample_requested: 0,
      });

      const ripple = landRippleChapter(fixtureNow, origin.changeId);
      submitRights(fixtureNow);
      fixtureNow.engine.done(ripple.leaseId, {
        seams: [],
        model: PIPELINE_MODEL,
        // A local-only pair: the chapter's own text, judged locally. Without the chapter guard
        // this is the close that rewrites the origin's row.
        verification: { gatesMode: 'local only', why: null, tier1Verdict: 'HOLDS', tier1Usd: 0.002 },
      });

      // The origin keeps the pair that judged it, its price, and no queued sample.
      expect(record(fixtureNow, origin.changeId)).toEqual({
        gates_mode: 'full',
        tier1_verdict: 'HOLDS',
        tier1_usd: 0.004,
        sample_requested: 0,
      });
      // No second row: the plan is one per change, and the ripple chapter has none of its own.
      expect(fixtureNow.db.prepare('SELECT COUNT(*) AS n FROM change_plans').get()).toEqual({ n: 1 });
      expect(sampleQueue(fixtureNow.db, 3)).toEqual([]);
      // The refusal is a code on the ripple step's history, never a silent write.
      expect(closedPayload(fixtureNow, ripple.stepId).verificationRefused).toBe('CHAPTER_MISMATCH');
      // The origin's own close wrote no refusal: its close is the change's landing.
      expect(closedPayload(fixtureNow, origin.stepId).verificationRefused).toBeUndefined();
    } finally {
      fixtureNow.close();
    }
  });

  it('a ripple chapter that ran the full pair does not clear the sample the origin queued', () => {
    const fixtureNow = fixture();
    try {
      // The first local-only change after a writer boot is always sampled: the origin queues one.
      markWriterBoot(fixtureNow.db, '01JBOOTULID');
      const origin = landOrigin(fixtureNow);
      seedRipplePlan(fixtureNow, origin.changeId);
      submitRights(fixtureNow);
      fixtureNow.engine.done(origin.leaseId, {
        seams: [],
        model: PIPELINE_MODEL,
        verification: { gatesMode: 'local only', why: null, tier1Verdict: 'HOLDS', tier1Usd: 0.003 },
      });
      expect(record(fixtureNow, origin.changeId)).toEqual({
        gates_mode: 'local only',
        tier1_verdict: 'HOLDS',
        tier1_usd: 0.003,
        sample_requested: 1,
      });

      const ripple = landRippleChapter(fixtureNow, origin.changeId);
      verdict(fixtureNow, 'editor');
      verdict(fixtureNow, 'consultant');
      submitRights(fixtureNow);
      fixtureNow.engine.done(ripple.leaseId, {
        seams: [],
        model: PIPELINE_MODEL,
        verification: { gatesMode: 'full', why: 'chapter_edge', tier1Verdict: 'HOLDS', tier1Usd: 0.005 },
      });

      // The queued sample is still the origin's: a close that is not the change's own landing may
      // never clear `sample_requested`, nor claim a pair for a chapter it did not close.
      expect(record(fixtureNow, origin.changeId)).toEqual({
        gates_mode: 'local only',
        tier1_verdict: 'HOLDS',
        tier1_usd: 0.003,
        sample_requested: 1,
      });
      expect(sampleQueue(fixtureNow.db, 3).map((sample) => sample.changeId)).toEqual([origin.changeId]);
      expect(closedPayload(fixtureNow, ripple.stepId).verificationRefused).toBe('CHAPTER_MISMATCH');
    } finally {
      fixtureNow.close();
    }
  });
});
