import { describe, expect, it } from 'vitest';

import { commentFrameChapter } from './commentFrames.ts';

describe('which chapter a comment frame changes (BOOK-33)', () => {
  it('reads the chapter off both frames', () => {
    expect(commentFrameChapter({ id: 'cmt_1', chapter: 8, status: 'rejected' })).toBe(8);
    expect(commentFrameChapter({ id: 'cmt_1', chapter: 42, anchor: {} })).toBe(42);
  });

  it('answers null for a frame without a chapter, or for garbage', () => {
    expect(commentFrameChapter({ id: 'cmt_1' })).toBeNull();
    expect(commentFrameChapter({ chapter: 'eight' })).toBeNull();
    expect(commentFrameChapter({ chapter: 0 })).toBeNull();
    expect(commentFrameChapter(null)).toBeNull();
  });
});
