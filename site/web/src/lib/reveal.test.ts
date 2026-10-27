import { describe, expect, it } from 'vitest';

import {
  REVEAL,
  activeBlockId,
  blockDurationMs,
  blockText,
  createReveal,
  finishReveal,
  graphemeCount,
  graphemes,
  planReveal,
  revealComplete,
  skipBlocks,
  tickReveal,
} from './reveal.ts';

const blocks = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ id: `ch08#b${index}`, text: 'Абзац '.repeat(8) }));

describe('graphemes', () => {
  it('never splits a combining mark or a surrogate pair', () => {
    expect(graphemes('е\u0301')).toEqual(['е\u0301']);
    expect(graphemes('😀')).toHaveLength(1);
    expect(graphemeCount('е\u0301й')).toBe(2);
  });
});

describe('blockDurationMs', () => {
  it('clamps a short block and a long block', () => {
    expect(blockDurationMs('а')).toBe(REVEAL.minBlockMs);
    expect(blockDurationMs('а'.repeat(500))).toBe(REVEAL.maxBlockMs);
  });

  it('keeps the cover word at the house rate: «Бланк» is 277.8 ms at 18 cps', () => {
    // BOOK-DOC-49 §3: 5 graphemes ÷ 18 cps = 277.78 ms — the number the sequence's table prints,
    // and the reason the caret's rest ends at 498 (277.8 + 220). Linear: a rate is not a curve.
    expect(blockDurationMs('Бланк')).toBeCloseTo(277.8, 1);
    expect(graphemeCount('Бланк')).toBe(5);
  });

  it('prints a 180-character block in ten seconds worth of prose at 18 cps (clamped)', () => {
    expect(blockDurationMs('а'.repeat(180))).toBe(REVEAL.maxBlockMs);
    expect(blockDurationMs('а'.repeat(90))).toBe(2_600);
    expect(blockDurationMs('а'.repeat(45))).toBe(2_500);
  });

  it('divides by the drain speed', () => {
    expect(blockDurationMs('а'.repeat(45), REVEAL.offscreenSpeedUp)).toBeCloseTo(2_500 / 8, 5);
  });
});

describe('planReveal', () => {
  it('prints the opening of a live chapter, never more than 12 blocks', () => {
    const plan = planReveal({ blocks: blocks(30), mode: 'live', chapterAgeMs: 0 });
    expect(plan.queued).toHaveLength(REVEAL.maxQueueBlocks);
    expect(plan.queued[0]).toBe('ch08#b0');
    expect(plan.instant).toHaveLength(18);
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

describe('reveal state', () => {
  it('reveals grapheme by grapheme inside a block', () => {
    let state = createReveal([{ id: 'b1', text: 'абв' }]);
    expect(state.active).toBe(0);
    expect(blockText(state, 'b1', 'абв')).toBe('');
    state = tickReveal(state, REVEAL.minBlockMs / 2);
    expect(blockText(state, 'b1', 'абв')).toBe('а');
    state = tickReveal(state, REVEAL.minBlockMs / 2);
    expect(blockText(state, 'b1', 'абв')).toBe('абв');
    expect(revealComplete(state)).toBe(true);
  });

  it('prints blocks in order and carries leftover time into the next', () => {
    let state = createReveal([
      { id: 'b1', text: 'а' },
      { id: 'b2', text: 'б' },
    ]);
    state = tickReveal(state, REVEAL.minBlockMs);
    expect(activeBlockId(state)).toBe('b2');
    expect(blockText(state, 'b1', 'а')).toBe('а');
    expect(blockText(state, 'b2', 'б')).toBe('');
    state = tickReveal(state, REVEAL.minBlockMs);
    expect(revealComplete(state)).toBe(true);
  });

  it('drains at 8× when the reader scrolls away', () => {
    const state = createReveal([{ id: 'b1', text: 'абв' }]);
    const drained = tickReveal(state, 20, REVEAL.offscreenSpeedUp);
    expect(drained.blocks[0]?.revealed).toBeGreaterThan(0);
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

  it('finishes at once on «показать сразу» and stays complete', () => {    const state = createReveal([{ id: 'b1', text: 'абв' }, { id: 'b2', text: 'где' }]);
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

  it('lands a long title whole at its own 400 ms cap, never at its 5 000 (BOOK-DOC-49 §3)', () => {
    // A renamed title: 90 graphemes are 5 000 ms of prose at 18 cps and 2 600 even after the
    // engine's ceiling. The cover's budget is a constant of the sheet, so the word is whole at
    // 400 — 399 is not enough, and that is the whole point of the number.
    const title = 'я'.repeat(90);
    expect(blockDurationMs(title)).toBe(REVEAL.maxBlockMs);

    const capped = createReveal([{ id: 'title', text: title }], { capBlockMs: 400 });
    expect(capped.blocks[0]?.durationMs).toBe(400);
    expect(revealComplete(tickReveal(capped, 399))).toBe(false);
    expect(blockText(tickReveal(capped, 400), 'title', title)).toBe(title);

    // Without the cap the same run is still printing at 400: the option is what changed.
    const uncapped = createReveal([{ id: 'title', text: title }]);
    expect(uncapped.blocks[0]?.durationMs).toBe(REVEAL.maxBlockMs);
    expect(blockText(tickReveal(uncapped, 400), 'title', title)).not.toBe(title);
  });

  it('ignores non-positive ticks', () => {
    const state = createReveal([{ id: 'b1', text: 'абв' }]);
    expect(tickReveal(state, 0)).toBe(state);
    expect(tickReveal(state, -5)).toBe(state);
  });
});
