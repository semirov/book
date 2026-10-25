import type { CascadeBudget, SeamRef, StepOutcome, StepPass } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { planCascade, type CascadeFacts, type CascadeStepFact } from '../../src/engine/cascade.ts';

const BUDGET: CascadeBudget = {
  maxWave: 3,
  maxChapters: 5,
  maxSteps: 8,
  maxRewritesPerChapter: 1,
  upwardLagWaves: 1,
  maxWallMs: 1_800_000,
  maxTokens: 1_500_000,
  maxDeltaRatio: 0.35,
};

const ALL = new Set(Array.from({ length: 67 }, (_, index) => index + 1));

function seam(boundary: number | 'front' | 'ending', reason = 'r'): SeamRef {
  return { boundary, reason };
}

function origin(chapter: number, seamsOut: SeamRef[] = [seam(chapter + 1)]): CascadeStepFact {
  return {
    seq: 1,
    pass: 'change' as StepPass,
    chapter,
    lane: null,
    wave: 0,
    outcome: 'rewritten' as StepOutcome,
    seamsIn: [],
    seamsOut,
  };
}

function repair(
  chapter: number,
  lane: 'forward' | 'backward',
  wave: number,
  seamsOut: SeamRef[],
  outcome: StepOutcome = 'rewritten',
): CascadeStepFact {
  return { seq: wave + 1, pass: 'cascade', chapter, lane, wave, outcome, seamsIn: [], seamsOut };
}

function facts(
  steps: CascadeStepFact[],
  options: { origin?: number; budget?: Partial<CascadeBudget>; tokens?: number; openedAtMs?: number } = {},
): CascadeFacts {
  const originStep = steps.find((step) => step.pass === 'change');
  return {
    origin: options.origin ?? originStep?.chapter ?? 5,
    budget: { ...BUDGET, ...options.budget },
    openedAtMs: options.openedAtMs ?? 0,
    tokens: options.tokens ?? 0,
    steps,
  };
}

const ctx = (written: Iterable<number> = ALL, nowMs = 1_000) => ({ nowMs, written: new Set(written) });

