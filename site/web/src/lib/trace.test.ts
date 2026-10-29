import type { MyTraceDto } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { revisionsWord, traceLine } from './trace.ts';

/** The reader's own trace sentence, moved out of the end matter (BOOK-207). */
function trace(overrides: Partial<MyTraceDto> = {}): MyTraceDto {
  return {
    label: 'Аня',
    edits: 3,
    chars: 4_000,
    share: 0.004,
    series: [],
    hidden: false,
    isAuthor: false,
    survivedRevisions: 4,
    ...overrides,
  };
}

describe('the reader’s own trace line', () => {
  it('prints the measured share with a Russian decimal comma', () => {
    expect(traceLine(trace())).toBe('пережила 4 ревизии, сейчас 0,4 %');
    expect(traceLine(trace())).not.toContain('0.4');
  });

  it('counts the revisions it actually survived in Russian', () => {
    expect(revisionsWord(0)).toBe('ревизий');
    expect(revisionsWord(1)).toBe('ревизию');
    expect(revisionsWord(2)).toBe('ревизии');
    expect(revisionsWord(11)).toBe('ревизий');
    expect(revisionsWord(21)).toBe('ревизию');
    expect(traceLine(trace({ survivedRevisions: 1, share: 0.1234 }))).toBe(
      'пережила 1 ревизию, сейчас 12,3 %',
    );
  });
});
