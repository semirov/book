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
 * The stages are the six a filing can wait in: the triage ladder, a claim that lapsed, the pen's
 * ladder, the gate rounds, the landing and the queue. Every cell is read by `expectSink`, which
 * asserts the four facts together (revision, change, comment, frames) — no cell can pass on half
 * a decision. The builders live in `stages.ts`, the assertions in `chain.ts`.
 */

import { describe, expect, it } from 'vitest';

import { OUR_FAILURE_LINE, TRIAGE_REFUSED_LINE, queueAttemptsLine } from '@book/shared';

import type { Context } from '../filingTriageHarness.ts';
import { CHAPTER, GUARDED, INTENT, bootChain, expectSink, type Cell, type Want } from './chain.ts';
import {
  draftRefused,
  draftWritten,
  gatesRefused,
  gatesWritten,
  landRefused,
  landRetried,
  lapsedClaims,
  queueClaims,
  triageLadder,
} from './stages.ts';
import { deltaStop, endingStop, scienceStop } from './stops.ts';

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
      // The ladder was exhausted by our own failures and the coded floor could not apply: the
      // filing was not judged, so the sentence is ours and the page offers the retry.
      want: { sink: 'refused', reader: TRIAGE_REFUSED_LINE, kind: 'technical' },
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
      want: { sink: 'refused', reader: TRIAGE_REFUSED_LINE, kind: 'technical' },
    }),
  },
  { stage: 'draft ladder', row: 'a', name: 'five refused drafts, the model-free sixth writes', run: draftWritten },
  {
    stage: 'draft ladder',
    row: 'b',
    name: 'the sixth has nowhere to land — refused, the chapter untouched',
    run: draftRefused,
  },
  { stage: 'gate rounds', row: 'a', name: 'five failed rounds, the mechanical sixth closes the step', run: gatesWritten },
  {
    stage: 'gate rounds',
    row: 'b',
    name: 'the sixth fails its hard criterion — refused, no revision served',
    run: gatesRefused,
  },
  { stage: 'landing', row: 'a', name: 'the first request fails, the client’s retry publishes', run: landRetried },
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

/**
 * The close's own three stops: they are not ladders, so they have one cell each — the failure that
 * used to publish first and put its own text back. A ripple's stop restores what it wrote (a new
 * revision carrying the pre-pass text); a plain change's stop leaves the chapter where it was.
 */
const STOPS: Scenario[] = [
  {
    stage: 'science stop',
    row: 'b',
    name: 'the consultant’s blocker survives the cap — refused, the candidate dropped',
    run: scienceStop,
  },
  {
    stage: 'delta stop',
    row: 'b',
    name: 'a repair replaces too much — refused, every chapter the ripple wrote restored',
    run: deltaStop,
  },
  {
    stage: 'ending stop',
    row: 'b',
    name: 'the ending’s GAP — refused, the last chapter never rewritten',
    run: endingStop,
  },
];

describe('the matrix — the close’s own stops', () => {
  for (const scenario of STOPS) {
    it(`${scenario.stage}: ${scenario.name}`, async () => {
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
    expect(SCENARIOS).toHaveLength(12);
    for (const stage of ['triage ladder', 'a lapsed claim', 'draft ladder', 'gate rounds', 'landing', 'queue']) {
      expect(SCENARIOS.filter((scenario) => scenario.stage === stage).map((scenario) => scenario.row)).toEqual(['a', 'b']);
    }
    // The three stops the close owns are a cell each: there is no «success» row to pair them with.
    expect(STOPS.map((scenario) => scenario.stage)).toEqual(['science stop', 'delta stop', 'ending stop']);
  });

  it('keeps the two non-pass refusals in one place each', () => {
    expect(TRIAGE_REFUSED_LINE).toBe(OUR_FAILURE_LINE);
    expect(queueAttemptsLine(6)).toBe('заявка не дошла до главы за 6 попыток');
    expect(GUARDED).not.toBe(INTENT);
    expect(CHAPTER).toBe(8);
  });
});
