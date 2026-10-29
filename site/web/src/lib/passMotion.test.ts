import { describe, expect, it } from 'vitest';

import tokensCss from '../styles/tokens.css?raw';
import {
  PASS,
  STATIC_TIMELINE_MS,
  frameAt,
  planPass,
  rateFor,
  type PassBeat,
  type PassPlan,
} from './passMotion.ts';
import { PASS_FIXTURES, type PassFixture } from './passMotionFixtures.ts';
import { graphemes } from './reveal.ts';

/**
 * BOOK-121 — the golden fixtures and the pinned reference frames of BOOK-116 comment #3705.
 * The numbers are the orchestrator's independent arithmetic; if a frame ever disagrees with the
 * table, the table wins and the module changes — not the test.
 */

function fixture(prefix: string): PassFixture {
  const found = PASS_FIXTURES.find((entry) => entry.name.startsWith(prefix));
  if (found === undefined) throw new Error(`missing fixture ${prefix}`);
  return found;
}

const planOf = (prefix: string): PassPlan => planPass(fixture(prefix).input);

type ExpectedFrame = {
  at: number;
  beat: PassBeat;
  revealed: number;
  selected: boolean;
  selectionOpacity: number;
  swapped: boolean;
  persist: boolean;
  settled: boolean;
  blue: { line: number; fading: boolean } | null;
  red: { line: number; col: number; resting: boolean; fading: boolean } | null;
};

function expectFrame(plan: PassPlan, expected: ExpectedFrame): void {
  const frame = frameAt(plan, expected.at);
  expect(frame.at).toBe(expected.at);
  expect(frame.beat).toBe(expected.beat);
  expect(frame.revealed).toBe(expected.revealed);
  expect(frame.selected).toBe(expected.selected);
  expect(frame.selectionOpacity).toBeCloseTo(expected.selectionOpacity, 3);
  expect(frame.swapped).toBe(expected.swapped);
  expect(frame.persist).toBe(expected.persist);
  expect(frame.settled).toBe(expected.settled);

  if (expected.blue === null) {
    expect(frame.blue).toBeNull();
  } else {
    expect(frame.blue).not.toBeNull();
    expect(frame.blue?.line).toBeCloseTo(expected.blue.line, 1);
    expect(frame.blue?.fading).toBe(expected.blue.fading);
    expect(frame.blue?.opacity).toBe(1);
  }

  if (expected.red === null) {
    expect(frame.red).toBeNull();
  } else {
    expect(frame.red).not.toBeNull();
    expect(frame.red?.line).toBeCloseTo(expected.red.line, 1);
    expect(frame.red?.col).toBe(expected.red.col);
    expect(frame.red?.resting).toBe(expected.red.resting);
    expect(frame.red?.fading).toBe(expected.red.fading);
    expect(frame.red?.opacity).toBe(1);
  }
}

