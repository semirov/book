/**
 * A status word is not a title (owner, 2026-10-28).
 *
 * A chapter may open on a heading above the frozen first sentence. The heading is the
 * chapter's **title** — what the contents and the chapter header print — while the frame stays
 * the first prose block: a heading is not prose, so it adds no characters to the count.
 *
 * This is a fixture, not the owner's file: since BOOK-187 the rows are the home of the text
 * (ADR-043 / BOOK-DOC-76) and `manuscript/` is not read at runtime. The real book's heading is
 * checked on deploy by `node bin/validate.mjs --from-db "$DATA_DIR"`, which runs the same
 * parser rules (F007 for length, F022 for a missing title) over `chapters.title` and the blocks
 * the chapter is stored as.
 *
 * The basis-slot rule the heading sits on top of is proved on the same path in
 * `basisHeading.test.ts`: a slot emptied down to its frozen sentence under this heading stays a
 * basis slot with `chars = 0`.
 */

import { CHAPTER_CHARS, FRAME_FIRST_SENTENCE, isEmptySlot } from '@book/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { getChapterRow, listBlocks } from '../src/db/repo/chapters.ts';
import { applyChapterFile } from '../src/ingest/applyChapter.ts';
import { parseChapter } from '../src/ingest/parseChapter.ts';
import { createFixture, type Fixture } from './helpers.ts';

const HEADING = 'Замечаний нет';
const NOW = Date.parse('2026-10-28T09:00:00Z');

/** Neutral filler: a fixture never carries the book's prose (`helpers.ts` says the same). */
const FILLER =
  'Служебный абзац для проверки главы: это предложение не является текстом книги и повторяется, чтобы набрать длину.';
const FILLER_BLOCK = Array.from({ length: 3 }, () => FILLER).join(' ');
/** The frame is a block of its own, so the heading can be proved not to be the first one. */
const BLOCKS = [FRAME_FIRST_SENTENCE, ...Array.from({ length: 8 }, () => FILLER_BLOCK)];
const BODY = BLOCKS.join('\n\n');
/** What the parser counts: the blocks' own characters, not the blank lines between them. */
const CHARS = BLOCKS.reduce((sum, block) => sum + block.length, 0);
const RAW = `${HEADING}\n\n${BODY}\n`;

let fixture: Fixture | null = null;

afterEach(() => {
  fixture?.close();
  fixture = null;
});

describe('a chapter heading above the frozen first sentence', () => {
  it('is read as the title, with the frame as the first block and no character of its own', () => {
    const parsed = parseChapter(1, RAW);
    expect(parsed.title).toBe(HEADING);
    expect(parsed.titleProblems).toEqual([]);
    // The frame is prose, not the title: the reader prints it as the chapter's first paragraph.
    expect(parsed.blocks[0]?.text).toBe(FRAME_FIRST_SENTENCE);
    expect(parsed.blocks).toHaveLength(BLOCKS.length);
    // The heading is not prose: the count belongs to the chapter's own text, block for block.
    expect(parsed.chars).toBe(CHARS);
    expect(parsed.basis).toBe(false);
  });

  it('is stored in chapters.title by the projector, and the heading never becomes a block', () => {
    const active = (fixture = createFixture());
    const applied = applyChapterFile({
      db: active.db,
      dataDir: active.dataDir,
      n: 1,
      raw: RAW,
      mtimeMs: NOW,
      nowMs: NOW,
    });

    expect(applied.status).toBe('created');
    const row = getChapterRow(active.db, 1);
    expect(row).toMatchObject({ title: HEADING, basis: 0, block_count: BLOCKS.length });
    // The projection keeps the parser's count: the title line is not part of it.
    expect(row?.chars).toBe(CHARS);
    const stored = listBlocks(active.db, 1).map((block) => block.text);
    expect(stored[0]).toBe(FRAME_FIRST_SENTENCE);
    expect(stored.join('\n\n')).not.toContain(HEADING);
  });

  it('cannot trip F007 for length or F022 for a missing title', () => {
    const parsed = parseChapter(1, RAW);
    expect(parsed.title).not.toBeNull();
    expect(parsed.chars).toBeGreaterThanOrEqual(CHAPTER_CHARS.floor);
    expect(parsed.chars).toBeLessThanOrEqual(CHAPTER_CHARS.max);
    // And the shared emptiness rule does not call a written chapter an empty slot.
    expect(isEmptySlot(1, RAW)).toBe(false);
  });
});
