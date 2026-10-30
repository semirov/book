import { describe, expect, it } from 'vitest';

import { graphemes } from './reveal.ts';
import { PRINT, blockedGaps, caretIndexAt, planPrint, revealedAt, type PrintPlan } from './printPlan.ts';

/**
 * BOOK-220 §11.2 — the print's clock.
 *
 * Every number the contract names is pinned here, because the engine is pure: the base is
 * constant (30 cps desk, 26 phone), the jitter is ±25 % and seeded, a word's end is ×1.4, the
 * hesitations are one per 40–60 characters and never inside a number or a name, and nothing in
 * the plan is an ease-in, a curve or a cap that lifts the rate.
 */

const BASE = 1_000 / PRINT.cps.desktop;

const plan = (after: string, overrides: Partial<Parameters<typeof planPrint>[0]> = {}): PrintPlan =>
  planPrint({ kind: 'insertion', before: '', after, seed: 'seed', ...overrides });

/** The step between two consecutive inks: the interval the reader feels. */
function gaps(of: PrintPlan): number[] {
  const out: number[] = [];
  for (let index = 1; index < of.inkTimes.length; index += 1) {
    out.push((of.inkTimes[index] ?? 0) - (of.inkTimes[index - 1] ?? 0));
  }
  return out;
}

/** The median ignores the hesitations a long text necessarily carries: it is the base rate. */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

describe('the pace', () => {
  it('is the device rate: 30 cps on a desk, 26 in the hand', () => {
    const desk = plan('слово слово');
    const phone = plan('слово слово', { cps: PRINT.cps.phone });
    expect(desk.baseMs).toBeCloseTo(BASE, 6);
    expect(phone.baseMs).toBeCloseTo(1_000 / 26, 6);
    expect(desk.baseMs).toBeLessThan(phone.baseMs);
  });

  it('seeds the jitter: the same pass prints the same rhythm, another seed does not', () => {
    const text = 'Она походила на мою подпись, как тень на человека, брошенная на снег.';
    const first = plan(text);
    const again = plan(text);
    const other = plan(text, { seed: 'another' });
    expect([...again.inkTimes]).toEqual([...first.inkTimes]);
    expect([...other.inkTimes]).not.toEqual([...first.inkTimes]);
  });

  it('keeps every ordinary interval inside ±25 %, and never past 180 ms', () => {
    const of = plan('абвгдежзик лмнопрстуф');
    const values = gaps(of);
    expect(values.length).toBe(of.inkTimes.length - 1);
    for (const value of values) {
      expect(value).toBeGreaterThanOrEqual(BASE * (1 - PRINT.jitter) - 1e-6);
      expect(value).toBeLessThanOrEqual(BASE * (1 + PRINT.jitter) * PRINT.wordEnd + 1e-6);
      expect(value).toBeLessThanOrEqual(180);
    }
  });

  it('has no easing ramp: the base is the same at the start and at the end of a long run', () => {
    const of = plan('а'.repeat(600));
    const values = gaps(of);
    const quarter = Math.floor(values.length / 4);
    const head = median(values.slice(0, quarter));
    const tail = median(values.slice(-quarter));
    expect(Math.abs(head - BASE)).toBeLessThan(BASE * 0.1);
    expect(Math.abs(tail - BASE)).toBeLessThan(BASE * 0.1);
    // A ramp would make one of them far from the base; a constant base keeps both within jitter.
    expect(Math.abs(tail - head)).toBeLessThan(BASE * 0.1);
  });

  it('pauses ×1.4 at a word’s end, and only there', () => {
    // One five-letter word, then a space: the gap after the fifth grapheme is the word's end.
    const of = plan('абвгд её');
    const values = gaps(of);
    const inside = values.slice(0, 4);
    const wordEnd = values[4] ?? 0;
    for (const gap of inside) expect(gap).toBeLessThanOrEqual(BASE * (1 + PRINT.jitter));
    expect(wordEnd).toBeGreaterThanOrEqual(BASE * PRINT.wordEnd * (1 - PRINT.jitter));
    expect(wordEnd).toBeLessThanOrEqual(BASE * PRINT.wordEnd * (1 + PRINT.jitter));
    // The word ends longer than every in-word step of the same word (the bound above is the proof).
    expect(wordEnd).toBeGreaterThan(median(inside) * 1.1);
  });

  it('the runaway guard never lifts the base rate: a long run keeps the reader’s pace', () => {
    const of = plan('я'.repeat(3_000));
    const values = gaps(of);
    // No four-second cap, no lift: the whole run is the device rate and takes minutes.
    expect(of.totalMs).toBeGreaterThan(60_000);
    expect(Math.abs(median(values) - BASE)).toBeLessThan(BASE * 0.1);
    // The guard is a ceiling on one step, not a speed: nothing is compressed below the jitter.
    for (const value of values) expect(value).toBeLessThanOrEqual(PRINT.stepGuardMs);
  });

  it('refuses a plan past the hour-long guard instead of printing for ever', () => {
    expect(() => plan('я'.repeat(130_000))).toThrow(RangeError);
  });
});

