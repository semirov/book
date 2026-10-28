/**
 * The span of a landing (`docs/writer-lane.md` §2): what the pass replaced, bounded and truthful.
 *
 * Blocks are aligned by index and identified with the chapter's own ids, so the reader's page can
 * look a span up in the chapter it already has. A first pass has nothing to align: one span, no
 * block, nothing replaced.
 */

import { STAGE_SPAN_MAX_CHARS } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { MAX_SPANS, changedSpans } from '../../src/writer/span.ts';
import { parseChapter } from '../../src/ingest/parseChapter.ts';

const CHAPTER = 12;

function chapter(blocks: string[], title = 'Глава двенадцать'): string {
  return `${title}\n\n${blocks.join('\n\n')}\n`;
}

describe('changedSpans', () => {
  it('creates one span from an empty slot: no block, nothing replaced', () => {
    const after = chapter(['Первый абзац главы.', 'Второй абзац главы.']);
    const spans = changedSpans('', after, CHAPTER);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ blockId: null, before: '' });
    expect(spans[0]?.after.startsWith('Первый абзац главы.')).toBe(true);
    expect(spans[0]?.truncated).toBe(false);
  });

  it('reports nothing when the text did not change, whitespace included', () => {
    const text = chapter(['Первый абзац главы.', 'Второй абзац главы.']);
    expect(changedSpans(text, text, CHAPTER)).toEqual([]);
    expect(changedSpans(text, `${text.replace('Второй абзац', 'Второй  абзац')}`, CHAPTER)).toEqual([]);
  });

  it('names the block it replaced, with the chapter’s own ids', () => {
    const before = chapter(['Первый абзац главы.', 'Второй абзац главы.', 'Третий абзац главы.']);
    const after = chapter(['Первый абзац главы.', 'Второй абзац переписан.', 'Третий абзац главы.']);
    const spans = changedSpans(before, after, CHAPTER);
    expect(spans).toHaveLength(1);
    const block = parseChapter(CHAPTER, before).blocks[1];
    expect(spans[0]?.blockId).toBe(block?.id);
    expect(spans[0]?.blockId).toMatch(/^ch12#[0-9a-f]{8}$/u);
    expect(spans[0]).toMatchObject({ before: 'Второй абзац главы.', after: 'Второй абзац переписан.', truncated: false });
  });

  it('reports a removed block as a span with an empty replacement', () => {
    const before = chapter(['Первый абзац.', 'Второй абзац.', 'Третий абзац.']);
    const after = chapter(['Первый абзац.', 'Третий абзац.']);
    const spans = changedSpans(before, after, CHAPTER);
    expect(spans).toHaveLength(2);
    expect(spans[0]?.before).toBe('Второй абзац.');
    expect(spans[1]?.after).toBe('');
  });

  it('cuts each side at the bound and says so', () => {
    const long = 'а'.repeat(STAGE_SPAN_MAX_CHARS + 500);
    const spans = changedSpans(chapter(['Короткий абзац.']), chapter([long]), CHAPTER);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.after.length).toBe(STAGE_SPAN_MAX_CHARS);
    expect(spans[0]?.truncated).toBe(true);
  });

  it('stops at eight spans: past that the reader reads the chapter', () => {
    const before = chapter(Array.from({ length: 10 }, (_, index) => `Абзац ${String(index)}.`));
    const after = chapter(Array.from({ length: 10 }, (_, index) => `Абзац ${String(index)} изменён.`));
    expect(changedSpans(before, after, CHAPTER)).toHaveLength(MAX_SPANS);
    expect(MAX_SPANS).toBe(8);
  });

  it('returns nothing for two empty texts', () => {
    expect(changedSpans('', '', CHAPTER)).toEqual([]);
  });
});
