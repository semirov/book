/**
 * The applier (BOOK-173 §2): every refusal code, the subsequence invariant, the 15 % boundary
 * and purity.
 *
 * The applier is the one place where a patch is *proved*: a block that exists, a quote that
 * occurs exactly once inside it, and a post-image whose untouched blocks keep their bytes,
 * order and multiplicity. Each test below breaks exactly one of those and expects the code that
 * names it — a refusal is a parked pass, a wrong edit is a lost chapter.
 */

import { readFileSync } from 'node:fs';

import { CHAPTER_CHARS, FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE, TOTAL_CHAPTERS } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { parseChapter, type ParsedBlock } from '../../../src/ingest/parseChapter.ts';
import { applyPatch, PATCH_MAX_FRACTION } from '../../../src/writer/patch/apply.ts';
import type { PatchAnswer, PatchEdit } from '../../../src/writer/patch/protocol.ts';

const TITLE = 'Глава двенадцатая';

/** One paragraph with a unique opening, padded to `chars` with inert prose. */
function para(marker: string, chars = 600): string {
  const head = `Абзац ${marker}. `;
  const filler = 'Служебный текст для проверки объёма страницы, он не является текстом книги. ';
  return `${head}${filler.repeat(Math.ceil(chars / filler.length) + 1)}`.slice(0, chars);
}

function chapterText(blocks: string[], title: string | null = TITLE): string {
  return title === null ? `${blocks.join('\n\n')}\n` : `${title}\n\n${blocks.join('\n\n')}\n`;
}

function blocksOf(n: number, text: string): ParsedBlock[] {
  return parseChapter(n, text).blocks;
}

function patch(edits: PatchEdit[]): PatchAnswer {
  return { mode: 'patch', edits, facts: [], note: null };
}

/** A four-paragraph chapter with a unique sentence per paragraph, and its parsed blocks. */
function sample(n = 12): { text: string; blocks: ParsedBlock[] } {
  const text = chapterText([para('один'), para('два'), para('три'), para('четыре')]);
  return { text, blocks: blocksOf(n, text) };
}

function codeOf(result: ReturnType<typeof applyPatch>): string {
  return result.ok ? 'OK' : result.code;
}