describe('the three plans', () => {
  it('times a replacement: split 260, last ink 870, settled 1843.33', () => {
    const plan = planOf('replacement');
    expect(plan.kind).toBe('replacement');
    expect(plan.cps).toBe(40);
    expect(plan.graphemes).toHaveLength(23);
    expect(plan.splitMs).toBe(260);
    expect(plan.swapMs).toBe(260);
    expect(plan.inkTimes[0]).toBe(260);
    expect(plan.inkTimes[11] ?? 0).toBe(535); // the comma is grapheme 12
    expect(plan.inkTimes[12] ?? 0).toBe(620); // +60 ms after it
    expect(plan.persistMs).toBeCloseTo(870, 5);
    // BOOK-DOC-84 §4: the blue is born at the run's first line (2), so its climb is 2 lines /
    // 500 ms and its fade starts at the persist, not 1500 ms later at the paragraph's bottom.
    expect(plan.blue.distanceLines).toBe(2);
    expect(plan.blue.fadeStartMs).toBeCloseTo(870, 5);
    expect(plan.blue.fadeEndMs).toBeCloseTo(1050, 5);
    expect(plan.red.fadeEndMs).toBeCloseTo(1843.333, 2);
    expect(plan.settleMs).toBeCloseTo(1843.333, 2);
  });

  it('takes the desktop 40 cps when the fixture names no rate', () => {
    expect(fixture('replacement').input.cps).toBeUndefined();
    const input = { ...fixture('replacement').input, cps: undefined };
    const implicit = planPass(input);
    const explicit = planPass({ ...input, cps: 40 });
    expect(implicit.cps).toBe(40);
    expect(implicit.inkTimes).toEqual(explicit.inkTimes);
    for (let at = 0; at <= implicit.settleMs; at += 25) {
      expect(frameAt(implicit, at)).toEqual(frameAt(explicit, at));
    }
  });

  it('ramps both carets linearly over their own fades', () => {
    const plan = planOf('replacement');
    expect(plan.blue.fadeStartMs).toBeCloseTo(870, 5);
    expect(frameAt(plan, 960).blue?.opacity).toBeCloseTo(0.5, 2);
    expect(plan.red.fadeStartMs).toBeCloseTo(1703.333, 2);
    expect(frameAt(plan, 1773.333).red?.opacity).toBeCloseTo(0.5, 2);
  });

  it('clamps a deletion’s wordRanges to the old text', () => {
    const plan = planPass({ ...fixture('deletion').input, wordRanges: [[0, 3], [4, 999], [50, 60]] });
    expect(plan.words.map((word) => [word.from, word.to])).toEqual([
      [0, 3],
      [4, 14],
      [14, 14],
    ]);
  });

  it('times an insertion: the point holds 220, last ink 1427.06, settled 2817.06', () => {
    const plan = planOf('insertion');
    expect(plan.kind).toBe('insertion');
    expect(plan.cps).toBe(34);
    expect(plan.graphemes).toHaveLength(40);
    expect(plan.splitMs).toBe(220);
    expect(plan.swapMs).toBe(220);
    expect(plan.inkTimes[0]).toBe(220);
    expect(plan.persistMs).toBeCloseTo(1427.0588, 3);
    expect(plan.blue.distanceLines).toBe(3);
    expect(plan.blue.fadeStartMs).toBeCloseTo(1427.0588, 3);
    expect(plan.red.fadeStartMs).toBeCloseTo(2677.0588, 3);
    expect(plan.settleMs).toBeCloseTo(2817.0588, 3);
  });

  it('times a deletion: split 560, swap 820, settled 1033.33', () => {
    const plan = planOf('deletion');
    expect(plan.kind).toBe('deletion');
    expect(plan.graphemes).toHaveLength(0);
    expect(plan.inkTimes).toEqual([]);
    expect(plan.splitMs).toBe(560);
    expect(plan.swapMs).toBe(820);
    expect(plan.persistMs).toBe(820);
    expect(plan.red.fadeStartMs).toBeCloseTo(893.333, 2);
    expect(plan.red.fadeEndMs).toBeCloseTo(1033.333, 2);
    expect(plan.settleMs).toBeCloseTo(1033.333, 2);
  });

  it('honours an explicit wordRanges override', () => {
    const plan = planPass({
      ...fixture('replacement').input,
      wordRanges: [
        [0, 6],
        [6, 13],
        [13, 23],
      ],
    });
    expect(plan.words.map((word) => [word.from, word.to])).toEqual([
      [0, 6],
      [6, 13],
      [13, 23],
    ]);
    expect(plan.words[0]?.fadeStartMs).toBe(plan.inkTimes[0]);
    expect(plan.words[2]?.fadeEndMs).toBe(plan.inkTimes[plan.inkTimes.length - 1]);
  });

  it('collapses surplus old words together in the last 100 ms', () => {
    const plan = planPass({
      kind: 'replacement',
      before: 'одно два три четыре пять',
      after: 'да',
      cps: 40,
      layout: { linePx: 30.24, blockLines: 4, runLines: [1, 1], spanStartLine: 1, spanLines: 1 },
    });
    expect(plan.words).toHaveLength(5);
    const surplus = plan.words.filter((word) => word.from >= word.to);
    expect(surplus.length).toBeGreaterThan(0);
    expect(PASS.contraction.floorMs).toBe(100);
    for (const word of surplus) {
      expect(word.fadeEndMs - word.fadeStartMs).toBe(100);
      expect(word.fadeEndMs).toBe(plan.persistMs);
    }
  });

  it('rests the red caret 220 ms when the span ends on the block’s last line', () => {
    const plan = planPass({
      kind: 'replacement',
      before: 'абв',
      after: 'где',
      cps: 40,
      layout: { linePx: 30.24, blockLines: 4, runLines: [3, 3, 3], spanStartLine: 3, spanLines: 1 },
    });
    expect(plan.red.tailMs).toBe(0);
    expect(PASS.red.restMs).toBe(220);
    expect(plan.red.fadeStartMs).toBeCloseTo(plan.persistMs + 220, 5);
    const resting = frameAt(plan, plan.persistMs + 100);
    expect(resting.red?.resting).toBe(true);
    expect(resting.red?.line).toBe(3);
  });

  it('rests the deletion’s red caret when the span is already on the last line', () => {
    const plan = planPass({
      kind: 'deletion',
      before: 'абв',
      after: '',
      cps: 34,
      layout: { linePx: 28.56, blockLines: 3, runLines: [], spanStartLine: 2, spanLines: 1 },
    });
    expect(plan.red.tailMs).toBe(0);
    expect(plan.red.fadeStartMs).toBeCloseTo(plan.splitMs + 220, 5);
    expect(frameAt(plan, plan.splitMs + 100).red?.resting).toBe(true);
  });

  it('schedules the selection boxes at words, paint 120 ms each, 20 ms apart', () => {
    const replacement = planOf('replacement');
    expect(replacement.words.map((word) => [word.paintStartMs, word.paintEndMs])).toEqual([
      [0, 120],
      [20, 140],
      [40, 160],
    ]);
    // Old word i owns round(i·23/3)…round((i+1)·23/3) of the new run; the box fades with its slice.
    expect(replacement.words.map((word) => [word.from, word.to])).toEqual([
      [0, 8],
      [8, 15],
      [15, 23],
    ]);
    expect(replacement.words.map((word) => [word.fadeStartMs, word.fadeEndMs])).toEqual([
      [260, 435],
      [460, 670],
      [695, 870],
    ]);

    const deletion = planOf('deletion');
    expect(deletion.words.map((word) => [word.from, word.to])).toEqual([
      [0, 3],
      [4, 8],
      [9, 14],
    ]);
    // 560 / 620 / 680, 140 ms each, the last out at 820 — the swap.
    expect(deletion.words.map((word) => [word.fadeStartMs, word.fadeEndMs])).toEqual([
      [560, 700],
      [620, 760],
      [680, 820],
    ]);

    expect(planOf('insertion').words).toEqual([]);
  });
});

