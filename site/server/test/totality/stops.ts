/**
 * The close's own three stops — science, delta, ending — one cell each. They are not ladders: the
 * failure that used to publish first and put its own text back is now the refusal sink, and each
 * builder proves the step's own boundary (a physics blocker that survived the cap, a repair that
 * replaced too much, an ending's GAP) ends in `void · dropped` with the boundary's sentence.
 */

import type { WriterAssignment } from '@book/shared';
import { expect } from 'vitest';

import { closeReason } from '../../src/engine/cascade.ts';
import { readChapterRows } from '../../src/engine/text.ts';
import { CHAPTER, longAnswer, type Cell, type Want } from './chain.ts';
import { placedFiling } from './stages.ts';
import type { Context } from '../filingTriageHarness.ts';

// ── the close's own stops: science, delta, ending (one cell each) ────────────────────────────

/** 1 215 characters, under the wall bound — the same filler block the chain's chapter is made of. */
const FILLER = 'служебный абзац для проверки объёма страницы, он не является текстом книги. ';
const LONG_BLOCK = FILLER.repeat(16).trim();

/** One blocker a physics verdict carries: the shape the gates normalise. */
const BLOCKER = [
  { severity: 'blocker' as const, location: 'глава 8, абзац 2', defect: 'свет приходит раньше, чем мог', fix: 'дать сигналу носитель и задержку' },
];

/** A chapter rewritten from scratch: every block new, so a ripple's delta bound is crossed. */
function rewrittenChapter(): string {
  const blocks = Array.from({ length: 10 }, (_, index) => `${LONG_BLOCK} вариант ${String(index)}`);
  return `Глава восемь\n\n${blocks.join('\n\n')}\n`;
}

async function claimed(ctx: Context, session: string): Promise<WriterAssignment> {
  const job = ctx.engine.next({ for: 'filing', session }) as WriterAssignment | null;
  expect(job, `a job for ${session}`).not.toBeNull();
  return job as WriterAssignment;
}

async function answerGate(
  ctx: Context,
  role: 'editor' | 'consultant',
  verdict: 'HOLDS' | 'GAP',
  findings: Array<{ severity: 'blocker'; location: string; defect: string; fix: string }> = [],
): Promise<void> {
  const gate = await ctx.client.nextGate(role, `gate-${role}`);
  expect(gate, `${role} dispatch`).not.toBeNull();
  await ctx.client.verdict({
    stepId: gate!.stepId,
    role,
    session: gate!.session,
    verdict,
    findings,
    model: ctx.config.model,
    tokensIn: 120,
    tokensOut: 12,
  });
}

/**
 * The physics stop: the consultant's blocker survives the cycle cap on an ordinary change step.
 * The candidate was never published, so the refusal drops it and the chapter does not move.
 */
export async function scienceStop(ctx: Context): Promise<{ cell: Cell; want: Want }> {
  const cell = await placedFiling(ctx);
  const job = await claimed(ctx, 'writer-science');
  expect(job.changeId).toBe(cell.changeId);
  await ctx.client.start(job.leaseId);
  await ctx.client.land(job.leaseId, { text: longAnswer(), provisional: true });
  // The cap: a blocker on this text is the physics pass's word, not a revision request.
  ctx.db.prepare('UPDATE steps SET cycle = ? WHERE step_id = ?').run(ctx.h.config.gateCycles, job.stepId);
  await answerGate(ctx, 'editor', 'HOLDS');
  await answerGate(ctx, 'consultant', 'GAP', BLOCKER);
  const done = await ctx.client.done({
    leaseId: job.leaseId,
    seams: [],
    note: 'totality: the physics stop',
    model: ctx.config.model,
    tokensIn: 500,
    tokensOut: 80,
  });
  expect(done.changeStatus).toBe('void');
  return {
    cell,
    // BOOK-218 owns the sentence: a stop by the physics pass is our failure, and the line says so.
    want: { sink: 'refused', reader: closeReason('science'), record: closeReason('science'), kind: 'technical' },
  };
}

/**
 * The ripple's delta bound: the origin publishes, the ripple opens on the written neighbour, and
 * the neighbour's whole chapter is replaced. The stop is the refusal — the candidate is dropped,
 * and every chapter the ripple wrote goes back to its pre-pass text, at a new revision.
 */
