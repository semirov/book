import { TOTAL_CHAPTERS, type CascadeBudget, type SeamRef, type StepOutcome, type StepPass } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { planCascade, type CascadeFacts, type CascadePlan, type CascadeStepFact } from '../../src/engine/cascade.ts';

const BUDGET: CascadeBudget = {
  maxWave: 5,
  maxChapters: 12,
  maxSteps: 13,
  maxRewritesPerChapter: 1,
  upwardLagWaves: 1,
  maxWallMs: 1_800_000,
  maxTokens: 1_500_000,
  maxDeltaRatio: 0.35,
};

const ALL = new Set(Array.from({ length: TOTAL_CHAPTERS }, (_, index) => index + 1));

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

  it('honours the frozen upward lag instead of starting the up wing after one step', () => {
    const one = facts([origin(10), repair(9, 'backward', 1, [seam(9)])], { budget: { upwardLagWaves: 1 } });
    const atOne = planCascade(one, ctx());
    expect(atOne.kind).toBe('open');
    if (atOne.kind !== 'open') return;
    expect(atOne.steps.map((step) => step.lane)).toEqual(['backward', 'forward']);

    // A lag of two is a real wait: the up wing has not started while the down frontier is
    // one wave ahead, and it starts only once the down wing is two steps ahead.
    const two = facts([origin(10), repair(9, 'backward', 1, [seam(9)])], { budget: { upwardLagWaves: 2 } });
    const first = planCascade(two, ctx());
    expect(first.kind).toBe('open');
    if (first.kind !== 'open') return;
    expect(first.steps.map((step) => step.lane)).toEqual(['backward']);
    const second = planCascade(
      facts([origin(10), repair(9, 'backward', 1, [seam(9)]), repair(8, 'backward', 2, [seam(8)])], {
        budget: { upwardLagWaves: 2 },
      }),
      ctx(),
    );
    expect(second.kind).toBe('open');
    if (second.kind !== 'open') return;
    expect(second.steps.map((step) => step.lane)).toEqual(['backward', 'forward']);

    // A lag of zero is legal: both wings open in the very first plan.
    const zero = planCascade(facts([origin(10)]), ctx(ALL));
    expect(zero.kind).toBe('open');
    if (zero.kind !== 'open') return;
    expect(zero.steps.map((step) => step.lane)).toEqual(['backward']);
    const both = planCascade(facts([origin(10)], { budget: { upwardLagWaves: 0 } }), ctx(ALL));
    expect(both.kind).toBe('open');
    if (both.kind !== 'open') return;
    expect(both.steps.map((step) => step.lane)).toEqual(['backward', 'forward']);
  });

  it('lets the up wing start at once when the down wing has nowhere to go', () => {
    const held = planCascade(facts([origin(10), repair(9, 'backward', 1, [])], { budget: { upwardLagWaves: 5 } }), ctx());
    expect(held.kind).toBe('open');
    if (held.kind !== 'open') return;
    expect(held.steps.map((step) => step.lane)).toEqual(['forward']);

    const frontier = planCascade(
      facts([origin(10), repair(9, 'backward', 1, [seam(9)])], { budget: { upwardLagWaves: 5 } }),
      ctx(new Set([9, 10, 11])),
    );
    expect(frontier.kind).toBe('open');
    if (frontier.kind !== 'open') return;
    expect(frontier.steps.map((step) => step.lane)).toEqual(['forward']);
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
    const last = TOTAL_CHAPTERS;
    const plan = planCascade(
      facts([origin(last - 1), repair(last - 2, 'backward', 1, []), repair(last, 'forward', 2, [])], { origin: last - 1 }),
      ctx(new Set([last - 2, last - 1, last])),
    );
    expect(plan.kind).toBe('open');
    if (plan.kind !== 'open') return;
    expect(plan.steps[0]).toMatchObject({ pass: 'ending', chapter: last, boundary: 'ending' });
  });

  it('evaluates the ending instead of rewriting the last chapter when the ripple reaches it', () => {
    const last = TOTAL_CHAPTERS;
    const plan = planCascade(facts([origin(last - 1), repair(last - 2, 'backward', 1, [])], { origin: last - 1 }), ctx());
    expect(plan.kind).toBe('open');
    if (plan.kind !== 'open') return;
    expect(plan.steps[0]).toMatchObject({ pass: 'ending', chapter: last, boundary: 'ending' });
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

/**
 * A ripple that always finds a seam on its outer boundary: the real geometry (§6A.6) drives
 * it, no scripted wave counter. Used to prove that five waves are reachable and that the
 * sixth is refused by the wave bound rather than by the chapter or step bound.
 */
function walkRipple(options: { origin?: number; budget?: Partial<CascadeBudget> } = {}): {
  steps: CascadeStepFact[];
  plan: CascadePlan;
} {
  // A middle chapter: both wings have room for five waves inside the book.
  const originChapter = options.origin ?? 20;
  const steps: CascadeStepFact[] = [origin(originChapter, [seam(originChapter + 1)])];
  for (let guard = 0; guard < 40; guard += 1) {
    const plan = planCascade(facts(steps, { origin: originChapter, budget: options.budget }), ctx());
    if (plan.kind === 'close') return { steps, plan };
    if (plan.kind === 'wait') throw new Error('the planner waited with no open step');
    for (const planned of plan.steps) {
      steps.push({
        seq: steps.length + 1,
        pass: planned.pass,
        chapter: planned.chapter,
        lane: planned.lane,
        wave: planned.wave,
        outcome: 'rewritten',
        seamsIn: planned.seamsIn,
        // The ending is evaluated, never rewritten (ADR-024), so it reports no outward seam.
        seamsOut: planned.pass === 'ending' ? [] : [seam(planned.chapter ?? 'front')],
      });
    }
  }
  throw new Error('the ripple never terminated');
}

/** The prefix of a walk up to and including the steps of `wave`. */
function upToWave(steps: CascadeStepFact[], wave: number): CascadeStepFact[] {
  let end = steps.length;
  while (end > 0 && (steps[end - 1]?.wave ?? 0) > wave) end -= 1;
  return steps.slice(0, end);
}

describe('planCascade — the five-wave promise (BOOK-DOC-4 rule 3)', () => {
  it('reaches wave 5 with both wings and stops there on the public reason', () => {
    const walk = walkRipple();
    const cascade = walk.steps.filter((step) => step.pass === 'cascade');
    // One wave is one step per wing: the upward wing starts one wave behind the downward one.
    expect(cascade.filter((step) => step.wave === 5).map((step) => step.lane)).toEqual([
      'backward',
      'forward',
    ]);
    expect(Math.max(...cascade.map((step) => step.wave))).toBe(5);
    expect(walk.steps).toHaveLength(1 + 5 + 4);
    expect(walk.plan).toEqual({
      kind: 'close',
      outcome: 'escalated:budget',
      reason: 'правка ушла глубже 5 волн — дальше только по решению владельца',
      alert: true,
    });
  });

  it('refuses the sixth wave with the wave reason, not the chapter or step bound', () => {
    const walk = walkRipple();
    const atFive = upToWave(walk.steps, 5);
    expect(planCascade(facts(atFive), ctx())).toEqual({
      kind: 'close',
      outcome: 'escalated:budget',
      reason: 'правка ушла глубже 5 волн — дальше только по решению владельца',
      alert: true,
    });
  });

  it('labels a boundary proof with the wave the ripple rests in, never the next one', () => {
    // Down to chapter 1 through five waves, the far wing held at its first step: the front
    // proof belongs to wave 5 — a `+1` here recorded wave 6 and read «волна 6 / 5».
    const atBeginning = planCascade(
      facts([
        origin(6, [seam(7)]),
        repair(5, 'backward', 1, [seam(5)]),
        repair(7, 'forward', 2, []),
        repair(4, 'backward', 2, [seam(4)]),
        repair(3, 'backward', 3, [seam(3)]),
        repair(2, 'backward', 4, [seam(2)]),
        repair(1, 'backward', 5, []),
      ]),
      ctx(),
    );
    expect(atBeginning.kind).toBe('open');
    if (atBeginning.kind !== 'open') return;
    expect(atBeginning.steps[0]).toMatchObject({ pass: 'front', wave: 5 });

    // The same at the end of the book: down through five waves, the last chapter only evaluated.
    const last = TOTAL_CHAPTERS;
    const steps = [
      origin(last - 1, [seam(last)]),
      ...[last - 2, last - 3, last - 4, last - 5, last - 6].map((chapter, index) =>
        repair(chapter, 'backward', index + 1, index === 4 ? [] : [seam(chapter)]),
      ),
    ];
    const atEnding = planCascade(facts(steps, { origin: last - 1 }), ctx());
    expect(atEnding.kind).toBe('open');
    if (atEnding.kind !== 'open') return;
    expect(atEnding.steps[0]).toMatchObject({ pass: 'ending', wave: 5 });
    for (const step of atEnding.steps) expect(step.wave).toBeLessThanOrEqual(BUDGET.maxWave);
  });

  it('the old bounds (wave 3, 5 chapters, 8 steps) stopped a ripple before its fifth wave', () => {
    // This is the audit's R3 finding: the chapter bound bound first, so the wave bound was
    // dead config. The numbers are kept here as a guard against a retune sliding back.
    const old = walkRipple({ budget: { maxWave: 3, maxChapters: 5, maxSteps: 8 } });
    expect(old.plan.kind).toBe('close');
    if (old.plan.kind !== 'close') return;
    expect(old.plan.outcome).toBe('escalated:budget');
    expect(old.plan.reason).not.toContain('волн');
    expect(Math.max(...old.steps.filter((step) => step.pass === 'cascade').map((step) => step.wave))).toBe(3);
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
      const originChapter = 2 + Math.floor(random() * (TOTAL_CHAPTERS - 3));
      const written = new Set<number>();
      const half = Math.floor(random() * 4) + 1;
      for (let n = Math.max(1, originChapter - half); n <= Math.min(TOTAL_CHAPTERS, originChapter + half + 2); n += 1) {
        written.add(n);
      }
      if (random() < 0.5) written.delete(Math.min(TOTAL_CHAPTERS, originChapter + 2));

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
            expect(planned.chapter).toBeLessThanOrEqual(TOTAL_CHAPTERS);
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