describe('planCascade — the ripple geometry', () => {
  it('does not open a ripple when the origin reported no seam', () => {
    const plan = planCascade(facts([origin(5, [])]), ctx());
    expect(plan).toMatchObject({ kind: 'close', outcome: 'local', alert: false });
  });

  it('waits while a step of the cascade is open', () => {
    const open: CascadeStepFact = { ...repair(4, 'backward', 1, []), outcome: null };
    expect(planCascade(facts([origin(5), open]), ctx()).kind).toBe('wait');
  });

  it('opens the downward wing first and the upward one a wave later', () => {
    const first = planCascade(facts([origin(10)]), ctx());
    expect(first.kind).toBe('open');
    if (first.kind !== 'open') return;
    expect(first.steps).toHaveLength(1);
    expect(first.steps[0]).toMatchObject({ pass: 'cascade', chapter: 9, lane: 'backward', wave: 1 });
    expect(first.steps[0]?.seamsIn[0]?.boundary).toBe(10);

    const second = planCascade(facts([origin(10), repair(9, 'backward', 1, [seam(9)])]), ctx());
    expect(second.kind).toBe('open');
    if (second.kind !== 'open') return;
    expect(second.steps.map((step) => step.chapter)).toEqual([8, 11]);
    expect(second.steps.map((step) => step.wave)).toEqual([2, 2]);
    expect(second.steps[1]?.seamsIn[0]?.boundary).toBe(11);
  });

  it('does not stall the upward wing when the downward one cannot move', () => {
    const plan = planCascade(facts([origin(2), repair(1, 'backward', 1, [])]), ctx());
    expect(plan.kind).toBe('open');
    if (plan.kind !== 'open') return;
    expect(plan.steps.map((step) => step.chapter)).toEqual([3]);
  });

  it('reaches the beginning: exactly one front step, once', () => {
    const plan = planCascade(facts([origin(2), repair(1, 'backward', 1, [])]), ctx());
    if (plan.kind !== 'open') throw new Error('expected an open plan');
    const afterUp = planCascade(
      facts([origin(2), repair(1, 'backward', 1, []), repair(3, 'forward', 2, [])]),
      ctx(),
    );
    expect(afterUp.kind).toBe('open');
    if (afterUp.kind !== 'open') return;
    expect(afterUp.steps).toHaveLength(1);
    expect(afterUp.steps[0]).toMatchObject({ pass: 'front', chapter: null, boundary: 'front', isFront: true });

    const closed = planCascade(
      facts([
        origin(2),
        repair(1, 'backward', 1, []),
        repair(3, 'forward', 2, []),
        { ...repair(0, 'backward', 3, []), seq: 5, pass: 'front', chapter: null, lane: null, outcome: 'rewritten' },
      ]),
      ctx(),
    );
    expect(closed).toMatchObject({ kind: 'close', outcome: 'absorbed' });
  });

  it('reaches the end: an ending evaluation, never a rewrite (ADR-024)', () => {
    const plan = planCascade(
      facts([origin(66), repair(65, 'backward', 1, []), repair(67, 'forward', 2, [])], { origin: 66 }),
      ctx(new Set([65, 66, 67])),
    );
    expect(plan.kind).toBe('open');
    if (plan.kind !== 'open') return;
    expect(plan.steps[0]).toMatchObject({ pass: 'ending', chapter: 67, boundary: 'ending' });
  });

  it('evaluates the ending instead of rewriting chapter 67 when the ripple reaches it', () => {
    const plan = planCascade(facts([origin(66), repair(65, 'backward', 1, [])], { origin: 66 }), ctx());
    expect(plan.kind).toBe('open');
    if (plan.kind !== 'open') return;
    expect(plan.steps[0]).toMatchObject({ pass: 'ending', chapter: 67, boundary: 'ending' });
    expect(plan.steps).toHaveLength(1);
  });

  it('stops at an unwritten neighbour with outcome frontier', () => {
    const plan = planCascade(facts([origin(5), repair(4, 'backward', 1, [])]), ctx(new Set([4, 5])));
    expect(plan).toMatchObject({ kind: 'close', outcome: 'frontier' });
  });

  it('counts a clean stop as absorbed when it stayed next door, consistent when it went deeper', () => {
    const absorbed = planCascade(
      facts([origin(10), repair(9, 'backward', 1, []), repair(11, 'forward', 2, [])]),
      ctx(),
    );
    expect(absorbed).toMatchObject({ kind: 'close', outcome: 'absorbed' });

    const consistent = planCascade(
      facts([
        origin(10),
        repair(9, 'backward', 1, []),
        repair(8, 'backward', 2, []),
        repair(11, 'forward', 2, []),
      ]),
      ctx(),
    );
    expect(consistent).toMatchObject({ kind: 'close', outcome: 'consistent' });
  });

  it('escalates at the wave, step, chapter, time and token bounds', () => {
    const wave = planCascade(
      facts([origin(10), repair(9, 'backward', 1, [seam(9)])], { budget: { maxWave: 1 } }),
      ctx(),
    );
    expect(wave).toMatchObject({ kind: 'close', outcome: 'escalated:budget', alert: true });

    const steps = planCascade(
      facts([origin(10), repair(9, 'backward', 1, [seam(9)])], { budget: { maxSteps: 2 } }),
      ctx(),
    );
    expect(steps).toMatchObject({ kind: 'close', outcome: 'escalated:budget' });

    const chapters = planCascade(
      facts([origin(10), repair(9, 'backward', 1, [seam(9)])], { budget: { maxChapters: 2 } }),
      ctx(),
    );
    expect(chapters).toMatchObject({ kind: 'close', outcome: 'escalated:budget' });

    const wall = planCascade(
      facts([origin(10), repair(9, 'backward', 1, [seam(9)])], { budget: { maxWallMs: 500 } }),
      ctx(ALL, 1_000),
    );
    expect(wall).toMatchObject({ kind: 'close', outcome: 'escalated:budget' });

    const tokens = planCascade(
      facts([origin(10), repair(9, 'backward', 1, [seam(9)])], { tokens: BUDGET.maxTokens }),
      ctx(),
    );
    expect(tokens).toMatchObject({ kind: 'close', outcome: 'escalated:budget' });
  });

  it('escalates a finding that survived the cycle cap', () => {
    const plan = planCascade(
      facts([origin(10), repair(9, 'backward', 1, [], 'published_with_finding')]),
      ctx(new Set([9, 10])),
    );
    expect(plan).toMatchObject({ kind: 'close', outcome: 'escalated:finding', alert: true });
  });

  it('escalates a chapter that would be written twice in one cascade (the oscillation guard)', () => {
    const plan = planCascade(
      facts([
        origin(10),
        repair(9, 'backward', 1, [seam(9)]),
        repair(8, 'backward', 2, [seam(8)]),
        { ...repair(7, 'forward', 2, [seam(8)]), chapter: 7 },
      ]),
      ctx(),
    );
    expect(plan).toMatchObject({ kind: 'close', outcome: 'escalated:oscillation', alert: true });
  });

  it('honours a forced stop from outside the geometry (C2, delta, ending)', () => {
    const plan = planCascade(facts([origin(10)]), {
      ...ctx(),
      forceOutcome: 'escalated:origin',
      forceReason: 'глава позади волны',
    });
    expect(plan).toMatchObject({ kind: 'close', outcome: 'escalated:origin', alert: true });
  });
});

