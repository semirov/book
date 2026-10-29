/**
 * The decision (BOOK-174, ADR-040 §4) — one row per branch, plus the three refusals.
 *
 * The mode is the promise before the work, so the table is the contract: `local` never leaves the
 * origin chapter, `ripple` fits the execution budget, `wide` is whatever does not — and a `wide`
 * without both signatures is refused rather than quietly shrunk. The sentences are asserted whole
 * because they are the public fact (`holdsInternalCode` already strips the code from a reader).
 */

import { describe, expect, it } from 'vitest';

import { decide, priceOf, type ModeInput } from '../../src/graph/modes.ts';
import { partOf, partsOf } from '../../src/graph/parts.ts';
import { nodeOf } from './helpers.ts';

const base: ModeInput = {
  origin: 3,
  nodes: [nodeOf('fct_a', 3, { direction: 'seed', distance: 0, via: null })],
  mandatory: [],
  orphaned: [],
  touched: ['fct_a'],
  crossingEdge: false,
  changedChars: 0,
  outcomeReversed: false,
  laneLost: false,
  irreversibleLost: false,
  priced: true,
  unstable: null,
};

const withInput = (over: Partial<ModeInput>): ModeInput => ({ ...base, ...over });

const sixChapters = withInput({
  origin: 2,
  nodes: [2, 3, 4, 5, 6, 7].map((chapter) =>
    nodeOf(`fct_${String(chapter)}`, chapter, { direction: chapter === 2 ? 'seed' : 'descendant' }),
  ),
  mandatory: ['fct_3', 'fct_4', 'fct_5', 'fct_6', 'fct_7'],
  touched: ['fct_2'],
  crossingEdge: true,
});

const both = { author: true, auditor: true };

