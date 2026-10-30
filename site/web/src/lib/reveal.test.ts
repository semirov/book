import { describe, expect, it } from 'vitest';

import { PRINT } from './printPlan.ts';
import {
  REVEAL,
  activeBlockId,
  blockText,
  chapterReveal,
  createReveal,
  finishReveal,
  graphemeCount,
  graphemes,
  planReveal,
  printsChange,
  revealComplete,
  skipBlocks,
  tickReveal,
} from './reveal.ts';

const blocks = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ id: `ch08#b${index}`, text: 'Абзац '.repeat(8) }));

const BASE = 1_000 / PRINT.cps.desktop;

describe('graphemes', () => {
  it('never splits a combining mark or a surrogate pair', () => {
    expect(graphemes('е\u0301')).toEqual(['е\u0301']);
    expect(graphemes('😀')).toHaveLength(1);
    expect(graphemeCount('е\u0301й')).toBe(2);
  });
});

describe('the clock is the print engine’s (BOOK-220 §11.2)', () => {
  it('schedules a block on the device rate, with no duration cap', () => {
    const state = createReveal([{ id: 'ch08#b0', text: 'абвгд' }]);
    const block = state.blocks[0];
    expect(block?.inkTimes).toHaveLength(5);
    expect(block?.durationMs).toBeGreaterThan(0);
    // A long block is minutes, not the old 2 600 ms ceiling: 500 letters at 30 cps ≈ 17 s.
    const long = createReveal([{ id: 'ch08#b1', text: 'а'.repeat(500) }]);
    expect(long.blocks[0]?.durationMs).toBeGreaterThan(15_000);
    expect(long.blocks[0]?.inkTimes).toHaveLength(500);
  });

  it('keeps the interval bounds: ±25 % of the base, ×1.4 at a word’s end, never past 180 ms', () => {
    const state = createReveal([{ id: 'ch08#b0', text: 'абвгд её' }]);
    const times = state.blocks[0]?.inkTimes ?? [];
    const gaps = times.slice(1).map((time, index) => time - (times[index] ?? 0));
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(BASE * (1 - PRINT.jitter) - 1e-6);
      expect(gap).toBeLessThanOrEqual(BASE * (1 + PRINT.jitter) * PRINT.wordEnd + 1e-6);
      expect(gap).toBeLessThanOrEqual(180);
    }
    // The gap after the fifth grapheme («д» ends the word) is the ×1.4 one.
    expect(gaps[4]).toBeGreaterThan(BASE * 1.25);
  });

  it('seeds the jitter by the block’s own id: a reload prints the same way', () => {
    const first = createReveal([{ id: 'ch08#b0', text: 'Она походила на мою подпись.' }]);
    const again = createReveal([{ id: 'ch08#b0', text: 'Она походила на мою подпись.' }]);
    const other = createReveal([{ id: 'ch08#b7', text: 'Она походила на мою подпись.' }]);
    expect([...(first.blocks[0]?.inkTimes ?? [])]).toEqual([...(again.blocks[0]?.inkTimes ?? [])]);
    expect([...(other.blocks[0]?.inkTimes ?? [])]).not.toEqual([...(first.blocks[0]?.inkTimes ?? [])]);
  });

  it('joins a print already under way at the current frame, never at zero', () => {
    const text = 'Новая глава пишется с первого знака и до последнего.';
    const startAt = Date.parse('2026-10-29T09:00:00Z');
    const fresh = createReveal([{ id: 'ch20#b0', text }], { startAt, now: startAt });
    expect(fresh.blocks[0]?.revealed).toBe(0);
    const joined = createReveal([{ id: 'ch20#b0', text }], { startAt, now: startAt + 1_200 });
    const shown = joined.blocks[0]?.revealed ?? 0;
    expect(shown).toBeGreaterThan(0);
    // 1 200 ms of a 30 cps clock ≈ 30 graphemes; the hold (220 ms) is behind us.
    expect(shown).toBeGreaterThan(20);
    expect(shown).toBeLessThan(graphemes(text).length);
  });
});

