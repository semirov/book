import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { scanManuscript } from '../src/ingest/scanManuscript.ts';
import { createFixture, type Fixture } from './helpers.ts';

const fixtures: Fixture[] = [];
function fixture(chapters: Record<string, string> = {}): Fixture {
  const created = createFixture(chapters);
  fixtures.push(created);
  return created;
}

afterAll(() => {
  for (const item of fixtures) item.close();
});

describe('scanManuscript', () => {
  it('reports a missing directory instead of throwing', () => {
    const created = fixture();
    const result = scanManuscript(join(created.root, 'nowhere'));
    expect(result.missing).toBe(true);
    expect(result.chapters).toEqual([]);
  });

  it('separates the first sheet from the chapters', () => {
    const created = fixture({ '00-front.md': 'Название\n\nАннотация.', 'ch01.md': 'Заголовок.\n\nТекст.' });
    const result = scanManuscript(created.root);
    expect(result.front?.fileName).toBe('00-front.md');
    expect(result.front?.raw).toContain('Название');
    expect(result.chapters.map((chapter) => chapter.n)).toEqual([1]);
    expect(result.ignored).not.toContain('00-front.md');
  });

  it('reports a missing first sheet as null, not as a chapter', () => {
    const created = fixture({ 'ch01.md': 'Заголовок.\n\nТекст.' });
    expect(scanManuscript(created.root).front).toBeNull();
  });

  it('returns chapters in order', () => {
    const created = fixture({ 'ch42.md': 'Конец.', 'ch01.md': 'Начало.' });
    const result = scanManuscript(created.root);
    expect(result.chapters.map((chapter) => chapter.n)).toEqual([1, 42]);
    expect(result.chapters[0]?.fileName).toBe('ch01.md');
  });

  it('ignores stray files, directories and out-of-range numbers', () => {
    // BOOK-155: the first number past the book is a stray file, never a chapter.
    const created = fixture({ 'ch05.md': 'Глава.', 'PLAN.md': '# План', 'ch43.md': 'Вне книги.' });
    mkdirSync(join(created.manuscript, 'archive'));
    mkdirSync(join(created.manuscript, 'ch09.md'));
    const result = scanManuscript(created.root);
    expect(result.chapters.map((chapter) => chapter.n)).toEqual([5]);
    expect(result.ignored).toEqual(expect.arrayContaining(['PLAN.md', 'ch43.md', 'archive', 'ch09.md']));
  });

  it('carries the file mtime, so the reader sees the writing time', () => {
    const created = fixture({ 'ch01.md': 'Текст.' });
    const result = scanManuscript(created.root);
    expect(result.chapters[0]?.mtimeMs).toBeGreaterThan(0);
  });
});
