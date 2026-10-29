import type { StageSpan } from '@book/shared';
import { describe, expect, it } from 'vitest';

import {
  MAX_PRINT_BLOCKS,
  MAX_PRINT_MS,
  PRINT_BLOCK_STAGGER_MS,
  PRINT_WINDOW_MS,
  appliedPrintPlans,
  printWindowOpen,
  type AppliedSource,
} from './appliedPrint.ts';

/**
 * BOOK-DOC-84 §4/D2 — one print path, one clock, four blocks.
 *
 * Every assertion here is a bound the design names: `appliedAt` is the clock (never a close),
 * a write older than `PRINT_WINDOW_MS` is text and not motion, at most `MAX_PRINT_BLOCKS`
 * blocks print with offsets inside `MAX_PRINT_MS`, and a truncated patch has no plan at all.
 */

const APPLIED_AT = 1_764_000_000_000;

const span = (blockId: string, before: string, after: string, truncated = false): StageSpan => ({
  blockId,
  before,
  after,
  truncated,
});

function record(overrides: Partial<AppliedSource> = {}): AppliedSource {
  return {
    n: 3,
    rev: 4,
    appliedAt: APPLIED_AT,
    patch: [{ op: 'replace', id: 'ch03#a', i: 0, newId: 'ch03#a2', text: 'Новый' }],
    patchTruncated: false,
    span: [span('ch03#a', 'Старый', 'Новый')],
    ...overrides,
  };
}

describe('the print’s clock', () => {
  it('is appliedAt — a write just now prints, and the same write six seconds later does not', () => {
    expect(printWindowOpen(record(), APPLIED_AT + PRINT_WINDOW_MS - 1)).toBe(true);
    expect(printWindowOpen(record(), APPLIED_AT + PRINT_WINDOW_MS)).toBe(false);
    expect(appliedPrintPlans(record(), { nowMs: APPLIED_AT + 100 })).toHaveLength(1);
    expect(appliedPrintPlans(record(), { nowMs: APPLIED_AT + PRINT_WINDOW_MS })).toHaveLength(0);
  });

  it('has no plan without an applied record', () => {
    expect(appliedPrintPlans(null, { nowMs: APPLIED_AT })).toEqual([]);
  });

  it('joins at the current frame when the mount is inside the window', () => {
    // A mount at 30 / 70 / 95 % of the window still plans the same write; `startAt` is the
    // record's own moment, so the renderer joins the frame instead of restarting it.
    for (const share of [0.3, 0.7, 0.95]) {
      const plans = appliedPrintPlans(record(), { nowMs: APPLIED_AT + PRINT_WINDOW_MS * share });
      expect(plans[0]?.startAt).toBe(APPLIED_AT);
    }
  });
});

describe('what is planned', () => {
  it('names the block, its final text and a pass span', () => {
    const [plan] = appliedPrintPlans(record(), { nowMs: APPLIED_AT });
    expect(plan?.blockId).toBe('ch03#a');
    expect(plan?.after).toBe('Новый');
    expect(plan?.span.kind).toBe('replacement');
    expect(plan?.key).toBe('3:4:ch03#a');
  });

  it('prints at most four blocks, in document order, with offsets inside twelve seconds', () => {
    const many = record({
      span: Array.from({ length: 8 }, (_, index) => span(`ch03#${index}`, `Старый ${index}`, `Новый ${index}`)),
    });
    const plans = appliedPrintPlans(many, { nowMs: APPLIED_AT });
    expect(plans).toHaveLength(MAX_PRINT_BLOCKS);
    expect(plans.map((plan) => plan.blockId)).toEqual(['ch03#0', 'ch03#1', 'ch03#2', 'ch03#3']);
    expect(plans[0]?.startAt).toBe(APPLIED_AT);
    expect(plans[1]?.startAt).toBe(APPLIED_AT + PRINT_BLOCK_STAGGER_MS);
    const last = (plans.at(-1)?.startAt ?? 0) - APPLIED_AT;
    expect(last).toBeLessThanOrEqual(MAX_PRINT_MS);
  });

  it('leaves off-screen blocks set: only the visible ones are planned', () => {
    const two = record({
      span: [span('ch03#a', 'Старый', 'Новый'), span('ch03#b', 'Было', 'Стало')],
    });
    const plans = appliedPrintPlans(two, { nowMs: APPLIED_AT, visible: (blockId) => blockId === 'ch03#b' });
    expect(plans.map((plan) => plan.blockId)).toEqual(['ch03#b']);
    // The single planned block starts at the record's own moment: offsets follow the plan's
    // own order, never the span's skipped entries.
    expect(plans[0]?.startAt).toBe(APPLIED_AT);
  });

  it('has no plan for a truncated patch, no pre-image, or a truncated span entry', () => {
    expect(appliedPrintPlans(record({ patchTruncated: true }), { nowMs: APPLIED_AT })).toEqual([]);
    expect(appliedPrintPlans(record({ span: null }), { nowMs: APPLIED_AT })).toEqual([]);
    expect(
      appliedPrintPlans(record({ span: [span('ch03#a', 'Старый', 'Новый', true)] }), { nowMs: APPLIED_AT }),
    ).toEqual([]);
  });

  it('skips an entry that names no change', () => {
    expect(
      appliedPrintPlans(record({ span: [span('ch03#a', 'Тот же', 'Тот же')] }), { nowMs: APPLIED_AT }),
    ).toEqual([]);
  });
});
