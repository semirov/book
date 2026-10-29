/**
 * The totality matrix's invariants — what the twelve cells in `matrix.test.ts` are *for*:
 *
 *   1. **The three-way state is impossible.** After any injected failure the chapter stands at
 *      its pre-pass revision unless the change is `done · applied`; there is no row set where a
 *      chapter moved and the filing was not written, or the reverse.
 *   2. **No terminal lie.** Every sentence the ladder, the queue and the engine's own clock
 *      guards can put in front of a reader is free of the words the owner retired — including
 *      «проверка не ответила», which now survives only in the step's own note (the minutes and
 *      what happened to the text), never in a reader's line.
 *   3. **The sixth is labelled, the widening is recorded.** The desperate attempt and the third
 *      failure's widening are facts of the record — attempt rows and stage summaries — not a
 *      silent rule change.
 *   4. **A technical failure never reads as a refusal of the idea.** The sixth of the gates
 *      cannot be asked (the engine is gone) and the chain ends `refused` in our own words end to
 *      end; a hard criterion the mechanical sixth proves keeps its own line — in the record and
 *      in the pass — because that one really is about the text; a lock keeps its own case
 *      sentence and never borrows ours. The pen's sixth with nowhere to place its sentence is
 *      structural, and says so beside our failure — it is the belt-and-braces case of this rule.
 */

import { describe, expect, it } from 'vitest';

import {
  ATTEMPT_LINE,
  ENGINE_SILENT_LINE,
  FAILED_ATTEMPT_LINE,
  TRIAGE_REFUSED_LINE,
  attemptOfLine,
  queueAttemptsLine,
} from '@book/shared';

import { STOPPED_LINE } from '../../src/comments/states.ts';
import { closeReason } from '../../src/engine/cascade.ts';
import {
  BUDGET_STOP_REASON,
  GATE_WINDOW_REASON,
  gateWindowNote,
  lostSessionReason,
  stepWallReason,
} from '../../src/engine/refuse.ts';
import { readerFallbacks, readerReason, readerSentences } from '../../src/writer/reasons.ts';
import { stageSummary } from '../../src/writer/stages.ts';
import type { Context } from '../filingTriageHarness.ts';
import { RETIRED, TECHNICAL, bootChain, expectSink, factsOf, type Cell } from './chain.ts';
import { landRefused, lapsedClaims, lockRefused, triageLadder } from './stages.ts';

/** Every failure a cell can inject, each one's own chain (a fresh boot, as a prod process would be). */
const FAILURES: Array<{ name: string; run: (ctx: Context) => Promise<Cell> }> = [
  { name: 'the triage sixth fails', run: (ctx) => triageLadder(ctx, 'refused') },
  { name: 'five claims lapse and the floor refuses', run: (ctx) => lapsedClaims(ctx, 'refused') },
  { name: 'both land attempts fail', run: async (ctx) => (await landRefused(ctx)).cell },
  { name: 'a lock refuses the read', run: async (ctx) => (await lockRefused(ctx)).cell },
];

describe('the three-way state is impossible (owner, 2026-10-29)', () => {
  for (const failure of FAILURES) {
    it(`keeps the chapter at its pre-pass revision when ${failure.name}`, async () => {
      const ctx = await bootChain();
      try {
        const cell = await failure.run(ctx);
        const facts = factsOf(cell);
        const landed = facts.change?.status === 'done' && facts.change?.outcome === 'applied';
        if (!landed) {
          // Not written: the chapter is exactly where the pass found it. A moved chapter whose
          // change is not `done · applied` is the lie this rule exists to make impossible.
          expect(facts.rev).toBe(cell.revBefore);
          expect(facts.dto.status).not.toBe('applied');
        } else {
          expect(facts.rev).toBe(cell.revBefore + 1);
        }
      } finally {
        await ctx.close();
      }
    });
  }
});

