/**
 * The patch prompt (BOOK-173 §5): cache-first, and blind to the neighbours.
 *
 * The stable part is canon → §1 → the patch protocol; the tail is place, frame, the chapter's
 * own blocks with their ids, the assignment and one reminder. Two chapters of one book must
 * give the same prefix byte for byte — that is the whole point of the layout — while the tail
 * differs. And patch mode must not carry a neighbour's prose: a patch names blocks of *this*
 * chapter, and the neighbours would be paid for on every call.
 */

import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { parseChapter } from '../../src/ingest/parseChapter.ts';
import { buildPatchPrompt } from '../../src/writer/patch/prompt.ts';
import { PromptError, canonText, type WriterAssignmentData } from '../../src/writer/prompt.ts';
import { sha256Hex } from '../../src/util/hash.ts';
import { textOf } from './textView.ts';

const SITE = resolve(import.meta.dirname, '..', '..', '..');
const REPO = resolve(SITE, '..');
const CANON = ['process/ROLE_PROMPTS.md', 'concept/CONCEPT.md', 'concept/CLIMAX.md', 'style/VOICE.md', 'outline/PLAN.md'];

const dirs: string[] = [];

function tempBook(): string {
  const root = mkdtempSync(join(tmpdir(), 'book-patch-prompt-'));
  dirs.push(root);
  for (const file of CANON) {
    mkdirSync(join(root, dirname(file)), { recursive: true });
    copyFileSync(join(REPO, file), join(root, file));
  }
  mkdirSync(join(root, 'manuscript'), { recursive: true });
  return root;
}

function write(root: string, n: number, title: string, blocks: string[]): string {
  const text = `${title}\n\n${blocks.join('\n\n')}\n`;
  writeFileSync(join(root, 'manuscript', `ch${String(n).padStart(2, '0')}.md`), text);
  return text;
}

function assignment(chapter: number): WriterAssignmentData {
  return { chapter, pass: 'change', intent: null, interventionKind: null, premise: null, expectation: null };
}

const BLOCKS = [
  'Первый абзац главы, в нём гуси шли по льду.',
  'Второй абзац главы, в нём часы шли по кругу.',
  'Третий абзац главы, в нём никто никуда не шёл.',
];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('buildPatchPrompt — one prefix, one chapter at a time', () => {
  it('keeps the prefix byte-identical across chapters and moves only the tail', () => {
    const root = tempBook();
    write(root, 12, 'Глава двенадцать', BLOCKS);
    write(root, 13, 'Глава тринадцать', BLOCKS);
    const one = buildPatchPrompt({ bookRoot: root, chapter: 12, own: textOf(root)(12), assignment: assignment(12) });
    const two = buildPatchPrompt({ bookRoot: root, chapter: 13, own: textOf(root)(13), assignment: assignment(13) });

    expect(one.system).toBe(two.system);
    expect(one.prefixSha256).toBe(two.prefixSha256);
    expect(one.prefixSha256).toBe(sha256Hex(one.system));
    expect(one.user).not.toBe(two.user);
    expect(one.promptSha256).not.toBe(two.promptSha256);
    expect(one.promptSha256).toBe(sha256Hex(`${one.system}\n\n${one.user}`));
    // Canon first, then the role, then the patch protocol: the order is the cache's contract.
    expect(one.system.startsWith(canonText(root))).toBe(true);
    expect(one.sections.map((section) => section.id)).toEqual([
      'canon:concept/CONCEPT.md',
      'canon:concept/CLIMAX.md',
      'canon:style/VOICE.md',
      'canon:outline/PLAN.md',
      'role',
      'protocol',
      'place',
      'frame',
      'chapter',
      'assignment',
      'reminder',
    ]);
  });

  it('prints every block with its id, and the ids are the chapter’s own', () => {
    const root = tempBook();
    const text = write(root, 12, 'Глава двенадцать', BLOCKS);
    const prompt = buildPatchPrompt({ bookRoot: root, chapter: 12, own: textOf(root)(12), assignment: assignment(12) });
    const parsed = parseChapter(12, text);

    expect(prompt.blocks).toEqual(parsed.blocks.map((block) => ({ id: block.id, text: block.text })));
    expect(prompt.blocks).toHaveLength(3);
    for (const block of prompt.blocks) {
      expect(prompt.user).toContain(`### ${block.id}`);
      expect(prompt.user).toContain(block.text);
    }
    // The title line is not a block: a patch may not name it.
    expect(prompt.blocks.some((block) => block.text === 'Глава двенадцать')).toBe(false);
  });

  it('does not send the neighbours’ prose — a patch names blocks of this chapter only', () => {
    const root = tempBook();
    write(root, 11, 'Глава одиннадцать', ['СОСЕД-МАРКЕР до: этого текста в промпте быть не должно.']);
    write(root, 12, 'Глава двенадцать', BLOCKS);
    write(root, 13, 'Глава тринадцать', ['СОСЕД-МАРКЕР после: этого текста в промпте быть не должно.']);
    const prompt = buildPatchPrompt({ bookRoot: root, chapter: 12, own: textOf(root)(12), assignment: assignment(12) });
    expect(`${prompt.system}\n${prompt.user}`).not.toContain('СОСЕД-МАРКЕР');
    expect(prompt.user).toContain('Абзацы этой главы');
  });

  it('states the protocol’s own bounds in the prefix', () => {
    const root = tempBook();
    write(root, 12, 'Глава двенадцать', BLOCKS);
    const prompt = buildPatchPrompt({ bookRoot: root, chapter: 12, own: textOf(root)(12), assignment: assignment(12) });
    expect(prompt.system).toContain('"mode":"patch"');
    expect(prompt.system).toContain('до 8');
    expect(prompt.system).toContain('2000');
    expect(prompt.system).toContain('4000');
    expect(prompt.user).toContain('## Напоминание');
    expect(prompt.user).not.toContain('## Что вернуть');
  });

  it('refuses a chapter with no prose to patch', () => {
    const root = tempBook();
    expect(() => buildPatchPrompt({ bookRoot: root, chapter: 12, own: textOf(root)(12), assignment: assignment(12) })).toThrowError(PromptError);
    write(root, 12, 'Глава двенадцать', BLOCKS);
    writeFileSync(join(root, 'manuscript', 'ch01.md'), 'Я вошёл в пустую комнату. Её освещал яркий свет.');
    expect(() => buildPatchPrompt({ bookRoot: root, chapter: 1, own: textOf(root)(1), assignment: assignment(1) })).toThrowError(PromptError);
  });
});
