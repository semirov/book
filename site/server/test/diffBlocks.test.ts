import { describe, expect, it } from 'vitest';

import { diffBlocks } from '../src/ingest/diffBlocks.ts';

describe('diffBlocks', () => {
  it('reports nothing for identical sequences', () => {
    expect(diffBlocks(['a', 'b', 'c'], ['a', 'b', 'c'])).toEqual({ added: 0, changed: 0, removed: 0 });
  });

  it('counts an insertion in the middle', () => {
    expect(diffBlocks(['a', 'c'], ['a', 'b', 'c'])).toEqual({ added: 1, changed: 0, removed: 0 });
  });

  it('counts a removal in the middle', () => {
    expect(diffBlocks(['a', 'b', 'c'], ['a', 'c'])).toEqual({ added: 0, changed: 0, removed: 1 });
  });

  it('coalesces a removal and an insertion into one change', () => {
    expect(diffBlocks(['a', 'old', 'c'], ['a', 'new', 'c'])).toEqual({ added: 0, changed: 1, removed: 0 });
  });

  it('handles an empty baseline', () => {
    expect(diffBlocks([], ['a', 'b'])).toEqual({ added: 2, changed: 0, removed: 0 });
  });

  it('counts a swap as one removal and one insertion', () => {
    expect(diffBlocks(['a', 'b'], ['b', 'a'])).toEqual({ added: 1, changed: 0, removed: 1 });
  });

  it('works at chapter scale', () => {
    const before = Array.from({ length: 141 }, (_, index) => `h${index}`);
    const after = [...before];
    after[70] = 'replaced';
    expect(diffBlocks(before, after)).toEqual({ added: 0, changed: 1, removed: 0 });
  });
});
