/**
 * The owner's correction (2026-10-28) on the real file: **a status word is not a title**.
 *
 * `manuscript/ch01.md` opens with its heading «Замечаний нет» and the frozen first sentence is
 * its first prose block. The heading must be read as the chapter's title — that is what the
 * contents and the chapter header print — while the frame stays prose, the character count
 * still belongs to the prose (never to the title line), and F007's floor / F022's missing
 * title cannot fire on it.
 *
 * The basis-slot rule the heading now sits on top of is proved on the same bytes in
 * `parseChapter.test.ts` and `shared/test/book.test.ts`: a slot emptied down to its frozen
 * sentence under this heading stays a basis slot with `chars = 0`.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { CHAPTER_CHARS, FRAME_FIRST_SENTENCE, isEmptySlot } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { parseChapter } from '../src/ingest/parseChapter.ts';

const SITE = resolve(import.meta.dirname, '..', '..');
const CHAPTER_ONE = join(SITE, '..', 'manuscript', 'ch01.md');

const HEADING = 'Замечаний нет';

const raw = readFileSync(CHAPTER_ONE, 'utf8');

describe('manuscript/ch01.md on disk (owner, 2026-10-28)', () => {
  it('opens with the heading on line 1 and a blank line 2', () => {
    const [first, second] = raw.split('\n');
    expect(first).toBe(HEADING);
    expect(second).toBe('');
  });

  it('is read as a titled chapter whose first prose block is still the frozen sentence', () => {
    const parsed = parseChapter(1, raw);
    expect(parsed.title).toBe(HEADING);
    expect(parsed.titleProblems).toEqual([]);
    // The frame is prose, not the title: the reader prints it as the chapter's first paragraph.
    expect(parsed.blocks[0]?.text).toBe(FRAME_FIRST_SENTENCE);
    // The heading is not prose: the count belongs to the chapter's own text.
    expect(parsed.chars).toBeGreaterThan(CHAPTER_CHARS.floor);
    expect(parsed.basis).toBe(false);
  });

  it('cannot trip F007 for length or F022 for a missing title', () => {
    const parsed = parseChapter(1, raw);
    expect(parsed.title).not.toBeNull();
    expect(parsed.chars).toBeGreaterThanOrEqual(CHAPTER_CHARS.floor);
    expect(parsed.chars).toBeLessThanOrEqual(CHAPTER_CHARS.max);
    // And the shared emptiness rule does not call a written chapter an empty slot.
    expect(isEmptySlot(1, raw)).toBe(false);
  });

  it('stays a basis slot when it is emptied down to the frame under the same heading', () => {
    const emptied = parseChapter(1, `${HEADING}\n\n${FRAME_FIRST_SENTENCE}\n`);
    expect(emptied.title).toBe(HEADING);
    expect(emptied.basis).toBe(true);
    expect(emptied.chars).toBe(0);
    expect(emptied.blocks.map((block) => block.text)).toEqual([FRAME_FIRST_SENTENCE]);
  });
});
