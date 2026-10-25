/**
 * Small shared readers used by the lane, the service and the delta check.
 *
 * `measureDelta` is the only quantitative judgement the engine makes about prose, and it is
 * about *size*, not quality: how much of the chapter a cascade step replaced (§6A.6,
 * MAX_DELTA_RATIO). It compares block hashes captured at `start` with the landed text, so a
 * same-length replacement is visible where a character delta would show zero.
 */

import type { Db } from '../db/db.ts';
import * as store from './store.ts';

export type PreBlock = { hash: string; chars: number };

export function safeJson<T = unknown>(raw: string | null): T | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function preBlocksOf(step: store.StepRow): PreBlock[] {
  return safeJson<PreBlock[]>(step.pre_blocks) ?? [];
}

export function boundaryFor(chapter: number): string {
  return chapter === 1 ? 'front' : String(chapter);
}

export function blockHashes(blocks: Array<{ hash: string }>): string[] {
  return blocks.map((block) => block.hash);
}

export function sameSequence(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function processingChange(db: Db): store.ChangeRow | undefined {
  return db.prepare(`SELECT * FROM changes WHERE status = 'processing' ORDER BY seq LIMIT 1`).get() as
    | store.ChangeRow
    | undefined;
}

/**
 * A step's change: the cascade's change when it belongs to a ripple, else the change named by
 * its (latest) lease. A draft, a front rewrite and an ending evaluation have no change.
 */
export function changeForStep(db: Db, step: store.StepRow): store.ChangeRow | undefined {
  if (step.cascade_id) {
    const cascade = store.getCascade(db, step.cascade_id);
    if (cascade) return store.getChange(db, cascade.change_id);
  }
  const lease = db
    .prepare('SELECT change_id FROM leases WHERE step_id = ? ORDER BY acquired_at DESC LIMIT 1')
    .get(step.step_id) as { change_id: string | null } | undefined;
  return lease?.change_id ? store.getChange(db, lease.change_id) : undefined;
}

export function measureDelta(
  step: store.StepRow,
  blocks: Array<{ hash: string; text: string }>,
): { touched: number; delta: number; ratio: number } {
  const before = preBlocksOf(step);
  if (before.length === 0) {
    return {
      touched: blocks.length,
      delta: blocks.reduce((sum, block) => sum + block.text.length, 0),
      ratio: 0,
    };
  }
  const oldHashes = new Set(before.map((block) => block.hash));
  const newHashes = new Set(blocks.map((block) => block.hash));
  let removed = 0;
  for (const block of before) if (!newHashes.has(block.hash)) removed += block.chars;
  let added = 0;
  let touched = 0;
  let after = 0;
  for (const block of blocks) {
    after += block.text.length;
    if (!oldHashes.has(block.hash)) {
      added += block.text.length;
      touched += 1;
    }
  }
  const beforeChars = before.reduce((sum, block) => sum + block.chars, 0);
  return {
    touched,
    delta: after - beforeChars,
    ratio: after === 0 ? 1 : Math.round(((removed + added) / after) * 1000) / 1000,
  };
}