describe('planReveal', () => {
  it('prints the whole of a live chapter, block after block, with no block cap', () => {
    const plan = planReveal({ blocks: blocks(30), mode: 'live', chapterAgeMs: 0 });
    expect(plan.queued).toHaveLength(30);
    expect(plan.queued[0]).toBe('ch08#b0');
    expect(plan.instant).toEqual([]);
  });

  it('animates only blocks in the viewport; the rest appear instantly', () => {
    const visible = new Set(['ch08#b1', 'ch08#b2']);
    const plan = planReveal({ blocks: blocks(5), mode: 'live', chapterAgeMs: 0, visibleIds: visible });
    expect(plan.queued).toEqual(['ch08#b1', 'ch08#b2']);
    expect(plan.instant).toEqual(['ch08#b0', 'ch08#b3', 'ch08#b4']);
  });

  it('prints only the tail of a chapter younger than five minutes on join', () => {
    const plan = planReveal({ blocks: blocks(20), mode: 'join', chapterAgeMs: 60_000 });
    expect(plan.queued).toHaveLength(REVEAL.tailBlocks);
    expect(plan.queued[0]).toBe('ch08#b12');
  });

  it('prints nothing when joining an old chapter: no history theatre', () => {
    const plan = planReveal({ blocks: blocks(20), mode: 'join', chapterAgeMs: 6 * 60_000 });
    expect(plan.queued).toEqual([]);
    expect(plan.instant).toHaveLength(20);
  });

  it('respects prefers-reduced-motion', () => {
    const plan = planReveal({ blocks: blocks(3), mode: 'live', chapterAgeMs: 0, reducedMotion: true });
    expect(plan.queued).toEqual([]);
    expect(plan.instant).toHaveLength(3);
  });
});

describe('a change is printed, a machine pass is not (BOOK-117 §1)', () => {
  const chapter = [
    { id: 'ch08#c0', text: 'первый' },
    { id: 'ch08#c1', text: 'второй' },
    { id: 'ch08#c2', text: 'третий' },
  ];

  it('queues only the blocks the revision touched, in document order', () => {
    const plan = planReveal({ blocks: chapter, mode: 'change', changedIds: new Set(['ch08#c2', 'ch08#c1']), chapterAgeMs: 0 });
    expect(plan.queued).toEqual(['ch08#c1', 'ch08#c2']);
    // Untouched blocks are already final: they are not indexed, not even as instant ones.
    expect(plan.instant).toEqual(['ch08#c0']);
  });

  it('prints nothing when the revision touched no block that is on the page', () => {
    const plan = planReveal({ blocks: chapter, mode: 'change', changedIds: new Set(['ch08#gone']), chapterAgeMs: 0 });
    expect(plan.queued).toEqual([]);
    expect(plan.instant).toHaveLength(3);
    // A frame that names nothing prints nothing: the mode alone never types a whole chapter.
    expect(planReveal({ blocks: chapter, mode: 'change', chapterAgeMs: 0 }).queued).toEqual([]);
  });

  it('prints an old chapter’s change: age is a fact about joining, not about the change', () => {
    // The same frame that would print nothing on `join` for a chapter written days ago prints
    // its change: the reader is watching the words arrive, not reading history (BOOK-117 §1).
    const joined = planReveal({ blocks: chapter, mode: 'join', chapterAgeMs: 6 * 60_000 });
    expect(joined.queued).toEqual([]);
    const changed = planReveal({ blocks: chapter, mode: 'change', changedIds: new Set(['ch08#c1']), chapterAgeMs: 6 * 60_000 });
    expect(changed.queued).toEqual(['ch08#c1']);
  });

  it('is instant under reduced motion', () => {
    const plan = planReveal({ blocks: chapter, mode: 'change', changedIds: new Set(['ch08#c1']), chapterAgeMs: 0, reducedMotion: true });
    expect(plan.queued).toEqual([]);
    expect(plan.instant).toHaveLength(3);
  });

  it('prints every block a change touched: no queue cap', () => {
    const many = blocks(30).map((block, index) => ({ ...block, id: `ch08#d${index}` }));
    const plan = planReveal({ blocks: many, mode: 'change', changedIds: new Set(many.map((block) => block.id)), chapterAgeMs: 0 });
    expect(plan.queued).toHaveLength(30);
  });

  it('reads the frame: a reader’s change prints, a cascade or a rewrite cross-fades', () => {
    const cause = { changeId: 'chg_01J9Z8K4Q7' };
    for (const kind of ['edit', 'polish', 'create']) expect(printsChange({ kind, cause }), kind).toBe(true);
    for (const kind of ['rewrite', 'restore']) expect(printsChange({ kind, cause }), kind).toBe(false);
    // No change behind it: machinery, whatever the kind says.
    for (const kind of ['edit', 'polish', 'create']) {
      expect(printsChange({ kind, cause: { changeId: null } }), kind).toBe(false);
    }
  });
});

