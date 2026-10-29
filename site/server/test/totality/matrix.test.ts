/**
 * The totality matrix (owner's rule, 2026-10-29): every stage is bounded by a number of attempts,
 * and the last failure goes straight to a sink — `written` or `refused`, once, with one sentence.
 *
 * Each stage has two rows:
 *
 *   (a) attempts 1..N−1 fail and the last one succeeds — the chapter moves (or the reading is
 *       placed at the floor rung), and the stage spends the calls its count says it may;
 *   (b) all N fail — the sink fires on the Nth failure itself, not after a wait, and the chapter
 *       stays where it was.
 *
 * The stages are the ones this branch's rule owns: the triage ladder, a claim that lapsed, the
 * landing and the queue. The pen's and the gates' ladders are the engine's (BOOK-DOC-84 §10.8) and
 * their sink is asserted beside the frames that carry them (`server/test/engine/rules.test.ts`). Every cell is read by `expectSink`, which
 * asserts the four facts together (revision, change, comment, frames) — no cell can pass on half
 * a decision. The builders live in `stages.ts`, the assertions in `chain.ts`.
 */

import { describe, expect, it } from 'vitest';

import { TRIAGE_REFUSED_LINE, queueAttemptsLine } from '@book/shared';

import type { Context } from '../filingTriageHarness.ts';
import { CHAPTER, GUARDED, INTENT, bootChain, expectSink, type Cell, type Want } from './chain.ts';
import { landRefused, lapsedClaims, queueClaims, triageLadder } from './stages.ts';

type Scenario = { stage: string; row: 'a' | 'b'; name: string; run: (ctx: Context) => Promise<{ cell: Cell; want: Want }> };

const SCENARIOS: Scenario[] = [
  {
    stage: 'triage ladder',
    row: 'a',
    name: 'five failed reads, then the engine’s sixth places the floor rung',
    run: async (ctx) => ({ cell: await triageLadder(ctx, 'floor'), want: { sink: 'accepted' } }),
  },
  {
    stage: 'triage ladder',
    row: 'b',
    name: 'the sixth fails too — refused with one sentence, and no change is made',
    run: async (ctx) => ({
      cell: await triageLadder(ctx, 'refused'),
      want: { sink: 'refused', reader: TRIAGE_REFUSED_LINE, kind: 'content' },
    }),
  },
  {
    stage: 'a lapsed claim',
    row: 'a',
    name: 'five claims died under their call, the sixth is the engine’s floor — placed',
    run: async (ctx) => ({ cell: await lapsedClaims(ctx, 'floor'), want: { sink: 'accepted' } }),
  },
  {
    stage: 'a lapsed claim',
    row: 'b',
    name: 'five claims died and the floor refuses — one sentence, once',
    run: async (ctx) => ({
      cell: await lapsedClaims(ctx, 'refused'),
      want: { sink: 'refused', reader: TRIAGE_REFUSED_LINE, kind: 'content' },
    }),
  },
  { stage: 'landing', row: 'b', name: 'both requests fail — refused in our own words', run: landRefused },
  { stage: 'queue', row: 'a', name: 'five claims found the lane held, the sixth found it free', run: queueWritten },
  {
    stage: 'queue',
    row: 'b',
    name: 'six counted claims with no step — the change and the filing are refused',
    run: queueRefused,
  },
];

async function queueWritten(ctx: Context): Promise<{ cell: Cell; want: Want }> {
  return { cell: await queueClaims(ctx, 'sixth-claim-wins'), want: { sink: 'written' } };
}

async function queueRefused(ctx: Context): Promise<{ cell: Cell; want: Want }> {
  return {
    cell: await queueClaims(ctx, 'sixth-claim-drops'),
    want: { sink: 'refused', reader: queueAttemptsLine(6), kind: 'queue' },
  };
}

describe('the totality matrix — every stage ends in one of the two sinks', () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.stage} (${scenario.row}): ${scenario.name}`, async () => {
      const ctx = await bootChain();
      try {
        const { cell, want } = await scenario.run(ctx);
        expectSink(cell, want);
      } finally {
        await ctx.close();
      }
    });
  }
});

describe('the matrix covers what the brief names', () => {
  it('names every stage twice: (a) ends in a sink after N−1 failures, (b) on the Nth', () => {
    expect(SCENARIOS).toHaveLength(7);
    for (const stage of ['triage ladder', 'a lapsed claim', 'queue']) {
      expect(SCENARIOS.filter((scenario) => scenario.stage === stage).map((scenario) => scenario.row)).toEqual(['a', 'b']);
    }
    // The landing's (a) row — the client's own retry — is asserted where the client lives
    // (`server/test/writer/*`); its (b) row is the sink, and it is here.
    expect(SCENARIOS.filter((scenario) => scenario.stage === 'landing').map((scenario) => scenario.row)).toEqual(['b']);
  });

  it('keeps the two non-pass refusals in one place each', () => {
    expect(TRIAGE_REFUSED_LINE).toBe('прочитать заявку не удалось — заявка отклонена');
    expect(queueAttemptsLine(6)).toBe('заявка не дошла до главы за 6 попыток');
    expect(GUARDED).not.toBe(INTENT);
    expect(CHAPTER).toBe(8);
  });
});