describe('applyPatch — the happy path', () => {
  it('replaces a proven span and leaves every other block byte for byte', () => {
    const { text, blocks } = sample();
    const target = blocks[1];
    if (target === undefined) throw new Error('the sample has no second block');
    const oldText = 'Абзац два.';
    const result = applyPatch({
      chapter: 12,
      text,
      patch: patch([{ blockId: target.id, oldText, newText: 'Абзац второй.' }]),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const after = blocksOf(12, result.text);
    expect(after).toHaveLength(4);
    expect(parseChapter(12, result.text).title).toBe(TITLE);
    expect(after[1]?.text.startsWith('Абзац второй.')).toBe(true);
    // Untouched blocks keep their bytes, their ids and their order.
    for (const index of [0, 2, 3]) {
      expect(after[index]?.hash).toBe(blocks[index]?.hash);
      expect(after[index]?.text).toBe(blocks[index]?.text);
    }
    expect(result.changedChars).toBe('Абзац второй.'.length);
    expect(result.fraction).toBeCloseTo(result.changedChars / parseChapter(12, text).chars, 12);
    expect(result.edits).toHaveLength(1);
  });

  it('inserts after a block and deletes a block, accounting for the count', () => {
    // A short paragraph is deletable inside the 15 % budget; the long ones are not.
    const text = chapterText([para('один'), 'Короткий абзац, который можно убрать.', para('три'), para('четыре')]);
    const blocks = blocksOf(12, text);
    const [first, second, , fourth] = blocks;
    if (first === undefined || second === undefined || fourth === undefined) throw new Error('bad sample');

    const inserted = applyPatch({
      chapter: 12,
      text,
      patch: patch([{ blockId: null, afterBlockId: first.id, oldText: '', newText: 'Новый абзац.' }]),
    });
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;
    const afterInsert = blocksOf(12, inserted.text);
    expect(afterInsert).toHaveLength(5);
    expect(afterInsert[1]?.text).toBe('Новый абзац.');
    expect(afterInsert[4]?.hash).toBe(fourth.hash);

    const deleted = applyPatch({
      chapter: 12,
      text,
      patch: patch([{ blockId: second.id, oldText: second.text, newText: '' }]),
    });
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    const afterDelete = blocksOf(12, deleted.text);
    expect(afterDelete).toHaveLength(3);
    expect(afterDelete.map((block) => block.hash)).toEqual([first.hash, blocks[2]?.hash, fourth.hash]);
  });
});

describe('applyPatch — where the proof fails, the code says why', () => {
  it('PATCH_UNKNOWN_BLOCK for a foreign or stale id, on an edit and on an insert', () => {
    const { text, blocks } = sample();
    const [first] = blocks;
    if (first === undefined) throw new Error('bad sample');
    expect(codeOf(applyPatch({ chapter: 12, text, patch: patch([{ blockId: 'ch03#deadbeef', oldText: 'а', newText: 'б' }]) }))).toBe(
      'PATCH_UNKNOWN_BLOCK',
    );
    expect(
      codeOf(applyPatch({ chapter: 12, text, patch: patch([{ blockId: null, afterBlockId: 'ch12#00000000', oldText: '', newText: 'x' }]) })),
    ).toBe('PATCH_UNKNOWN_BLOCK');
  });

  it('PATCH_OLD_TEXT_NOT_FOUND when the quote is not in the named block', () => {
    const { text, blocks } = sample();
    const first = blocks[0];
    if (first === undefined) throw new Error('bad sample');
    // «Абзац два.» lives in block 1: quoting it against block 0 is a span across blocks.
    expect(codeOf(applyPatch({ chapter: 12, text, patch: patch([{ blockId: first.id, oldText: 'Абзац два.', newText: 'x' }]) }))).toBe(
      'PATCH_OLD_TEXT_NOT_FOUND',
    );
  });

  it('PATCH_OLD_TEXT_AMBIGUOUS when the quote occurs twice in the block', () => {
    const repeated = para('пять', 700);
    const text = chapterText([para('один'), repeated, repeated, para('четыре')]);
    const block = blocksOf(12, text)[1];
    if (block === undefined) throw new Error('bad sample');
    // The same words appear twice in one paragraph (the filler line is repeated).
    expect(codeOf(applyPatch({ chapter: 12, text, patch: patch([{ blockId: block.id, oldText: 'Служебный текст', newText: 'x' }]) }))).toBe(
      'PATCH_OLD_TEXT_AMBIGUOUS',
    );
  });

  it('PATCH_OLD_TEXT_EMPTY when an existing block is named with no pre-image', () => {
    const { text, blocks } = sample();
    const block = blocks[0];
    if (block === undefined) throw new Error('bad sample');
    expect(codeOf(applyPatch({ chapter: 12, text, patch: patch([{ blockId: block.id, oldText: '', newText: 'x' }]) }))).toBe(
      'PATCH_OLD_TEXT_EMPTY',
    );
  });

  it('PATCH_OVERLAP for two edits on one block and for two insertions after one block', () => {
    const { text, blocks } = sample();
    const block = blocks[1];
    const first = blocks[0];
    if (block === undefined || first === undefined) throw new Error('bad sample');
    expect(
      codeOf(
        applyPatch({
          chapter: 12,
          text,
          patch: patch([
            { blockId: block.id, oldText: 'Абзац два.', newText: 'А.' },
            { blockId: block.id, oldText: 'Служебный', newText: 'Б.' },
          ]),
        }),
      ),
    ).toBe('PATCH_OVERLAP');
    expect(
      codeOf(
        applyPatch({
          chapter: 12,
          text,
          patch: patch([
            { blockId: null, afterBlockId: first.id, oldText: '', newText: 'Новый.' },
            { blockId: null, afterBlockId: first.id, oldText: '', newText: 'Ещё один.' },
          ]),
        }),
      ),
    ).toBe('PATCH_OVERLAP');
  });

  it('PATCH_FRAME_TOUCHED on ch01’s opening sentence and on the finale’s last', () => {
    const opening = chapterText([`${FRAME_FIRST_SENTENCE} Я постоял и вышел.`, para('два'), para('три'), para('четыре')], null);
    const firstBlock = blocksOf(1, opening)[0];
    if (firstBlock === undefined) throw new Error('bad sample');
    const touchedFirst = applyPatch({
      chapter: 1,
      text: opening,
      patch: patch([{ blockId: firstBlock.id, oldText: 'яркий свет', newText: 'тусклый свет' }]),
    });
    expect(codeOf(touchedFirst)).toBe('PATCH_FRAME_TOUCHED');
    // ...and the same block is fine to edit *after* the sentence.
    expect(
      codeOf(
        applyPatch({
          chapter: 1,
          text: opening,
          patch: patch([{ blockId: firstBlock.id, oldText: 'Я постоял и вышел.', newText: 'Я постоял и ушёл.' }]),
        }),
      ),
    ).toBe('OK');

    const closing = chapterText([para('один'), para('два'), para('три'), `Досюда дошли. ${FRAME_LAST_SENTENCE}`]);
    const lastBlock = blocksOf(TOTAL_CHAPTERS, closing).at(-1);
    if (lastBlock === undefined) throw new Error('bad sample');
    expect(
      codeOf(
        applyPatch({
          chapter: TOTAL_CHAPTERS,
          text: closing,
          patch: patch([{ blockId: lastBlock.id, oldText: 'не осталось глаз', newText: 'не осталось окон' }]),
        }),
      ),
    ).toBe('PATCH_FRAME_TOUCHED');
  });

  it('PATCH_BUDGET_EXCEEDED above 15 %, and exactly 15 % is allowed', () => {
    const { text, blocks } = sample();
    const block = blocks[1];
    if (block === undefined) throw new Error('bad sample');
    const chars = parseChapter(12, text).chars;
    const allowed = Math.floor(PATCH_MAX_FRACTION * chars);

    const atBound = block.text.slice(0, allowed);
    expect(codeOf(applyPatch({ chapter: 12, text, patch: patch([{ blockId: block.id, oldText: atBound, newText: 'Абзац два.' }]) }))).toBe(
      'OK',
    );
    const over = block.text.slice(0, allowed + 1);
    expect(codeOf(applyPatch({ chapter: 12, text, patch: patch([{ blockId: block.id, oldText: over, newText: 'Абзац два.' }]) }))).toBe(
      'PATCH_BUDGET_EXCEEDED',
    );
  });

  it('PATCH_LENGTH when the edit pushes the chapter past the band', () => {
    const big = [para('один', 7_475), para('два', 7_475), para('три', 7_475), para('четыре', 7_475)];
    const text = chapterText(big);
    const chars = parseChapter(12, text).chars;
    expect(chars).toBeGreaterThan(CHAPTER_CHARS.max - 600);
    const block = blocksOf(12, text)[1];
    if (block === undefined) throw new Error('bad sample');
    const result = applyPatch({
      chapter: 12,
      text,
      patch: patch([{ blockId: block.id, oldText: 'Абзац два.', newText: `Абзац два. ${'х'.repeat(600)}` }]),
    });
    expect(codeOf(result)).toBe('PATCH_LENGTH');
  });

  it('PATCH_PARAGRAPH_FLOOR when a delete leaves fewer than three paragraphs', () => {
    const text = chapterText([para('один', 7_800), para('два', 7_800), 'Короткий абзац.', 'Ещё короткий.']);
    const blocks = blocksOf(12, text);
    const third = blocks[2];
    const fourth = blocks[3];
    if (third === undefined || fourth === undefined) throw new Error('bad sample');
    expect(
      codeOf(
        applyPatch({
          chapter: 12,
          text,
          patch: patch([
            { blockId: third.id, oldText: third.text, newText: '' },
            { blockId: fourth.id, oldText: fourth.text, newText: '' },
          ]),
        }),
      ),
    ).toBe('PATCH_PARAGRAPH_FLOOR');
  });

  it('PATCH_INVARIANT when a hand-built edit smuggles a block boundary in', () => {
    const { text, blocks } = sample();
    const block = blocks[1];
    if (block === undefined) throw new Error('bad sample');
    // `parsePatchAnswer` refuses this shape; the applier is the pure core and must not assume
    // the parser ran — a split block breaks the count the patch claims.
    expect(codeOf(applyPatch({ chapter: 12, text, patch: patch([{ blockId: block.id, oldText: 'Абзац два.', newText: 'Один.\n\nДва.' }]) }))).toBe(
      'PATCH_INVARIANT',
    );
  });

  it('PATCH_EMPTY when every edit is a no-op, and PATCH_FRAME_TOUCHED on a basis slot', () => {
    const { text, blocks } = sample();
    const block = blocks[1];
    if (block === undefined) throw new Error('bad sample');
    expect(codeOf(applyPatch({ chapter: 12, text, patch: patch([{ blockId: block.id, oldText: 'Абзац два.', newText: 'Абзац два.' }]) }))).toBe(
      'PATCH_EMPTY',
    );
    expect(codeOf(applyPatch({ chapter: 1, text: FRAME_FIRST_SENTENCE, patch: patch([{ blockId: 'x', oldText: 'а', newText: 'б' }]) }))).toBe(
      'PATCH_FRAME_TOUCHED',
    );
  });
});

describe('applyPatch — pure, deterministic and by construction title-safe', () => {
  it('gives the same bytes twice and never mutates its input', () => {
    const { text, blocks } = sample();
    const block = blocks[1];
    if (block === undefined) throw new Error('bad sample');
    const input = patch([{ blockId: block.id, oldText: 'Абзац два.', newText: 'Абзац второй.' }]);
    Object.freeze(input);
    Object.freeze(input.edits);
    Object.freeze(input.edits[0]);
    const one = applyPatch({ chapter: 12, text, patch: input });
    const two = applyPatch({ chapter: 12, text, patch: input });
    expect(one).toEqual(two);
    expect(input.edits[0]?.newText).toBe('Абзац второй.');
  });

  it('has no fs, db, clock or env in its own source', () => {
    const source = readFileSync(new URL('../../../src/writer/patch/apply.ts', import.meta.url), 'utf8');
    for (const forbidden of ['node:fs', 'readFileSync', 'Date.now', 'process.env', 'performance.now', 'Math.random']) {
      expect(source).not.toContain(forbidden);
    }
  });

  it('keeps the title line byte for byte, so PATCH_TITLE cannot fire by construction', () => {
    const { text, blocks } = sample();
    const first = blocks[0];
    if (first === undefined) throw new Error('bad sample');
    const result = applyPatch({ chapter: 12, text, patch: patch([{ blockId: first.id, oldText: 'Абзац один.', newText: 'Начало.' }]) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text.split('\n')[0]).toBe(TITLE);
  });
});