/** Deterministic PRNG so a failure is reproducible from its seed. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe('planCascade — termination over a fixed seam graph (property)', () => {
  it('always terminates, never revisits a chapter, and never plans past a bound', () => {
    for (let seed = 1; seed <= 120; seed += 1) {
      const random = mulberry32(seed);
      const originChapter = 2 + Math.floor(random() * 64);
      const written = new Set<number>();
      const half = Math.floor(random() * 4) + 1;
      for (let n = Math.max(1, originChapter - half); n <= Math.min(67, originChapter + half + 2); n += 1) {
        written.add(n);
      }
      if (random() < 0.5) written.delete(Math.min(67, originChapter + 2));

      const budget: CascadeBudget = {
        ...BUDGET,
        maxWave: 1 + Math.floor(random() * 4),
        maxSteps: 2 + Math.floor(random() * 8),
        maxChapters: 2 + Math.floor(random() * 5),
      };
      const steps: CascadeStepFact[] = [origin(originChapter, random() < 0.1 ? [] : [seam(originChapter + 1)])];
      const visited = new Set<number>([originChapter]);
      let plan: ReturnType<typeof planCascade> = { kind: 'wait' };
      let opened = 0;
      let iterations = 0;

      for (; iterations < 60; iterations += 1) {
        plan = planCascade(
          { origin: originChapter, budget, openedAtMs: 0, tokens: 0, steps },
          { nowMs: 1_000, written },
        );
        if (plan.kind === 'close') break;
        if (plan.kind === 'wait') throw new Error(`seed ${seed}: planner waited with no open step`);
        expect(plan.steps.length).toBeGreaterThan(0);
        expect(plan.steps.length).toBeLessThanOrEqual(2);
        for (const planned of plan.steps) {
          opened += 1;
          if (planned.pass === 'cascade') expect(planned.wave).toBeLessThanOrEqual(budget.maxWave);
          if (planned.chapter !== null && planned.pass === 'cascade') {
            expect(visited.has(planned.chapter)).toBe(false);
            expect(planned.chapter).toBeGreaterThanOrEqual(1);
            expect(planned.chapter).toBeLessThanOrEqual(67);
            visited.add(planned.chapter);
          }
          const continues = plan.steps[0] === planned ? random() < 0.6 : random() < 0.5;
          steps.push({
            seq: steps.length + 1,
            pass: planned.pass,
            chapter: planned.chapter,
            lane: planned.lane,
            wave: planned.wave,
            outcome: 'rewritten',
            seamsIn: planned.seamsIn,
            seamsOut:
              planned.pass === 'ending'
                ? []
                : continues
                  ? [seam(planned.chapter === null ? 'front' : Math.max(2, planned.chapter))]
                  : [],
          });
          if (planned.pass !== 'cascade') break;
        }
      }

      expect(iterations).toBeLessThan(60);
      expect(plan.kind).toBe('close');
      expect(opened).toBeLessThanOrEqual(budget.maxSteps + 2);
    }
  });
});