describe('the twelve reference frames', () => {
  it('replacement · 1440: paint, hold, type, tail', () => {
    const plan = planOf('replacement');
    const frames: ExpectedFrame[] = [
      { at: 0, beat: 'paint', revealed: 0, selected: true, selectionOpacity: 0, swapped: false,
        persist: false, settled: false, blue: null, red: null },
      { at: 200, beat: 'hold', revealed: 0, selected: true, selectionOpacity: 1, swapped: false,
        persist: false, settled: false, blue: null, red: null },
      { at: 800, beat: 'type', revealed: 20, selected: true, selectionOpacity: 0.4, swapped: true,
        persist: false, settled: false, blue: { line: 0, fading: false },
        red: { line: 2, col: 20, resting: false, fading: false } },
      // The blue's climb is over at 760 and its fade ends at 1050: the read caret is gone
      // while the red is still walking the run down (they crossed in time, never in place).
      { at: 1600, beat: 'tail', revealed: 23, selected: false, selectionOpacity: 0, swapped: true,
        persist: true, settled: false, blue: null,
        red: { line: 4.75, col: 23, resting: false, fading: false } },
    ];
    for (const expected of frames) expectFrame(plan, expected);
    expect(frameAt(plan, 1600).blue).toBeNull();
    // Born at the run's first line and at its first grapheme, never below the paragraph.
    expect(frameAt(plan, 260).blue?.line).toBeCloseTo(2, 1);
    expect(frameAt(plan, 260).blue?.col).toBe(0);
  });

  it('insertion · 390: the point holds, then type, then tail', () => {
    const plan = planOf('insertion');
    const frames: ExpectedFrame[] = [
      { at: 0, beat: 'point', revealed: 0, selected: false, selectionOpacity: 0, swapped: false,
        persist: false, settled: false, blue: null, red: { line: 3, col: 0, resting: true, fading: false } },
      { at: 200, beat: 'point', revealed: 0, selected: false, selectionOpacity: 0, swapped: false,
        persist: false, settled: false, blue: null, red: { line: 3, col: 0, resting: true, fading: false } },
      { at: 800, beat: 'type', revealed: 18, selected: false, selectionOpacity: 0, swapped: true,
        persist: false, settled: false, blue: { line: 0.1, fading: false },
        red: { line: 3, col: 18, resting: false, fading: false } },
      { at: 1700, beat: 'tail', revealed: 40, selected: false, selectionOpacity: 0, swapped: true,
        persist: true, settled: false, blue: null,
        red: { line: 4.65, col: 40, resting: false, fading: false } },
    ];
    for (const expected of frames) expectFrame(plan, expected);
    // The blue is at the top and fading at 1500 (its 750 ms climb ends at 970; the fade runs
    // to 1607), and it is gone by 1700: a read caret that left is not a mark.
    const fading = frameAt(plan, 1500).blue;
    expect(fading?.line).toBeCloseTo(0, 1);
    expect(fading?.fading).toBe(true);
  });

  it('deletion · 390: paint, a long hold, the fades, then settled', () => {
    const plan = planOf('deletion');
    const frames: ExpectedFrame[] = [
      { at: 0, beat: 'paint', revealed: 0, selected: true, selectionOpacity: 0, swapped: false,
        persist: false, settled: false, blue: null, red: null },
      { at: 200, beat: 'hold', revealed: 0, selected: true, selectionOpacity: 1, swapped: false,
        persist: false, settled: false, blue: null, red: null },
      { at: 800, beat: 'fade', revealed: 0, selected: true, selectionOpacity: 0.143, swapped: false,
        persist: false, settled: false, blue: { line: 0, fading: false },
        red: { line: 1.72, col: 0, resting: false, fading: false } },
      { at: 1600, beat: 'settled', revealed: 0, selected: false, selectionOpacity: 0, swapped: true,
        persist: true, settled: true, blue: null, red: null },
    ];
    for (const expected of frames) expectFrame(plan, expected);
  });
});

