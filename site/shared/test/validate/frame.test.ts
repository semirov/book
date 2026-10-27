import { describe, expect, it } from 'vitest';

import type { Imprint, LegalDenylist } from '../../src/book.ts';
import { FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE } from '../../src/book.ts';
import type { ManuscriptFile } from '../../src/validate/index.ts';
import { runValidation } from '../../src/validate/index.ts';

const IMPRINT: Imprint = {
  author: 'Филипп Семиров',
  copyright: '© Филипп Семиров',
  publisher: null,
  year: 'auto',
};

const DENYLIST: LegalDenylist = { persons: [], characters: [], organisations: [], patterns: [] };

const ABOUT =
  'Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги. Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги. Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги.';

const FRONT: ManuscriptFile = { name: '00-front.md', text: `Без названия\n\n${ABOUT}` };

function run(files: ManuscriptFile[]) {
  return runValidation({ files, imprint: IMPRINT, denylist: DENYLIST });
}

const withRule = (result: ReturnType<typeof run>, rule: string) =>
  result.findings.filter((item) => item.rule === rule);
const found = (result: ReturnType<typeof run>) => withRule(result, 'F029');

describe('F029 — the frozen frame', () => {
  /** A chapter file with a valid title line and the given prose. */
  const framed = (n: number, body: string): ManuscriptFile => ({
    name: `ch${String(n).padStart(2, '0')}.md`,
    text: `Глава\n\n${body}`,
  });

  it('accepts the frame at both ends', () => {
    const result = run([
      FRONT,
      framed(1, `${FRAME_FIRST_SENTENCE} Потом он сел и стал ждать.`),
      framed(67, `Всё стихло к утру. ${FRAME_LAST_SENTENCE}`),
    ]);
    expect(found(result)).toEqual([]);
  });

  it('accepts a frame rewrapped across lines', () => {
    const opening = run([FRONT, framed(1, 'Я вошёл в пустую комнату.\nЕё освещал яркий свет. Потом он сел.')]);
    expect(found(opening)).toEqual([]);

    const closing = run([
      FRONT,
      framed(67, 'Всё стихло.\nСвет погас, потому что не осталось\nглаз, которым он был бы нужен.'),
    ]);
    expect(found(closing)).toEqual([]);
  });

  it('rejects a changed word in the opening sentence', () => {
    const result = run([FRONT, framed(1, 'Я вошёл в тёмную комнату. Её освещал яркий свет. Потом он сел.')]);
    expect(found(result)).toEqual([
      expect.objectContaining({
        severity: 'error',
        file: 'ch01.md',
        message: expect.stringContaining('must begin with'),
      }),
    ]);
    expect(found(result)[0]?.message).toContain('found «Я вошёл в тёмную комнату.»');
  });

  it('rejects ch01 without the frozen sentence', () => {
    const result = run([FRONT, framed(1, 'Тестовый абзац пришёл на работу раньше всех.')]);
    expect(found(result)).toHaveLength(1);
    expect(found(result)[0]?.message).toContain('found «Тестовый абзац пришёл на работу раньше всех.»');
  });

  it('rejects ch67 without the last sentence', () => {
    const result = run([FRONT, framed(67, 'Всё стихло, но кто-то остался.')]);
    expect(found(result)).toEqual([
      expect.objectContaining({ severity: 'error', file: 'ch67.md', message: expect.stringContaining('must end with') }),
    ]);
    expect(found(result)[0]?.message).toContain('found «Всё стихло, но кто-то остался.»');
  });

  it('reports the tail of a long closing paragraph', () => {
    const result = run([FRONT, framed(67, `${'Слово '.repeat(40)}и всё стихло.`)]);
    const message = found(result)[0]?.message ?? '';
    expect(message).toContain('…');
    expect(message).toContain('и всё стихло.»');
  });

  it('accepts the sentence as the whole file — a basis-only slot', () => {
    const result = run([
      FRONT,
      { name: 'ch01.md', text: FRAME_FIRST_SENTENCE },
      { name: 'ch67.md', text: FRAME_LAST_SENTENCE },
    ]);
    expect(found(result)).toEqual([]);
  });

  it('accepts the sentence as a title-less first line', () => {
    const result = run([FRONT, { name: 'ch01.md', text: `${FRAME_FIRST_SENTENCE}\nПотом он сел.` }]);
    expect(found(result)).toEqual([]);
  });

  /**
   * The sandbox chapter 1 that BOOK-32 rejected: the frame on line 1, a blank line, then new
   * prose. The blank line under line 1 was read as "line 1 is a title", the frame was dropped
   * and F029 compared the second paragraph.
   */
  it('accepts the frame as the first line followed by a blank line and prose', () => {
    const result = run([FRONT, { name: 'ch01.md', text: `${FRAME_FIRST_SENTENCE}\n\nСвет был включён до меня.` }]);
    expect(found(result)).toEqual([]);
    // The line is still a structurally valid title line, so the fix adds no F022 finding.
    expect(withRule(result, 'F022')).toEqual([]);
  });

  it('rejects a rewritten frame followed by a blank line and prose', () => {
    const result = run([
      FRONT,
      { name: 'ch01.md', text: 'Я вошёл в тёмную комнату. Её освещал яркий свет.\n\nСвет был включён до меня.' },
    ]);
    // The line is no longer the frozen sentence, so §6C.3 reads it as the title line and the
    // prose after it is what F029 compares — the finding is raised either way.
    expect(found(result)).toEqual([
      expect.objectContaining({
        severity: 'error',
        file: 'ch01.md',
        line: 3,
        message: expect.stringContaining('must begin with'),
      }),
    ]);
  });

  it('accepts the frame joined to new prose on line 1, then a blank line', () => {
    const result = run([
      FRONT,
      {
        name: 'ch01.md',
        text: `${FRAME_FIRST_SENTENCE} Я постоял и вышел.\n\nСвет был включён до меня.`,
      },
    ]);
    expect(found(result)).toEqual([]);
  });

  it('reads a frame broken by a blank line as a title line, not as prose', () => {
    // Line 1 is not the frame and does not extend it, so §6C.3 makes it the title line and the
    // chapter's prose no longer begins with the frozen sentence (the rule is deliberately narrow).
    const result = run([
      FRONT,
      { name: 'ch01.md', text: 'Я вошёл в пустую комнату.\n\nЕё освещал яркий свет.\n\nСвет был включён до меня.' },
    ]);
    expect(found(result)).toHaveLength(1);
    expect(found(result)[0]?.message).toContain('found «Её освещал яркий свет.»');
  });

  it('rejects a ch67 frame on the first line: the frame ends that chapter', () => {
    const result = run([FRONT, { name: 'ch67.md', text: `${FRAME_LAST_SENTENCE}\n\nОн сел у окна.` }]);
    expect(found(result)).toEqual([
      expect.objectContaining({ severity: 'error', file: 'ch67.md', message: expect.stringContaining('must end with') }),
    ]);
  });

  /**
   * A rewrapped frame is the same frame, but only the closing one is also a valid title shape:
   * on ch01 the wrap makes line 2 non-blank, so the title rule (F022) asks for a blank line
   * while the frame itself is accepted (F029). Both facts are asserted, not one of them.
   */
  it('accepts a rewrapped frame and keeps ch01 inside the title rule', () => {
    const opening = run([
      FRONT,
      { name: 'ch01.md', text: 'Я вошёл в пустую комнату.\nЕё освещал яркий свет.\n\nСвет был включён до меня.' },
    ]);
    expect(found(opening)).toEqual([]);
    expect(withRule(opening, 'F022').map((item) => item.message)).toEqual([
      expect.stringContaining('line 2 must be blank'),
    ]);

    const closing = run([
      FRONT,
      { name: 'ch67.md', text: 'Всё стихло к утру.\n\nСвет погас, потому что не осталось\nглаз, которым он был бы нужен.' },
    ]);
    expect(found(closing)).toEqual([]);
    expect(withRule(closing, 'F022')).toEqual([]);
  });

  it('checks a titled chapter from the prose, not from the title line', () => {
    const valid = run([FRONT, framed(1, `${FRAME_FIRST_SENTENCE} Потом он сел.`)]);
    expect(found(valid)).toEqual([]);

    const late = run([FRONT, framed(1, `Потом он сел. ${FRAME_FIRST_SENTENCE}`)]);
    expect(found(late)).toHaveLength(1);
    expect(found(late)[0]?.message).toContain('found «Потом он сел.»');
  });

  it('accepts prose, a blank line and the closing frame (ch67)', () => {
    const result = run([FRONT, { name: 'ch67.md', text: `Он сел у окна.\n\n${FRAME_LAST_SENTENCE}` }]);
    expect(found(result)).toEqual([]);
  });

  it('rejects a changed word in the closing frame without a title line', () => {
    const result = run([
      FRONT,
      { name: 'ch67.md', text: 'Он сел у окна.\n\nСвет погас, потому что не осталось глаз, которым он был бы не нужен.' },
    ]);
    expect(found(result)).toEqual([
      expect.objectContaining({ severity: 'error', file: 'ch67.md', message: expect.stringContaining('must end with') }),
    ]);
  });

  it('rejects a closing frame that is not the last sentence', () => {
    const result = run([FRONT, { name: 'ch67.md', text: `Он сел у окна.\n\n${FRAME_LAST_SENTENCE} Потом стало тихо.` }]);
    expect(found(result)).toHaveLength(1);
    expect(found(result)[0]?.message).toContain('must end with');
  });

  it('accepts a manuscript without ch67', () => {
    const result = run([FRONT, framed(1, `${FRAME_FIRST_SENTENCE} Потом он сел.`)]);
    expect(found(result)).toEqual([]);
  });

  it('keeps the reported sentence to 80 characters', () => {
    const result = run([FRONT, framed(1, `${'Слово '.repeat(40)}и всё.`)]);
    const message = found(result)[0]?.message ?? '';
    expect(message).toContain('…');
    expect(message.length).toBeLessThan(300);
  });
});