export async function deltaStop(ctx: Context): Promise<{ cell: Cell; want: Want }> {
  const cell = await placedFiling(ctx);
  cell.beforeText = readChapterRows(ctx.db, CHAPTER).raw ?? '';
  const job = await claimed(ctx, 'writer-origin');
  expect(job.changeId).toBe(cell.changeId);
  await ctx.client.start(job.leaseId);
  await ctx.client.land(job.leaseId, { text: longAnswer(), provisional: true });
  await answerGate(ctx, 'editor', 'HOLDS');
  await answerGate(ctx, 'consultant', 'HOLDS');
  await ctx.client.done({
    leaseId: job.leaseId,
    seams: [{ boundary: 9, reason: 'соседняя глава продолжает сцену' }],
    note: 'totality: the origin opens the ripple',
    model: ctx.config.model,
    tokensIn: 500,
    tokensOut: 80,
  });

  const repair = await claimed(ctx, 'writer-delta');
  expect(repair.pass).toBe('cascade');
  expect(repair.chapter).toBe(9);
  await ctx.client.start(repair.leaseId);
  await ctx.client.land(repair.leaseId, { text: rewrittenChapter(), provisional: true });
  await answerGate(ctx, 'editor', 'HOLDS');
  await answerGate(ctx, 'consultant', 'HOLDS');
  const done = await ctx.client.done({
    leaseId: repair.leaseId,
    seams: [],
    note: 'totality: the delta bound',
    model: ctx.config.model,
    tokensIn: 500,
    tokensOut: 80,
  });
  expect(done.changeStatus).toBe('void');
  return {
    cell,
    want: {
      sink: 'refused',
      reader: closeReason('delta'),
      record: closeReason('delta'),
      kind: 'technical',
      restored: true,
    },
  };
}

/**
 * The ending's `GAP`: the last chapter is evaluated, never rewritten, and the blocker refuses the
 * ripple. The ending carries no text of its own, so nothing is published and nothing is restored.
 */
export async function endingStop(ctx: Context): Promise<{ cell: Cell; want: Want }> {
  const cell = await placedFiling(ctx);
  const at = new Date(ctx.h.clock.ms).toISOString();
  const cascadeId = 'csc_totality_ending';
  const stepId = 'stp_totality_ending';
  const leaseId = 'lea_totality_ending';
  ctx.db
    .prepare(
      `INSERT INTO cascades (id, change_id, status, wave, depth_fwd, depth_bwd, step_count, tokens, budget, opened_at)
       VALUES (?, ?, 'open', 0, 0, 0, 1, 0, ?, ?)`,
    )
    .run(cascadeId, cell.changeId, '{}', at);
  ctx.db
    .prepare(
      `INSERT INTO steps (step_id, cascade_id, seq, wave, lane, pass, chapter, boundary, seams_in, rev_before, at, cycle)
       VALUES (?, ?, 1, 0, NULL, 'ending', 42, 'ending', '[]', 0, ?, 0)`,
    )
    .run(stepId, cascadeId, at);
  // A no-write landing: the ending's text is the last chapter as it already stands.
  ctx.db
    .prepare('UPDATE steps SET landed_at = ?, landed_sha = ? WHERE step_id = ?')
    .run(at, readChapterRows(ctx.db, 9).sha256, stepId);
  ctx.db
    .prepare(
      `INSERT INTO leases (id, step_id, change_id, cascade_id, lane, chapter, is_front, kind, session,
         expected_rev, acquired_at, heartbeat_at, expires_at)
       VALUES (?, ?, ?, ?, NULL, 42, 0, 'ending', 'ending-session', 0, ?, ?, ?)`,
    )
    .run(leaseId, stepId, cell.changeId, cascadeId, at, at, new Date(ctx.h.clock.ms + 3_600_000).toISOString());

  const editor = await ctx.client.nextGate('editor', 'ending-editor');
  expect(editor).not.toBeNull();
  await ctx.client.verdict({
    stepId: editor!.stepId,
    role: 'editor',
    session: editor!.session,
    verdict: 'HOLDS',
    findings: [],
    model: ctx.config.model,
    tokensIn: 120,
    tokensOut: 12,
  });
  const consultant = await ctx.client.nextGate('consultant', 'ending-consultant');
  expect(consultant).not.toBeNull();
  await ctx.client.verdict({
    stepId: consultant!.stepId,
    role: 'consultant',
    session: consultant!.session,
    verdict: 'GAP',
    findings: BLOCKER,
    model: ctx.config.model,
    tokensIn: 120,
    tokensOut: 12,
  });
  const done = await ctx.client.done({
    leaseId,
    seams: [],
    note: 'totality: the ending stop',
    model: ctx.config.model,
    tokensIn: 500,
    tokensOut: 80,
  });
  expect(done.changeStatus).toBe('void');
  return {
    cell,
    want: { sink: 'refused', reader: closeReason('ending'), record: closeReason('ending'), kind: 'technical' },
  };
}