describe('reveal state', () => {
  it('reveals grapheme by grapheme, at the engine’s own instants', () => {
    const state = createReveal([{ id: 'b1', text: 'абв' }]);
    const ink = state.blocks[0]?.inkTimes ?? [];
    expect(state.active).toBe(0);
    expect(blockText(state, 'b1', 'абв')).toBe('');
    // One grapheme per ink time: the count is the engine's, not a proportional guess.
    const half = tickReveal(state, (ink[0] ?? 0) + 1);
    expect(blockText(half, 'b1', 'абв')).toBe('а');
    const later = tickReveal(state, (ink[1] ?? 0) + 1);
    expect(blockText(later, 'b1', 'абв')).toBe('аб');
    expect(revealComplete(tickReveal(state, 10_000))).toBe(true);
  });

  it('prints blocks in order and carries leftover time into the next', () => {
    let state = createReveal([
      { id: 'b1', text: 'а' },
      { id: 'b2', text: 'б' },
    ]);
    const first = state.blocks[0]?.durationMs ?? 0;
    state = tickReveal(state, first + 1);
    expect(activeBlockId(state)).toBe('b2');
    expect(blockText(state, 'b1', 'а')).toBe('а');
    expect(blockText(state, 'b2', 'б')).toBe('');

    state = tickReveal(state, state.blocks[1]?.durationMs ?? 0);
    expect(revealComplete(state)).toBe(true);
  });

  it('skips blocks outside the viewport and moves the caret to the next visible one', () => {
    const state = createReveal([
      { id: 'b1', text: 'абв' },
      { id: 'b2', text: 'где' },
      { id: 'b3', text: 'ёж' },
    ]);
    const skipped = skipBlocks(state, new Set(['b1']));
    expect(blockText(skipped, 'b1', 'абв')).toBe('абв');
    expect(activeBlockId(skipped)).toBe('b2');
    expect(blockText(skipped, 'b2', 'где')).toBe('');

    const all = skipBlocks(skipped, new Set(['b2', 'b3']));
    expect(revealComplete(all)).toBe(true);
    expect(skipBlocks(all, new Set(['b2']))).toBe(all);

    const ticked = tickReveal(skipped, 10_000);
    expect(blockText(ticked, 'b1', 'абв')).toBe('абв');
    expect(revealComplete(ticked)).toBe(true);
  });

  it('finishes at once on «показать сразу» and stays complete', () => {
    const state = createReveal([{ id: 'b1', text: 'абв' }, { id: 'b2', text: 'где' }]);
    const done = finishReveal(state);
    expect(revealComplete(done)).toBe(true);
    expect(blockText(done, 'b1', 'абв')).toBe('абв');
    expect(blockText(done, 'b2', 'где')).toBe('где');
    expect(finishReveal(done)).toBe(done);
  });

  it('is instant under reduced motion', () => {
    const state = createReveal([{ id: 'b1', text: 'абв' }], { reducedMotion: true });
    expect(revealComplete(state)).toBe(true);
    expect(blockText(state, 'b1', 'абв')).toBe('абв');
  });

  it('lands a long cover title whole at the sheet’s own 400 ms budget (BOOK-DOC-49 §3)', () => {
    // The cover is not a print: its sequence has one constant, and the engine is the same.
    const title = 'я'.repeat(90);
    const capped = createReveal([{ id: 'title', text: title }], { capBlockMs: 400 });
    expect(capped.blocks[0]?.durationMs).toBe(400);
    // The ceiling is the sheet's: whole by 400, still arriving a quarter of the way in.
    expect(revealComplete(tickReveal(capped, 100))).toBe(false);
    expect(blockText(tickReveal(capped, 400), 'title', title)).toBe(title);

    // Without the cap the same run is still printing at 400: the option is what changed.
    const uncapped = createReveal([{ id: 'title', text: title }]);
    expect(uncapped.blocks[0]?.durationMs).toBeGreaterThan(400);
    expect(blockText(tickReveal(uncapped, 400), 'title', title)).not.toBe(title);
  });

  it('ignores non-positive ticks', () => {
    const state = createReveal([{ id: 'b1', text: 'абв' }]);
    expect(tickReveal(state, 0)).toBe(state);
    expect(tickReveal(state, -5)).toBe(state);
  });
});