/** Every sentence the ladder, the sinks and the queue can put in front of a reader. */
function ladderSentences(): string[] {
  const codes = [
    'PROVIDER_SHAPE',
    'PROVIDER_TIMEOUT',
    'PROVIDER_HTTP_500',
    'ANSWER_EMPTY',
    'ANSWER_REFUSAL',
    'ANSWER_TRUNCATED',
    'TEXT_TOO_SHORT',
    'MARKDOWN',
    'GATE_UNPARSED',
    'GATE_NOT_DISPATCHED',
    'MECHANICAL_GAP',
    'MECHANICAL_GAP_FRAME',
    'MECHANICAL_GAP_FACTS',
    'MECHANICAL_GAP_RIGHTS',
    'MECHANICAL_PATCH_UNPLACED',
    'ENGINE_TIMEOUT',
    'ENGINE_UNREACHABLE',
    'DB_BUSY',
    'RIGHTS_REQUIRED',
    'FRAME_CHANGED',
    'STEP_CLOSED',
    'UNKNOWN_CODE',
  ];
  return [
    ...Object.values(readerSentences),
    ...Object.values(readerFallbacks),
    ...codes.map((code) => readerReason(code, readerFallbacks.stopped)),
    TRIAGE_REFUSED_LINE,
    FAILED_ATTEMPT_LINE,
    ENGINE_SILENT_LINE,
    ATTEMPT_LINE,
    attemptOfLine(1),
    attemptOfLine(4),
    attemptOfLine(6, 6),
    queueAttemptsLine(),
    STOPPED_LINE,
    stageSummary.refused({ reason: readerSentences.technical }),
    stageSummary.queued({ chapter: 8, pass: 'change', premise: null, intent: 'правка' }),
    stageSummary.queued({ chapter: 9, pass: 'draft', premise: 'замысел', intent: null }),
    stageSummary.queued({ chapter: 8, pass: 'change', premise: null, intent: null }),
    stageSummary.read({ sections: 11, chars: 20_000, neighbours: [] }),
    stageSummary.read({ sections: 11, chars: 20_000, neighbours: [7, 9] }),
    stageSummary.draftingReturned({ chars: 2_400, tokensIn: 1_000, tokensOut: 200 }),
    stageSummary.verdict({ role: 'editor', verdict: 'HOLDS', findings: 0, blockers: 0 }),
    stageSummary.verdict({ role: 'consultant', verdict: 'GAP', findings: 3, blockers: 1 }),
    stageSummary.rightsVerdict({ verdict: 'CLEAR', rule: null, scanned: false }),
    stageSummary.rightsVerdict({ verdict: 'REFUSED', rule: 'a quote', scanned: true }),
    stageSummary.landed({ chapter: 8, chars: 2_400, blocks: 4, tokensIn: 1_000, tokensOut: 200, costUsd: 0.04 }),
    stageSummary.landed({ chapter: 8, chars: 2_400, blocks: 4, tokensIn: 1_000, tokensOut: 200, costUsd: 0.04, estimated: true }),
  ];
}

describe('no terminal lie — the ladder never prints a retired word', () => {
  it('keeps every reader-facing sentence and every stage builder free of them', () => {
    for (const sentence of ladderSentences()) {
      expect(sentence.length).toBeGreaterThan(0);
      for (const word of RETIRED) {
        expect(sentence, `«${word}» reached a reader-facing sentence`).not.toContain(word);
      }
    }
  });

  it('keeps the engine’s own clock guards free of the retired words too', () => {
    // The owner's rule retires «проверка не ответила» from every reader's line — the gate window
    // and the cascade's own stop copy included, because "the gate did not answer" is our failure
    // and the filing was not judged. The minute count is the operator's fact (`gateWindowNote`).
    const guards = [
      stepWallReason(30),
      GATE_WINDOW_REASON,
      lostSessionReason(true),
      lostSessionReason(false),
      closeReason('gate'),
    ];
    expect([...ladderSentences(), ...guards].filter((sentence) => sentence.includes('проверка не ответила'))).toEqual([]);
    for (const guard of guards) {
      for (const word of RETIRED) expect(guard).not.toContain(word);
    }
    // The detail keeps the fact the reader's line may not print: the window, in minutes.
    expect(gateWindowNote(20, true)).toContain('20 мин');
    expect(gateWindowNote(20, false)).toContain('20 мин');
    expect(gateWindowNote(20, false)).toContain('не опубликована');
    // The book's money stop is a refusal with its own sentence, and it is not a ladder state.
    for (const word of RETIRED) expect(BUDGET_STOP_REASON).not.toContain(word);
  });
});

describe('the sixth is labelled, the widening is recorded', () => {
  it('records the triage widening on the attempt row and the sixth as the engine’s own event', async () => {
    const ctx = await bootChain();
    try {
      const cell = await triageLadder(ctx, 'floor');
      expectSink(cell, { sink: 'accepted' });
      const attempt = ctx.db
        .prepare('SELECT tries, widened, widening_note, desperate FROM comment_attempts WHERE comment_id = ? AND n = 1')
        .get(cell.commentId) as Record<string, unknown>;
      expect(attempt).toMatchObject({ tries: 6, widened: 'as-document', desperate: 1 });
      expect(String(attempt.widening_note)).toContain('through_paper');
      const events = ctx.db
        .prepare('SELECT type, meta FROM comment_events WHERE comment_id = ? ORDER BY id')
        .all(cell.commentId) as Array<{ type: string; meta: string }>;
      const failed = events
        .filter((event) => event.type === 'triage.failed')
        .map((event) => JSON.parse(event.meta) as { try?: number; of?: number; cap?: boolean });
      expect(failed.map((meta) => meta.try)).toEqual([1, 2, 3, 4, 5]);
      expect(failed.every((meta) => meta.of === 6 && meta.cap !== true)).toBe(true);
      const desperate = events.filter((event) => event.type === 'triage.desperate');
      expect(desperate).toHaveLength(1);
      expect(JSON.parse(desperate[0]?.meta ?? '{}')).toMatchObject({ try: 6, of: 6, rung: 'as_said' });
    } finally {
      await ctx.close();
    }
  });
});

describe('a technical failure never reads as a refusal of the idea', () => {
  it('keeps a lock’s own case sentence, and never borrows our failure for it', async () => {
    const ctx = await bootChain();
    try {
      const { cell } = await lockRefused(ctx);
      const facts = expectSink(cell, { sink: 'refused', reader: /финал уже назван/u, kind: 'lock' });
      expect(facts.change).toBeNull();
      expect(String(facts.dto.reason)).not.toContain(TECHNICAL);
      // The row is a decision about the text: it was read, and the reading named the lock.
      expect(facts.dto.disposition).toBe('inadmissible');
    } finally {
      await ctx.close();
    }
  });
});