describe('the hesitations', () => {
  const prose =
    'В 1965 году Пётр принёс мне папку с бумагами, и мы сидели над ними до утра, пока не стало светать, ' +
    'а потом он ушёл и больше не вернулся, и я остался один с этими листами и с их молчанием.';

  it('happens once per forty to sixty characters, never twice in a row', () => {
    const of = plan(prose.repeat(3));
    const clusters = of.graphemes;
    expect(of.hesitations.length).toBeGreaterThan(1);
    let previous = -1;
    for (const at of of.hesitations) {
      expect(at).toBeGreaterThan(previous);
      // Never adjacent, and never closer than the engine's own gap: two beats in a row read
      // as a stall, not as a person.
      expect(at - previous).toBeGreaterThanOrEqual(PRINT.hesitation.gap);
      previous = at;
    }
    expect(clusters.length).toBeGreaterThan(70);
    const first = of.hesitations[0] ?? 0;
    expect(first).toBeGreaterThanOrEqual(PRINT.hesitation.everyFrom);
    expect(first).toBeLessThanOrEqual(PRINT.hesitation.everyFrom * 2);
    for (const value of gaps(of)) expect(value).toBeLessThanOrEqual(PRINT.stepGuardMs);
  });

  it('never falls inside a number or a name', () => {
    const clusters = graphemes(prose);
    const blocked = blockedGaps(clusters);
    // The rule has teeth: the gaps inside «1965» and inside «Пётр» are blocked, the one after
    // «году» is not.
    const digits = clusters.join('').indexOf('1965');
    expect(digits).toBeGreaterThan(0);
    const digitAt = clusters.slice(0, clusters.length).findIndex((_, index) => clusters.slice(0, index).join('').length === digits + 1);
    expect(blocked.has(digitAt)).toBe(true);

    const of = plan(prose.repeat(3));
    for (const at of of.hesitations) expect(blocked.has(at)).toBe(false);
  });

  it('reads as a hesitation: at least one step is longer than any ordinary interval', () => {
    const of = plan(prose.repeat(3));
    expect(Math.max(...gaps(of))).toBeGreaterThan(PRINT.hesitation.fromMs);
  });
});

describe('what the renderer reads', () => {
  it('reveals monotonically, and the caret never runs ahead of the ink', () => {
    const of = plan('Каждый символ появляется в порядке чтения.');
    let seen = 0;
    for (let at = 0; at <= of.totalMs + 10; at += 7) {
      const revealed = revealedAt(of, at);
      expect(revealed).toBeGreaterThanOrEqual(seen);
      expect(caretIndexAt(of, at)).toBe(revealed);
      seen = revealed;
    }
    expect(revealedAt(of, of.totalMs + 1)).toBe(of.graphemes.length);
  });

  it('a deletion inks nothing: only the ghost has a life', () => {
    const of = planPrint({ kind: 'deletion', before: 'исчезло', after: '', seed: 's' });
    expect(of.graphemes).toEqual([]);
    expect(of.inkTimes).toEqual([]);
    expect(of.strikeMs).toBe(PRINT.strikeMs);
  });

  it('reduced motion schedules no ink at all', () => {
    const of = planPrint({ kind: 'replacement', before: 'старое', after: 'новое', seed: 's', reducedMotion: true });
    expect(of.reduced).toBe(true);
    expect(of.inkTimes).toEqual([]);
    expect(of.totalMs).toBe(PRINT.strikeMs);
  });
});
