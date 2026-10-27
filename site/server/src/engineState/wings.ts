/**
 * A ripple's two wings as public data (ARCHITECTURE.md §11.7, BOOK-DOC-4).
 *
 * The consequence spreads in both directions at once — rings toward chapter 1 and toward
 * chapter 67 — and the reader may follow either wing. That shape is a **fact of the recorded
 * steps**, so it is derived here once and carried by the snapshot, the progress frame and the
 * change DTO. Nothing in this module invents motion: a wing that never opened reports
 * `waiting` with no reached chapters, and the ribbon therefore draws no rings for it.
 *
 * No field here can carry a gate verdict or a finding: the input is a step row, the output
 * is a direction, a wave, a state word and a list of chapter numbers.
 */

import type { CascadeStatus, CascadeWingDto, CascadeWingsDto } from '@book/shared';
import { parseSeams } from '@book/shared';

import { safeJson } from './rows.ts';

/** The part of a step the wing geometry reads. */
export type WingStep = {
  pass: string;
  lane: 'forward' | 'backward' | null;
  chapter: number | null;
  wave: number;
  outcome: string | null;
  seamsOut: ReadonlyArray<unknown>;
};

/** A step row (`steps`) as the wing geometry reads it: direction, wave, chapter, seams. */
export function wingSteps(rows: ReadonlyArray<{
  pass: string;
  lane: 'forward' | 'backward' | null;
  chapter: number | null;
  wave: number;
  outcome: string | null;
  seams_out: string | null;
}>): WingStep[] {
  return rows.map((row) => ({
    pass: row.pass,
    lane: row.lane,
    chapter: row.chapter,
    wave: row.wave,
    outcome: row.outcome,
    seamsOut: parseSeams(safeJson(row.seams_out)),
  }));
}

const DIRECTION_LANE = { down: 'backward', up: 'forward' } as const;

function wingOf(
  steps: readonly WingStep[],
  origin: number,
  direction: 'down' | 'up',
  status: CascadeStatus,
): CascadeWingDto {
  const lane = DIRECTION_LANE[direction];
  const own = steps.filter((step) => step.pass === 'cascade' && step.lane === lane && step.chapter !== null);
  if (own.length === 0) return { frontier: origin, wave: 0, state: 'waiting', reached: [] };

  const chapters = own.map((step) => step.chapter as number);
  const frontier = direction === 'down' ? Math.min(...chapters) : Math.max(...chapters);
  const wave = own.reduce((max, step) => Math.max(max, step.wave), 0);
  const reached = [...new Set(chapters)].sort((left, right) => (direction === 'down' ? right - left : left - right));
  return { frontier, wave, state: stateOf(own[own.length - 1] as WingStep, status), reached };
}

/** The wing's state, from its last step: no last step means the wing never opened (`waiting`). */
function stateOf(last: WingStep, status: CascadeStatus): CascadeWingDto['state'] {
  if (last.outcome === null) return 'moving';
  if (last.outcome === 'escalated' || last.outcome === 'interrupted') return 'stopped';
  if (last.outcome === 'holds' || last.outcome === 'evaluated') return 'settled';
  if (last.seamsOut.length === 0) return 'settled';
  // A wing whose last step still reports an outward seam is moving — unless the cascade was
  // stopped, in which case the seam is exactly why it stopped and the wing is honest about it.
  return status === 'open' ? 'moving' : status === 'escalated' ? 'stopped' : 'settled';
}

/** Both wings of one cascade, from the steps it recorded and the chapter it started in. */
export function wingsOf(steps: readonly WingStep[], origin: number, status: CascadeStatus): CascadeWingsDto {
  return { down: wingOf(steps, origin, 'down', status), up: wingOf(steps, origin, 'up', status) };
}
