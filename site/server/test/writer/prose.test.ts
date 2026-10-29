/**
 * The prose arithmetic of one turn (moved out of `passLane.ts` by BOOK-173 §0).
 *
 * A continuation is prose appended to prose: a repeated title line is not a second chapter, a
 * stray fence is not part of the text, and an empty answer leaves what already stands. These are
 * the three cases that decide whether a thin chapter grows or stays as it was.
 */

import { describe, expect, it } from 'vitest';

import { charsOf, finalize, isThin, mergeContinuation } from '../../src/writer/prose.ts';

const WRITTEN = 'Глава двенадцатая\n\nПервый абзац написанной главы.\n';

describe('mergeContinuation — the addition, not a second chapter', () => {
  it('appends the answer as a new paragraph', () => {
    expect(mergeContinuation(12, WRITTEN, 'Продолжение прозы.')).toBe(`${WRITTEN.trimEnd()}\n\nПродолжение прозы.`);
  });

  it('drops a title line the model repeated, and a stray fence around the answer', () => {
    const repeated = 'Глава двенадцатая\n\nПродолжение прозы.';
    expect(mergeContinuation(12, WRITTEN, repeated)).toBe(`${WRITTEN.trimEnd()}\n\nПродолжение прозы.`);
    expect(mergeContinuation(12, WRITTEN, '```\nПродолжение прозы.\n```')).toBe(`${WRITTEN.trimEnd()}\n\nПродолжение прозы.`);
  });

  it('leaves the text alone when the answer adds nothing', () => {
    expect(mergeContinuation(12, WRITTEN, '   ')).toBe(WRITTEN);
    expect(mergeContinuation(12, WRITTEN, 'Глава двенадцатая')).toBe(WRITTEN);
  });
});

describe('finalize, charsOf and isThin', () => {
  it('lands exactly one trailing newline', () => {
    expect(finalize('Глава\n\nАбзац.\n\n\n')).toBe('Глава\n\nАбзац.\n');
  });

  it('counts prose through the parser, never a second rule', () => {
    expect(charsOf(12, WRITTEN)).toBe('Первый абзац написанной главы.'.length);
    expect(isThin(12, WRITTEN)).toBe(true);
    expect(isThin(12, `${WRITTEN}\n${'слово '.repeat(3_000)}`)).toBe(false);
  });
});