describe('decide', () => {
  it('is local when nothing mandatory leaves the origin chapter', () => {
    const decision = decide(withInput({ origin: 5, nodes: [nodeOf('fct_a', 5, { direction: 'seed' })] }));
    expect(decision.mode).toBe('local');
    expect(decision.refused).toBeNull();
    expect(decision.price.chapters).toBe(1);
    expect(decision.price.usd).toBe(0.09);
    expect(decision.reasons[0]).toContain('local: no mandatory node outside chapter 5');
  });

  it('is ripple at three chapters, three patches, 2,000 chars and $0.25', () => {
    const decision = decide(
      withInput({
        origin: 3,
        nodes: [nodeOf('fct_a', 3, { direction: 'seed' }), nodeOf('fct_b', 7), nodeOf('fct_c', 9)],
        mandatory: ['fct_b', 'fct_c'],
        crossingEdge: true,
        changedChars: 2000,
      }),
    );
    expect(decision.mode).toBe('ripple');
    expect(decision.refused).toBeNull();
    expect(decision.price).toMatchObject({ usd: 0.25, chapters: 3, patches: 3, changedChars: 2000, priced: true });
    expect(decision.price.byChapter.map((entry) => entry.chapter)).toEqual([3, 7, 9]);
    // Ripple needs no signature: the engine holds this budget.
    expect(decision.price.usd).toBe(3 * 0.08 + 0.01);
  });

  it('is wide at six chapters and charges the whole-book read', () => {
    const decision = decide({ ...sixChapters, approvals: both });
    expect(decision.mode).toBe('wide');
    expect(decision.refused).toBeNull();
    expect(decision.reasons).toContain('chapters 6 > 5');
    expect(decision.price.chapters).toBe(6);
    expect(decision.price.usd).toBe(6 * 0.08 + 0.01);
  });

  it('is wide when an outcome would be reversed', () => {
    const decision = decide(withInput({ outcomeReversed: true, approvals: both }));
    expect(decision.mode).toBe('wide');
    expect(decision.refused).toBeNull();
    expect(decision.reasons).toContain('an outcome is reversed');
  });

  it('is wide when a lane no longer reaches the finale, and names the loss in the price', () => {
    const decision = decide(withInput({ laneLost: true }));
    expect(decision.mode).toBe('wide');
    expect(decision.reasons).toContain('a lane no longer reaches the finale');
    // The price names the loss rather than reporting a number that never heard of it: E1 is one
    // ledger query, so it is charged at $0.00 and said out loud.
    expect(decision.price.assumptions.join('\n')).toContain('lost lane: the finale reach (E1)');
    // An unapproved `wide` is refused, never shrunk — including this one, whose chapter count is 1.
    expect(decision.refused?.code).toBe('CLOSURE_TOO_WIDE');
    expect(decision.refused?.sentence).toBe(
      'правка задевает 1 главу, обязательных из них — 0; автоматически правится не больше 5, дальше решает автор',
    );
    expect(decide(withInput({ laneLost: true, approvals: both })).refused).toBeNull();
  });

  it('is wide when a patched chapter lost its irreversible change, and names the loss in the price', () => {
    const decision = decide(withInput({ irreversibleLost: true }));
    expect(decision.mode).toBe('wide');
    expect(decision.reasons).toContain('a patched chapter lost its irreversible change');
    expect(decision.price.assumptions.join('\n')).toContain('lost irreversible row: the necessity check (S6)');
    expect(decision.refused?.code).toBe('CLOSURE_TOO_WIDE');
    expect(decision.refused?.sentence).toContain('правка задевает 1 главу');
    expect(decide(withInput({ irreversibleLost: true, approvals: both })).refused).toBeNull();
    // A price with neither loss says nothing about them.
    expect(priceOf(withInput({})).assumptions.join('\n')).not.toContain('lost lane');
    expect(priceOf(withInput({})).assumptions.join('\n')).not.toContain('lost irreversible row');
  });

  it('is wide when the model has no rate', () => {
    const decision = decide(withInput({ priced: false, approvals: both }));
    expect(decision.mode).toBe('wide');
    expect(decision.refused).toBeNull();
    expect(decision.price.priced).toBe(false);
    expect(decision.reasons).toContain('unpriced: the model has no rate');
  });

  it('is wide and CLOSURE_UNSTABLE when a node comes back through its own repair', () => {
    const decision = decide(
      withInput({
        origin: 3,
        nodes: [nodeOf('fct_a', 3, { direction: 'seed' }), nodeOf('fct_b', 7)],
        mandatory: ['fct_b'],
        unstable: { node: 'fct_b', cycle: ['fct_a', 'fct_b'] },
        approvals: both,
      }),
    );
    expect(decision.mode).toBe('wide');
    expect(decision.refused?.code).toBe('CLOSURE_UNSTABLE');
    expect(decision.refused?.sentence).toBe(
      'правка ходит по кругу: глава 7 снова обязательна после своей же правки — причина в главе 3',
    );
  });

  it('refuses a wide plan without both signatures (CLOSURE_TOO_WIDE)', () => {
    expect(decide(sixChapters).refused).toEqual({
      code: 'CLOSURE_TOO_WIDE',
      sentence: 'правка задевает 6 глав, обязательных из них — 5; автоматически правится не больше 5, дальше решает автор',
    });
    // One signature is not two: the auditor signs the money, the author signs the meaning.
    expect(decide({ ...sixChapters, approvals: { author: true, auditor: false } }).refused?.code).toBe(
      'CLOSURE_TOO_WIDE',
    );
    expect(decide({ ...sixChapters, approvals: both }).refused).toBeNull();
  });

  it('refuses CAUSE_MISSING for an orphan the plan would not patch', () => {
    // A `local` plan executes the origin chapter only, so any orphan outside it is unpatched; the
    // same rule fires on a ripple whose mandatory list forgot the node. `local` itself cannot be
    // chosen with an orphan outside the origin (that is its own definition), so the reachable
    // shape is a ripple with an incomplete mandatory set — which is exactly the defect.
    const decision = decide(
      withInput({
        origin: 5,
        nodes: [
          nodeOf('fct_a', 5, { direction: 'seed' }),
          nodeOf('fct_b', 7),
          nodeOf('fct_z', 13, { direction: 'descendant', via: 'dep_zb' }),
        ],
        mandatory: ['fct_b'],
        orphaned: ['fct_z'],
      }),
    );
    expect(decision.mode).toBe('ripple');
    expect(decision.refused).toEqual({
      code: 'CAUSE_MISSING',
      sentence: 'следствие в главе 13 осталось без причины: глава 5 больше её не даёт',
    });
  });

  it('names a refusal whose node the closure does not carry', () => {
    // A fact the caller knows about but the closure never reached: the sentence falls back to the
    // origin instead of inventing a chapter.
    const missing = decide(
      withInput({ origin: 5, nodes: [nodeOf('fct_a', 5, { direction: 'seed' })], orphaned: ['fct_unknown'] }),
    );
    expect(missing.refused).toEqual({
      code: 'CAUSE_MISSING',
      sentence: 'следствие осталось без причины: глава 5 больше её не даёт',
    });
    const unstable = decide(
      withInput({
        origin: 5,
        nodes: [nodeOf('fct_a', 5, { direction: 'seed' })],
        mandatory: ['fct_a'],
        unstable: { node: 'fct_unknown', cycle: ['fct_unknown'] },
        approvals: both,
      }),
    );
    expect(unstable.refused?.code).toBe('CLOSURE_UNSTABLE');
    expect(unstable.refused?.sentence).toContain('обязательный узел снова обязателен');
  });

  it('declines the counted noun in the accusative (1 главу, 4 главы, 12 глав)', () => {
    const four = decide(
      withInput({
        origin: 1,
        nodes: [1, 2, 3, 4].map((chapter) =>
          nodeOf(`fct_${String(chapter)}`, chapter, { direction: chapter === 1 ? 'seed' : 'descendant' }),
        ),
        mandatory: ['fct_2', 'fct_3', 'fct_4'],
        touched: ['fct_1'],
        crossingEdge: true,
        changedChars: 5000,
      }),
    );
    expect(four.refused?.sentence).toBe(
      'правка задевает 4 главы, обязательных из них — 3; автоматически правится не больше 5, дальше решает автор',
    );
    const one = decide(
      withInput({ origin: 4, nodes: [nodeOf('fct_a', 4, { direction: 'seed' })], changedChars: 5000 }),
    );
    expect(one.refused?.sentence).toBe(
      'правка задевает 1 главу, обязательных из них — 0; автоматически правится не больше 5, дальше решает автор',
    );
  });

  it('leaves a mandatory node unpatched when --apply does not execute its chapter', () => {
    const input = withInput({
      origin: 3,
      nodes: [nodeOf('fct_a', 3, { direction: 'seed' }), nodeOf('fct_b', 7)],
      mandatory: ['fct_b'],
      orphaned: ['fct_b'],
    });
    // Without `--apply` the plan executes every priced chapter, so nothing is left behind.
    expect(decide(input).refused).toBeNull();
    expect(decide({ ...input, applied: null }).refused).toBeNull();
    expect(decide({ ...input, applied: [7] }).refused).toBeNull();
    // `--apply 3` moves ch3 and leaves ch7's mandatory node with no cause: a refusal, not a defer.
    expect(decide({ ...input, applied: [3] }).refused).toEqual({
      code: 'CAUSE_MISSING',
      sentence: 'следствие в главе 7 осталось без причины: глава 3 больше её не даёт',
    });
  });

  it('does not refuse a local change whose orphan is the origin chapter itself', () => {
    const decision = decide(
      withInput({ origin: 5, nodes: [nodeOf('fct_a', 5, { direction: 'seed' })], orphaned: ['fct_a'] }),
    );
    expect(decision.mode).toBe('local');
    expect(decision.refused).toBeNull();
  });
});

