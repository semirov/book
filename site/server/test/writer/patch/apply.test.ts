/**
 * The writer's pure applier (BOOK-173 §2, BOOK-176): every refusal code, the invariants, the
 * 15 % boundary and purity.
 *
 * On `main` the one write path is the ledger applier, so this file no longer owns a vocabulary:
 * block resolution, `oldText`, emptying a block and the frozen frame are **`patchCheck`'s**
 * checks, called here and answered in its codes (`BLOCK_NOT_FOUND`, `OLD_TEXT_*`, `EMPTY_BLOCK`,
 * `FRAME_CHANGED`, `PATCH_INVALID`). What the writer adds is what only a whole-file producer can
 * ask — the resulting chapter still fits the book's band, its untouched blocks keep their bytes,
 * order and multiplicity — and the economics of a patch (`PATCH_BUDGET_EXCEEDED`).
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
    const result = applyPatch({
      chapter: 12,
      text,
      patch: patch([{ blockId: target.id, oldText: 'Абзац два.', newText: 'Абзац второй.' }]),
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
    // Code points, the ledger's own measure — not UTF-16 units.
    expect(result.changedChars).toBe(Array.from('Абзац второй.').length);
    expect(result.fraction).toBeCloseTo(result.changedChars / Array.from(blocks.map((block) => block.text).join('')).length, 12);
    expect(result.edits).toHaveLength(1);
  });

  it('keeps the block count and the block order: the ledger’s patch has no insert and no delete', () => {
    const { text, blocks } = sample();
    const first = blocks[0];
    const second = blocks[1];
    if (first === undefined || second === undefined) throw new Error('bad sample');
    const result = applyPatch({
      chapter: 12,
      text,
      patch: patch([
        { blockId: first.id, oldText: 'Абзац один.', newText: 'Абзац первый.' },
        { blockId: second.id, oldText: 'Абзац два.', newText: 'Абзац второй.' },
      ]),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const after = blocksOf(12, result.text);
    expect(after).toHaveLength(blocks.length);
    expect(after.map((block) => block.text.slice(0, 13))).toEqual([
      'Абзац первый.',
      'Абзац второй.',
      blocks[2]?.text.slice(0, 13),
      blocks[3]?.text.slice(0, 13),
    ]);
  });
});

describe('applyPatch — where the proof fails, the code is the ledger’s', () => {
  it('BLOCK_NOT_FOUND for a foreign or stale id', () => {
    const { text } = sample();
    expect(codeOf(applyPatch({ chapter: 12, text, patch: patch([{ blockId: 'ch03#deadbeef', oldText: 'а', newText: 'б' }]) }))).toBe(
      'BLOCK_NOT_FOUND',
    );
  });

  it('OLD_TEXT_NOT_FOUND when the quote is not in the named block', () => {
    const { text, blocks } = sample();
    const first = blocks[0];
    if (first === undefined) throw new Error('bad sample');
    // «Абзац два.» lives in block 1: quoting it against block 0 is a span across blocks.
    expect(codeOf(applyPatch({ chapter: 12, text, patch: patch([{ blockId: first.id, oldText: 'Абзац два.', newText: 'x' }]) }))).toBe(
      'OLD_TEXT_NOT_FOUND',
    );
  });

  it('OLD_TEXT_AMBIGUOUS when the quote occurs twice in the block', () => {
    const repeated = para('пять', 700);
    const text = chapterText([para('один'), repeated, repeated, para('четыре')]);
    const block = blocksOf(12, text)[1];
    if (block === undefined) throw new Error('bad sample');
    expect(
      codeOf(applyPatch({ chapter: 12, text, patch: patch([{ blockId: block.id, oldText: 'Служебный текст', newText: 'x' }]) })),
    ).toBe('OLD_TEXT_AMBIGUOUS');
  });

  it('PATCH_INVALID for an empty pre-image, a duplicate id and a no-op', () => {
    const { text, blocks } = sample();
    const block = blocks[1];
    if (block === undefined) throw new Error('bad sample');
    expect(codeOf(applyPatch({ chapter: 12, text, patch: patch([{ blockId: block.id, oldText: '', newText: 'x' }]) }))).toBe(
      'PATCH_INVALID',
    );
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
    ).toBe('PATCH_INVALID');
    expect(
      codeOf(applyPatch({ chapter: 12, text, patch: patch([{ blockId: block.id, oldText: 'Абзац два.', newText: 'Абзац два.' }]) })),
    ).toBe('PATCH_INVALID');
  });

  it('EMPTY_BLOCK when the edit would empty the paragraph (a delete is a rewrite)', () => {
    const { text, blocks } = sample();
    const block = blocks[1];
    if (block === undefined) throw new Error('bad sample');
    expect(codeOf(applyPatch({ chapter: 12, text, patch: patch([{ blockId: block.id, oldText: block.text, newText: '' }]) }))).toBe(
      'EMPTY_BLOCK',
    );
  });

  it('FRAME_CHANGED on ch01’s opening sentence, the finale’s last, and a basis slot', () => {
    const opening = chapterText([`${FRAME_FIRST_SENTENCE} Я постоял и вышел.`, para('два'), para('три'), para('четыре')], null);
    const firstBlock = blocksOf(1, opening)[0];
    if (firstBlock === undefined) throw new Error('bad sample');
    expect(
      codeOf(
        applyPatch({ chapter: 1, text: opening, patch: patch([{ blockId: firstBlock.id, oldText: 'яркий свет', newText: 'тусклый свет' }]) }),
      ),
    ).toBe('FRAME_CHANGED');
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
    ).toBe('FRAME_CHANGED');

    expect(codeOf(applyPatch({ chapter: 1, text: FRAME_FIRST_SENTENCE, patch: patch([{ blockId: 'x', oldText: 'а', newText: 'б' }]) }))).toBe(
      'FRAME_CHANGED',
    );
  });
});

describe('applyPatch — what only the writer’s layer can ask', () => {
  it('PATCH_BUDGET_EXCEEDED above 15 %, and exactly 15 % is allowed', () => {
    const { text, blocks } = sample();
    const block = blocks[1];
    if (block === undefined) throw new Error('bad sample');
    const chars = blocks.reduce((sum, entry) => sum + Array.from(entry.text).length, 0);
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
    expect(parseChapter(12, text).chars).toBeGreaterThan(CHAPTER_CHARS.max - 600);
    const block = blocksOf(12, text)[1];
    if (block === undefined) throw new Error('bad sample');
    expect(
      codeOf(
        applyPatch({
          chapter: 12,
          text,
          patch: patch([{ blockId: block.id, oldText: 'Абзац два.', newText: `Абзац два. ${'х'.repeat(600)}` }]),
        }),
      ),
    ).toBe('PATCH_LENGTH');
  });

  it('PATCH_PARAGRAPH_FLOOR on a chapter that is already below three paragraphs', () => {
    const text = chapterText([para('один', 900), para('два', 900)]);
    const block = blocksOf(12, text)[0];
    if (block === undefined) throw new Error('bad sample');
    expect(
      codeOf(applyPatch({ chapter: 12, text, patch: patch([{ blockId: block.id, oldText: 'Абзац один.', newText: 'Начало.' }]) })),
    ).toBe('PATCH_PARAGRAPH_FLOOR');
  });

  it('PATCH_INVARIANT when a hand-built edit smuggles a block boundary in', () => {
    const { text, blocks } = sample();
    const block = blocks[1];
    if (block === undefined) throw new Error('bad sample');
    // `parsePatchAnswer` refuses this shape; the applier is the pure core and must not assume
    // the parser ran — a split paragraph breaks the count the patch claims.
    expect(
      codeOf(applyPatch({ chapter: 12, text, patch: patch([{ blockId: block.id, oldText: 'Абзац два.', newText: 'Один.\n\nДва.' }]) })),
    ).toBe('PATCH_INVARIANT');
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

  it('keeps the title line byte for byte', () => {
    const { text, blocks } = sample();
    const first = blocks[0];
    if (first === undefined) throw new Error('bad sample');
    const result = applyPatch({ chapter: 12, text, patch: patch([{ blockId: first.id, oldText: 'Абзац один.', newText: 'Начало.' }]) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text.split('\n')[0]).toBe(TITLE);
  });
});
