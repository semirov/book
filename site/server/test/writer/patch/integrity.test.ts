/**
 * Narrative integrity after a patch (BOOK-173 §3) — model-free, and pinned by closed rules.
 *
 * Two heuristics and one hash: a block that opens on a pronoun whose antecedent left is a hole
 * a gate would read as prose; a fact that does not survive the edit is a changed world; and a
 * neighbour that moved between the prompt and the landing means the patch was written against
 * another book. Each refusal is tested on both sides — the case that fires and the near-miss
 * that must not.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { parseChapter } from '../../../src/ingest/parseChapter.ts';
import {
  FUNCTION,
  REFERENCE,
  danglingReference,
  factsIntact,
  neighbourDigests,
  neighbourMoved,
  tokens,
} from '../../../src/writer/patch/integrity.ts';
import type { PatchAnswer, PatchEdit } from '../../../src/writer/patch/protocol.ts';

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function blocks(...texts: string[]): Array<{ id: string; text: string }> {
  const chapter = parseChapter(12, `Глава\n\n${texts.join('\n\n')}\n`);
  return chapter.blocks.map((block) => ({ id: block.id, text: block.text }));
}

function answer(edits: PatchEdit[], facts: string[] = []): PatchAnswer {
  return { mode: 'patch', edits, facts, note: null };
}

describe('the closed token sets', () => {
  it('pins the reference and function words the check is allowed to use', () => {
    expect(REFERENCE.size).toBe(48);
    expect(FUNCTION.size).toBe(59);
    for (const word of ['он', 'она', 'этот', 'поэтому', 'оттуда']) expect(REFERENCE.has(word), word).toBe(true);
    for (const word of ['в', 'и', 'не', 'был', 'может', 'всё']) expect(FUNCTION.has(word), word).toBe(true);
    // A content word is in neither set: those are the only tokens a candidate may be.
    for (const word of ['сторож', 'лампа', 'документ']) {
      expect(REFERENCE.has(word)).toBe(false);
      expect(FUNCTION.has(word)).toBe(false);
    }
  });

  it('folds ё to е and splits on punctuation', () => {
    expect(tokens('Он шёл, ёжась: «да».')).toEqual(['он', 'шел', 'ежась', 'да']);
  });
});

describe('danglingReference — four conditions, all of them', () => {
  const above = 'Сторож вошёл в комнату и закрыл дверь.';
  const target = 'Сторож поставил лампу на стол и ушёл.';

  it('refuses a block that opens on «Он» after its antecedent was deleted', () => {
    // The block above names nobody: there is nothing for «Он» to point at.
    const chapters = blocks('Дверь закрылась за спиной.', target, 'В коридоре было тихо.');
    // Not one content token of the removed sentence survives: all four are candidates.
    const edit: PatchEdit = { blockId: chapters[1]?.id ?? '', oldText: target, newText: 'Он вышел.' };
    const result = danglingReference({ blocks: chapters, edits: [edit] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PATCH_DANGLING_REFERENCE');
    expect(result.detail).toContain('сторож');
  });

  it('keeps the pronoun when the antecedent is still visible one block up', () => {
    const chapters = blocks('Сторож стоял у двери.', target, 'В коридоре было тихо.');
    const edit: PatchEdit = { blockId: chapters[1]?.id ?? '', oldText: target, newText: 'Он ушёл.' };
    expect(danglingReference({ blocks: chapters, edits: [edit] })).toEqual({ ok: true, skipped: null });
  });

  it('keeps a block that already opened on its pronoun before the edit', () => {
    const chapters = blocks(above, 'Он поставил лампу на стол.', 'В коридоре было тихо.');
    const edit: PatchEdit = { blockId: chapters[1]?.id ?? '', oldText: 'Он поставил лампу на стол.', newText: 'Он ушёл.' };
    expect(danglingReference({ blocks: chapters, edits: [edit] })).toEqual({ ok: true, skipped: null });
  });

  it('skips the first block of the chapter and says so', () => {
    const chapters = blocks('Сторож поставил лампу на стол.', 'В коридоре было тихо.', 'Дверь закрылась.');
    const edit: PatchEdit = { blockId: chapters[0]?.id ?? '', oldText: 'Сторож поставил лампу на стол.', newText: 'Он ушёл.' };
    expect(danglingReference({ blocks: chapters, edits: [edit] })).toEqual({ ok: true, skipped: 'no-predecessor' });
  });

  it('does not refuse when the removed text carries no candidate', () => {
    const chapters = blocks(above, 'Сторож и ушёл.', 'В коридоре было тихо.');
    // «Сторож» survives in the previous block of this fixture, so this is the kept case; the
    // point here is a removed range whose tokens are short or functional.
    const edit: PatchEdit = { blockId: chapters[1]?.id ?? '', oldText: 'и ушёл.', newText: 'Он и ушёл.' };
    expect(danglingReference({ blocks: chapters, edits: [edit] })).toEqual({ ok: true, skipped: null });
  });

  it('reads a leading dash, quote or bracket as punctuation, not as a word', () => {
    const chapters = blocks(above, 'Сторож поставил лампу на стол.', 'В коридоре было тихо.');
    const edit: PatchEdit = { blockId: chapters[1]?.id ?? '', oldText: 'Сторож поставил лампу на стол.', newText: '— Он поставил лампу на стол.' };
    // The block still carries «поставил»/«лампу»/«стол», so the antecedent by name is gone but
    // the candidates are visible: this is the near-miss, not a refusal.
    expect(danglingReference({ blocks: chapters, edits: [edit] })).toEqual({ ok: true, skipped: null });
  });
});

describe('factsIntact — strings only', () => {
  const text = 'В комнате 257 стоял протокол УП и часы.';

  it('accepts a fact that occurs verbatim and a replaced range that keeps its numbers', () => {
    expect(factsIntact({ text, patch: answer([], ['протокол УП']) })).toEqual({ ok: true });
    expect(
      factsIntact({
        text,
        patch: answer([{ blockId: 'x', oldText: 'стоял протокол УП', newText: 'лежал протокол УП' }], ['257']),
      }),
    ).toEqual({ ok: true });
  });

  it('refuses a fact that is not in the patched chapter', () => {
    const result = factsIntact({ text, patch: answer([], ['часы шли']) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PATCH_FACT_LOST');
    expect(result.detail).toContain('fact 1');
  });

  it('refuses a number that the edit dropped', () => {
    const result = factsIntact({
      text: 'В комнате стоял протокол УП и часы.',
      patch: answer([{ blockId: 'x', oldText: 'В комнате 257 стоял', newText: 'В комнате стоял' }]),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('257');
  });

  it('refuses an abbreviation that the edit dropped', () => {
    const result = factsIntact({
      text: 'В комнате 257 стоял протокол и часы.',
      patch: answer([{ blockId: 'x', oldText: 'стоял протокол УП', newText: 'стоял протокол' }]),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('УП');
  });

  it('says nothing about ordinary words: only numbers and abbreviations are fact-shaped', () => {
    expect(
      factsIntact({ text: 'Гуси шли по льду.', patch: answer([{ blockId: 'x', oldText: 'Гуси шли по льду.', newText: 'Часы шли.' }]) }),
    ).toEqual({ ok: true });
  });
});

describe('neighbourDigests — hashes, not a reading', () => {
  function bookRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'book-neighbours-'));
    dirs.push(root);
    mkdirSync(join(root, 'manuscript'), { recursive: true });
    writeFileSync(join(root, 'manuscript', 'ch11.md'), 'Глава одиннадцать\n\nСосед до.\n');
    writeFileSync(join(root, 'manuscript', 'ch13.md'), 'Глава тринадцать\n\nСосед после.\n');
    return root;
  }

  it('records two hashes, and no hash where there is no neighbour', () => {
    const root = bookRoot();
    const digests = neighbourDigests(root, 12);
    expect(digests.before).toMatch(/^[0-9a-f]{64}$/u);
    expect(digests.after).toMatch(/^[0-9a-f]{64}$/u);
    expect(neighbourDigests(root, 2)).toEqual({ before: null, after: null });
    expect(neighbourDigests(root, 1).before).toBeNull();
  });

  it('notices a neighbour that moved between the prompt and the landing', () => {
    const root = bookRoot();
    const recorded = neighbourDigests(root, 12);
    expect(neighbourMoved(root, 12, recorded)).toBe(false);
    writeFileSync(join(root, 'manuscript', 'ch13.md'), 'Глава тринадцать\n\nСосед после — правка.\n');
    expect(neighbourMoved(root, 12, recorded)).toBe(true);
  });
});