describe('parts', () => {
  it('opens at ch01, closes at ch42, and puts anything past the finale there too', () => {
    expect(partOf(1)).toBe('1');
    expect(partOf(2)).toBe('2–11');
    expect(partOf(11)).toBe('2–11');
    expect(partOf(12)).toBe('12–21');
    expect(partOf(42)).toBe('42');
    expect(partOf(67)).toBe('42');
    // A chapter the ledger's CHECK refuses still has to land somewhere: the opening part.
    expect(partOf(0)).toBe('1');
    expect(partsOf([12, 1, 5])).toEqual(['1', '2–11', '12–21']);
    expect(partsOf([])).toEqual([]);
  });
});

describe('priceOf', () => {
  it('charges $0.08 a patched chapter, one $0.01 judge, and $0.09 across a part boundary', () => {
    const price = priceOf(
      withInput({
        origin: 9,
        nodes: [nodeOf('fct_a', 9, { direction: 'seed' }), nodeOf('fct_b', 13)],
        mandatory: ['fct_b'],
      }),
    );
    // ch09 sits in part 2–11, ch13 in 12–21: the closure crosses, so the whole-book read is on.
    expect(price.usd).toBe(2 * 0.08 + 0.01 + 0.09);
    expect(price.usd).toBe(0.26);
    expect(price.byChapter.map((entry) => entry.usd)).toEqual([0.08, 0.08]);
    expect(price.assumptions.join('\n')).toContain('whole-book read $0.09');
    expect(price.assumptions.join('\n')).toContain('the closure walk is $0.00');
  });

  it('rounds to cents and never counts an optional node', () => {
    const price = priceOf(withInput({ nodes: [nodeOf('fct_a', 3, { direction: 'seed' }), nodeOf('fct_o', 20)] }));
    expect(price.usd).toBe(0.09);
    expect(price.chapters).toBe(1);
    expect(price.byChapter[0]?.facts).toEqual([]);
  });
});