describe('the schedule holds', () => {
  it('inks one grapheme exactly at its time, never earlier, and times strictly increase', () => {
    for (const entry of PASS_FIXTURES) {
      const plan = planPass(entry.input);
      for (let index = 0; index < plan.inkTimes.length; index += 1) {
        const time = plan.inkTimes[index] ?? 0;
        expect(frameAt(plan, time - 0.001).revealed).toBe(index);
        expect(frameAt(plan, time).revealed).toBe(index + 1);
        if (index > 0) expect(time).toBeGreaterThan(plan.inkTimes[index - 1] ?? 0);
      }
    }
  });

  /**
   * What this can prove: every frame carries the caller's own map, and the caret stands on the
   * caller's entry for the last inked grapheme — a schedule read against any other map cannot be
   * built, because `planPass` rejects it (the next block). The DOM's 0 px proof belongs to the
   * strip session, not here.
   */
  it('carries the caller’s layout: the same map at every instant, every line inside the block', () => {
    for (const entry of PASS_FIXTURES) {
      const layout = entry.input.layout;
      const called = [...layout.runLines];
      const plan = planPass(entry.input);
      for (let at = 0; at <= plan.settleMs + 500; at += 10) {
        const frame = frameAt(plan, at);
        expect(frame.lines).toBe(layout.blockLines);
        expect(frame.runLines).toEqual(called);
        expect(frame.graphemeCount).toBe(graphemes(entry.input.after).length);
        for (const line of frame.runLines) {
          expect(line).toBeGreaterThanOrEqual(0);
          expect(line).toBeLessThan(layout.blockLines);
        }
        if (frame.red !== null && frame.red.col > 0 && frame.beat === 'type') {
          expect(frame.red.line).toBe(called[frame.red.col - 1]);
        }
      }
    }
  });

  it('rejects a run map that is short, long, out of range or going backwards', () => {
    const input = fixture('replacement').input;
    const called = input.layout.runLines;
    const withMap = (runLines: readonly number[]): (() => unknown) => () =>
      planPass({ ...input, layout: { ...input.layout, runLines } });
    expect(withMap(called.slice(0, -1))).toThrow(RangeError);
    expect(withMap(called.slice(0, -1))).toThrow(/runLines maps 22, not the 23 graphemes/u);
    expect(withMap([...called, 2])).toThrow(/runLines maps 24/u);
    expect(withMap([...called.slice(0, -1), input.layout.blockLines])).toThrow(/is not a line of the block/u);
    expect(withMap([-1, ...called.slice(1)])).toThrow(/is not a line of the block/u);
    expect(withMap([...called.slice(0, -1), 1])).toThrow(/goes back from the line before/u);
  });

  it('rejects a deletion map, and a block or span that cannot describe one', () => {
    const deletion = fixture('deletion').input;
    expect(() => planPass({ ...deletion, layout: { ...deletion.layout, runLines: [0] } })).toThrow(/must be empty/u);
    const input = fixture('replacement').input;
    const bad = (patch: Partial<typeof input.layout>): (() => unknown) => () =>
      planPass({ ...input, layout: { ...input.layout, ...patch } });
    expect(bad({ linePx: 0 })).toThrow(/linePx/u);
    expect(bad({ blockLines: 0 })).toThrow(/blockLines/u);
    expect(bad({ spanStartLine: 6 })).toThrow(/spanStartLine/u);
    expect(bad({ spanLines: 5 })).toThrow(/spanLines/u);
  });

  it('clamps a negative time to 0 and turns a non-finite one into the settled frame', () => {
    const plan = planOf('replacement');
    expect(frameAt(plan, -500).at).toBe(0);
    expect(frameAt(plan, -500).beat).toBe('paint');
    expect(frameAt(plan, Number.NaN).beat).toBe('settled');
    expect(frameAt(plan, Number.NaN).settled).toBe(true);
  });
});

