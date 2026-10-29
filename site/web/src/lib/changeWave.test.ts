import type { ChangeDto } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { waveCopy, waveOf } from './changeWave.ts';

const change = (fields: Partial<ChangeDto>): Pick<ChangeDto, 'cascade' | 'steps'> => ({
  cascade: fields.cascade ?? null,
  steps: fields.steps ?? [],
});

describe('the wave rule (BOOK-59)', () => {
  it('reads the wave from the cascade, or from the deepest step when there is none', () => {
    expect(waveOf(change({ cascade: { wave: 2 } as ChangeDto['cascade'] }))).toBe(2);
    expect(
      waveOf(
        change({
          steps: [
            { wave: 0 } as ChangeDto['steps'][number],
            { wave: 1 } as ChangeDto['steps'][number],
          ],
        }),
      ),
    ).toBe(1);
    expect(waveOf(change({}))).toBe(0);
  });

  it('prints a wave only when it is news: a second wave, and no denominator', () => {
    expect(waveCopy(1)).toBe('');
    expect(waveCopy(0)).toBe('');
    // The shipped bound is one wave: a second one exists only by decision, and says so.
    expect(waveCopy(2)).toBe('волна 2 · решением');
    expect(waveCopy(2, 2)).toBe('волна 2');
  });
});
