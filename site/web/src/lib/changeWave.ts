import type { ChangeDto } from '@book/shared';

import { RIBBON_MAX_WAVE } from './cascade.ts';

/**
 * The wave rule, kept from the focus view that was removed: a ripple is one wave, so «волна 1»
 * is noise and a denominator is never printed. A **second** wave exists only because the owner
 * decided to open one, and that is the only wave number a reader ever needs to see (BOOK-59).
 */
export function waveOf(change: Pick<ChangeDto, 'cascade' | 'steps'>): number {
  if (change.cascade !== null) return change.cascade.wave;
  return change.steps.reduce((max, step) => Math.max(max, step.wave), 0);
}

export function waveCopy(wave: number, maxWave: number = RIBBON_MAX_WAVE): string {
  if (wave < 2) return '';
  // A bound above one is not shipped (config refuses it), but if a frame ever announces it,
  // the number is not a decision and must not claim one.
  return maxWave <= 1 ? `волна ${wave} · решением` : `волна ${wave}`;
}