describe('reduced motion and the static timeline', () => {
  it('answers the settled frame at every time, with no carets, no selection, everything inked', () => {
    for (const entry of PASS_FIXTURES) {
      const plan = planPass({ ...entry.input, reducedMotion: true });
      expect(plan.reduced).toBe(true);
      for (const at of [0, 123, 800, 10_000, STATIC_TIMELINE_MS]) {
        const frame = frameAt(plan, at);
        expect(frame.beat).toBe('static');
        expect(frame.revealed).toBe(plan.graphemes.length);
        expect(frame.swapped).toBe(true);
        expect(frame.persist).toBe(true);
        expect(frame.settled).toBe(true);
        expect(frame.selected).toBe(false);
        expect(frame.selectionOpacity).toBe(0);
        expect(frame.blue).toBeNull();
        expect(frame.red).toBeNull();
        expect(frame.words.every((word) => word.opacity === 0)).toBe(true);
      }
    }
  });

  it('settles a normal plan at infinity, and the static timeline is infinity', () => {
    expect(STATIC_TIMELINE_MS).toBe(Number.POSITIVE_INFINITY);
    for (const entry of PASS_FIXTURES) {
      const plan = planPass(entry.input);
      for (const at of [Number.POSITIVE_INFINITY, STATIC_TIMELINE_MS, plan.settleMs]) {
        const frame = frameAt(plan, at);
        expect(frame.beat).toBe('settled');
        expect(frame.revealed).toBe(plan.graphemes.length);
        expect(frame.swapped).toBe(true);
        expect(frame.persist).toBe(true);
        expect(frame.settled).toBe(true);
        expect(frame.blue).toBeNull();
        expect(frame.red).toBeNull();
      }
    }
  });
});

describe('rateFor', () => {
  it('falls back to the desktop rate for a base that is not a positive finite number', () => {
    expect(rateFor(10, 0)).toBe(PASS.cps.desktop);
    expect(rateFor(10, Number.NaN)).toBe(PASS.cps.desktop);
  });

  it('keeps the base floor and lifts a long run to the 60 cps ceiling', () => {
    expect(rateFor(23, PASS.cps.desktop)).toBe(40);
    expect(rateFor(40, PASS.cps.phone)).toBe(34);
    expect(rateFor(400, PASS.cps.phone)).toBe(60);
  });
});

describe('the red the owner asked for', () => {
  /**
   * The owner asked for red literally (blue up, red down). The designer's §3.3 "no red" is
   * answered by shape — a hollow bar with a foot for the read caret, a solid bar with a hood for
   * the write one — not by dropping the colour; the shape ships in the next session.
   */
  const block = (pattern: RegExp): string => pattern.exec(tokensCss)?.[1] ?? '';
  const token = (source: string, name: string): string => {
    const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`, 'u').exec(source);
    if (match === null) throw new Error(`--${name} is missing`);
    return (match[1] ?? '').toLowerCase();
  };
  const luminance = (hex: string): number => {
    const value = Number.parseInt(hex.slice(1), 16);
    const channel = (shift: number): number => {
      const raw = (value >> shift) & 255;
      const share = raw / 255;
      return share <= 0.04045 ? share / 12.92 : ((share + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
  };
  const contrast = (one: string, other: string): number =>
    (Math.max(luminance(one), luminance(other)) + 0.05) / (Math.min(luminance(one), luminance(other)) + 0.05);

  it('pairs --write with each paper and holds 4.5:1 on both', () => {
    const day = block(/:root\s*\{([^}]*)\}/u);
    const night = block(/\[data-theme='night'\]\s*\{([^}]*)\}/u);
    expect(day).not.toBe('');
    expect(night).not.toBe('');

    const dayWrite = token(day, 'write');
    const nightWrite = token(night, 'write');
    expect(dayWrite).toBe('#8a1f1f');
    expect(nightWrite).toBe('#cb685e');
    expect(token(day, 'paper')).toBe('#cfd3d2');
    expect(token(night, 'paper')).toBe('#0b0c0d');

    expect(contrast(dayWrite, token(day, 'paper'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(nightWrite, token(night, 'paper'))).toBeGreaterThanOrEqual(4.5);
  });
});
