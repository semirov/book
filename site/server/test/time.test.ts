import { toIso } from '../src/util/time.ts';
import { describe, expect, it } from 'vitest';

describe('toIso', () => {
  it('drops milliseconds and keeps UTC', () => {
    expect(toIso(new Date('2026-10-25T12:04:11.987Z'))).toBe('2026-10-25T12:04:11Z');
  });

  it('accepts a timestamp in milliseconds', () => {
    expect(toIso(Date.parse('2026-10-25T12:04:11.500Z'))).toBe('2026-10-25T12:04:11Z');
  });
});