describe('chapterReveal', () => {
  const chapter = (writtenAt: string) => ({
    writtenAt,
    blocks: [
      { id: 'ch08#b0', i: 0, text: 'Первый абзац главы.', hash: 'b0' },
      { id: 'ch08#b1', i: 1, text: 'Второй абзац главы.', hash: 'b1' },
    ],
  });
  const now = Date.parse('2026-10-27T09:01:00Z');

  it('prints a chapter the reader watched arrive, and joins an old one silently', () => {
    const live = chapterReveal(chapter('2026-10-27T09:00:00Z'), { fresh: true, now });
    expect(live.blocks.map((block) => block.id)).toEqual(['ch08#b0', 'ch08#b1']);

    const joined = chapterReveal(chapter('2026-10-01T09:00:00Z'), { fresh: false, now });
    expect(joined.blocks).toEqual([]);
  });

  it('prints a chapter being written from its own clock, joining mid-print', () => {
    const startAt = now;
    const state = chapterReveal(chapter('2026-10-27T09:00:00Z'), { fresh: false, live: true, startAt, now: startAt + 1_500 });
    expect(state.blocks.map((block) => block.id)).toEqual(['ch08#b0', 'ch08#b1']);
    // The first block is under way and not restarting from zero.
    expect(state.blocks[0]?.revealed ?? 0).toBeGreaterThan(10);
  });

  it('prints only the blocks a change names', () => {
    const state = chapterReveal(chapter('2026-10-27T09:00:00Z'), { fresh: false, changed: new Set(['ch08#b1']), now });
    expect(state.blocks.map((block) => block.id)).toEqual(['ch08#b1']);
  });

  it('sets everything at once under reduced motion, and reads a broken date as just written', () => {
    const state = chapterReveal(chapter('не дата'), { fresh: true, reducedMotion: true, now });
    expect(revealComplete(state)).toBe(true);
    expect(blockText(state, 'ch08#b0', 'Первый абзац главы.')).toBe('Первый абзац главы.');
    // An unreadable date is not provably old, so a join prints the tail it always printed.
    expect(chapterReveal(chapter('не дата'), { fresh: false, now }).blocks.map((item) => item.id)).toEqual(['ch08#b0', 'ch08#b1']);
  });
});
