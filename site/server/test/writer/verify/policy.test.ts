/**
 * The policy table (BOOK-DOC-80 §"Tier 2 triggers"): one case per trigger and the clean path.
 *
 * The table is the economics of the whole design — the expensive pair runs only when a cheaper
 * tier cannot answer — so every row is pinned here, including the one that matters most: a change
 * with no trigger runs **no** pair and says so (`local only`).
 */

import { describe, expect, it } from 'vitest';

import type { RipplePlan } from '../../../src/ledger/graph/plan.ts';
import { EDGE_CHARS, decideGates, gatesLine, gatesWord } from '../../../src/writer/verify/policy.ts';

const CHAPTER = 12;

/** A chapter of 2 000 characters, so the middle is far from both edges. */
const TEXT = `Глава двенадцатая\n\n${'слово '.repeat(360)}`;

function plan(overrides: Partial<RipplePlan> = {}): RipplePlan {
  return {
    changeId: 'chg_one',
    chapter: CHAPTER,
    outcome: 'local',
    proven: true,
    seeds: [],
    nodes: [],
    edges: [],
    edgeDetail: [],
    patches: [],
    closureSize: { nodes: 0, edges: 0, chapters: 1, parts: 1 },
    chaptersTouched: [CHAPTER],
    bounds: { chars: 4_000, usd: 0.6, iterations: 4, nodes: 1_500, edges: 3_000 },
    unresolved: [],
    truncated: false,
    ...overrides,
  };
}

const CLEAN = {
  tier0: { ok: true },
  tier1: { verdict: 'HOLDS' as const },
  plan: plan(),
  mode: 'patch' as const,
  chapter: CHAPTER,
  text: TEXT,
  spanStart: 900,
  spanEnd: 950,
};

describe('the table', () => {
  it('runs no pair when nothing fires, and says so', () => {
    const decision = decideGates(CLEAN);
    expect(decision).toEqual({ gateMode: 'local only', why: null });
    expect(gatesLine(decision)).toBe('gates: local only');
    expect(gatesWord(decision)).toBe('гейты: локально');
  });

  it('is full on a Tier-0 failure', () => {
    expect(decideGates({ ...CLEAN, tier0: { ok: false } })).toEqual({ gateMode: 'full', why: 'tier0_failed' });
  });

  it('is full on a Tier-1 GAP', () => {
    expect(decideGates({ ...CLEAN, tier1: { verdict: 'GAP' } })).toEqual({ gateMode: 'full', why: 'tier1_gap' });
  });

  it('is full when Tier 1 could not be parsed: an unreadable answer is a gap', () => {
    expect(decideGates({ ...CLEAN, tier1: { verdict: 'TIER1_UNPARSED' } })).toEqual({
      gateMode: 'full',
      why: 'tier1_gap',
    });
  });

  it('is full on an UNSURE', () => {
    expect(decideGates({ ...CLEAN, tier1: { verdict: 'UNSURE' } })).toEqual({ gateMode: 'full', why: 'tier1_unsure' });
  });

  it('is full when the closure is non-empty, even on a clean local reading', () => {
    const closure = plan({
      nodes: [
        {
          factId: 'f:one',
          chapter: 19,
          blockId: 'ch19#aa',
          mandatory: false,
          reason: 'TONE',
          direction: 'forward',
          hops: 1,
          via: [],
          quote: 'акт',
        },
      ],
    });
    expect(decideGates({ ...CLEAN, plan: closure })).toEqual({ gateMode: 'full', why: 'closure_non_empty' });
  });

  it('is full for a patch with no plan: an unknown closure cannot be proven local', () => {
    // A cascade landing (a ripple chapter) is a patch the engine planned nothing for — the ripple's
    // plan belongs to the origin — and a patch over the rewrite bound is the same shape. Both have
    // an unknown closure, so the pair runs; the reason is the closure's, said as non-empty.
    expect(decideGates({ ...CLEAN, plan: null })).toEqual({ gateMode: 'full', why: 'closure_non_empty' });
    expect(decideGates({ ...CLEAN, plan: null, tier1: null })).toEqual({
      gateMode: 'full',
      why: 'closure_non_empty',
    });
    // A rewrite with no plan is not this row: it names no span, and the edge test already answers.
    expect(decideGates({ ...CLEAN, plan: null, mode: 'rewrite' }).why).toBeNull();
  });

  it('is full when the span lies in the chapter’s first or last 600 characters', () => {
    expect(decideGates({ ...CLEAN, spanStart: 40, spanEnd: 80 }).why).toBe('chapter_edge');
    const length = Array.from(TEXT).length;
    expect(decideGates({ ...CLEAN, spanStart: length - 100, spanEnd: length - 40 }).why).toBe('chapter_edge');
    // One character outside the edge is the middle: the test is the span's own offsets.
    expect(decideGates({ ...CLEAN, spanStart: EDGE_CHARS, spanEnd: EDGE_CHARS + 10 }).why).toBeNull();
  });

  it('is full on a wide plan', () => {
    expect(decideGates({ ...CLEAN, plan: plan({ outcome: 'wide' }) })).toEqual({ gateMode: 'full', why: 'wide' });
  });

  it('names the trigger in the record’s line', () => {
    const decision = decideGates({ ...CLEAN, tier1: { verdict: 'GAP' } });
    expect(gatesLine(decision)).toBe('gates: full (местный судья нашёл разрыв)');
    expect(gatesWord(decision)).toContain('гейты: полная пара');
  });
});
