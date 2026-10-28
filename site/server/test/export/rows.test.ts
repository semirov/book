/**
 * BOOK-187 AC11 — the export is a rendering of rows, on demand.
 *
 * What is proven here: both formats come out of a database with no book file anywhere; markdown
 * is byte-identical across two runs (that is what makes a diff of two exports mean something);
 * the FB2 carries the same sections `/book.fb2` serves; and the only path written is the one the
 * caller named — no directory is created, nothing lands in the volume, nothing is committed.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Imprint } from '@book/shared';

import { exportBook, projectBook, renderMarkdown } from '../../src/export/book.ts';
import { parseExportArgs, runExport } from '../../src/export/cli.ts';
import { reconcile } from '../../src/ingest/reconcile.ts';
import { createFixture, type Fixture } from '../helpers.ts';

const COVER = resolve(import.meta.dirname, '..', '..', '..', 'web', 'public', 'cover', 'cover.png');

// The annotation is validated on import (F021, 300–4 000 characters), so the fixture's is real
// prose in the shape the rule allows.
const ABOUT =
  'Служебная аннотация для проверки экспорта. Она состоит из служебных предложений и не является текстом книги. ' +
  'Служебная аннотация для проверки экспорта. Она состоит из служебных предложений и не является текстом книги. ' +
  'Служебная аннотация для проверки экспорта. Она состоит из служебных предложений и не является текстом книги.';
const CH02 = `Вторая глава\n\nПервый абзац второй главы.\n\nВторой абзац второй главы.\n`;
const CH12 = `Двенадцатая глава\n\nАбзац двенадцатой главы.\n`;

const IMPRINT: Imprint = {
  author: 'Филипп Семиров',
  copyright: 'Филипп Семиров, 2026',
  publisher: null,
  year: '2026',
};

/** Two chapters and a first sheet, published the way the one-shot import publishes a book. */
function rowBook(): { fixture: Fixture; deps: Parameters<typeof runExport>[2]; close: () => void } {
  const fixture = createFixture({ '00-front.md': `Бланк\n\n${ABOUT}\n`, 'ch02.md': CH02, 'ch12.md': CH12 });
  reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
  return {
    fixture,
    deps: {
      db: fixture.db,
      imprint: IMPRINT,
      version: '0.1.0',
      publicOrigin: 'https://book.semirov.dev',
      coverPath: COVER,
    },
    close: () => fixture.close(),
  };
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { log: (line: string) => out.push(line), error: (line: string) => err.push(line) }, out, err };
}

describe('exporting markdown from rows (BOOK-187 AC11)', () => {
  it('prints the title, the annotation, then every chapter and its paragraphs', () => {
    const { deps, close } = rowBook();
    try {
      const markdown = renderMarkdown(projectBook(deps.db));
      expect(markdown.startsWith('# Бланк\n\n')).toBe(true);
      expect(markdown).toContain(ABOUT);
      expect(markdown).toContain('## Вторая глава\n\nПервый абзац второй главы.\n\nВторой абзац второй главы.');
      expect(markdown).toContain('## Двенадцатая глава\n\nАбзац двенадцатой главы.');
      // One blank line between blocks, LF only, one trailing newline, no timestamp anywhere.
      expect(markdown.endsWith('\n')).toBe(true);
      expect(markdown.endsWith('\n\n')).toBe(false);
      expect(markdown).not.toContain('\r');
      expect(markdown).not.toMatch(/\d{4}-\d{2}-\d{2}T/u);
    } finally {
      close();
    }
  });

  it('is byte-identical across two runs', () => {
    const { deps, close } = rowBook();
    try {
      expect(exportBook('md', deps)).toBe(exportBook('md', deps));
    } finally {
      close();
    }
  });
});

describe('exporting FB2 from rows (BOOK-187 AC11)', () => {
  it('carries the sections the site serves, the cover and the edition', () => {
    const { deps, close } = rowBook();
    try {
      const fb2 = exportBook('fb2', deps);
      expect(fb2.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true);
      expect(fb2).toContain('<book-title>Бланк</book-title>');
      expect(fb2).toContain('<section id="ch02">');
      expect(fb2).toContain('<section id="ch12">');
      expect(fb2).toContain('<p>Второй абзац второй главы.</p>');
      expect(fb2).toContain('<binary id="cover.png"');
      // No `document-info/date`: an export is a state, not a response, so two are identical.
      expect(fb2).not.toContain('<date value=');
      expect(exportBook('fb2', deps)).toBe(fb2);
      expect(fb2.trimEnd().endsWith('</FictionBook>')).toBe(true);
    } finally {
      close();
    }
  });
});

describe('what the export leaves out, and how it names what is left', () => {
  it('titles an untitled chapter and falls back to «Книга» when the volume has no front row', () => {
    // A chapter whose first line is empty has no title line: the reader prints «Глава 5».
    const fixture = createFixture({ 'ch05.md': '\nАбзац без заголовка.\n' });
    reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
    try {
      const markdown = renderMarkdown(projectBook(fixture.db));
      // The fixture's first sheet is never imported here: the volume holds no front row.
      expect(markdown).toBe('# Книга\n\n## Глава 5\n\nАбзац без заголовка.\n');
    } finally {
      fixture.close();
    }
  });

  it('skips a chapter with no paragraph and a stored row outside the book', () => {
    const { fixture, deps, close } = rowBook();
    try {
      // A row outside 1..42 is storage, not a chapter (BOOK-155); a row with no blocks has no
      // text to print. Neither may appear as an empty heading.
      fixture.db
        .prepare(
          `INSERT INTO chapters (n, rev, title, sha256, chars, block_count, basis, written_at, updated_at)
           VALUES (65, 1, 'Остаток старой книги', 'sha-65', 10, 0, 0, '2026-10-25T00:00:00Z', '2026-10-25T00:00:00Z')`,
        )
        .run();
      fixture.db.prepare('DELETE FROM blocks WHERE chapter = 12').run();
      const markdown = renderMarkdown(projectBook(deps.db));
      expect(markdown).not.toContain('Остаток старой книги');
      expect(markdown).not.toContain('Двенадцатая глава');
      expect(markdown).toContain('Вторая глава');
    } finally {
      close();
    }
  });
});

describe('the export writes one path and creates nothing', () => {
  it('writes exactly the `--out` path, prints the byte count, and leaves the volume alone', () => {
    const { fixture, deps, close } = rowBook();
    const out = mkdtempSync(join(tmpdir(), 'book-export-out-'));
    try {
      const before = readdirSync(fixture.dataDir).sort();
      for (const [format, name] of [
        ['md', 'book.md'],
        ['fb2', 'book.fb2'],
      ] as const) {
        const { io, out: lines } = capture();
        const path = join(out, name);
        expect(runExport({ format, out: path, dataDir: null }, io, deps)).toBe(0);
        const bytes = statSync(path).size;
        expect(lines).toEqual([`${path}: ${String(bytes)} bytes`]);
        expect(bytes).toBe(Buffer.byteLength(readFileSync(path, 'utf8'), 'utf8'));
      }
      // Two runs, two files, and nothing else in the directory.
      expect(readdirSync(out).sort()).toEqual(['book.fb2', 'book.md']);
      // The volume gains no index, no slice, no derivative: an export reads.
      expect(readdirSync(fixture.dataDir).sort()).toEqual(before);
    } finally {
      rmSync(out, { recursive: true, force: true });
      close();
    }
  });

  it('refuses a path whose directory does not exist instead of creating it', () => {
    const { deps, close } = rowBook();
    const out = mkdtempSync(join(tmpdir(), 'book-export-out-'));
    try {
      const { io, err } = capture();
      const path = join(out, 'no-such-dir', 'book.md');
      expect(runExport({ format: 'md', out: path, dataDir: null }, io, deps)).toBe(1);
      expect(err.join('\n')).toContain('export:');
      expect(readdirSync(out)).toEqual([]);
    } finally {
      rmSync(out, { recursive: true, force: true });
      close();
    }
  });
});

describe('the export arguments', () => {
  it('reads --format, --out and --data-dir in both spellings', () => {
    expect(parseExportArgs(['--format', 'md', '--out', '/tmp/a.md'])).toEqual({
      format: 'md',
      out: '/tmp/a.md',
      dataDir: null,
    });
    expect(parseExportArgs(['--format=fb2', '--out=/tmp/a.fb2', '--data-dir=/srv/book'])).toEqual({
      format: 'fb2',
      out: '/tmp/a.fb2',
      dataDir: '/srv/book',
    });
  });

  it('refuses an unknown format, a missing path and an unknown flag', () => {
    expect(parseExportArgs(['--format', 'pdf', '--out', '/tmp/a'])).toEqual({ error: 'unknown format "pdf": use md or fb2' });
    expect(parseExportArgs(['--format', 'md'])).toEqual({ error: expect.stringContaining('--out') });
    expect(parseExportArgs(['--out', '/tmp/a'])).toEqual({ error: expect.stringContaining('--format') });
    expect(parseExportArgs(['--format', 'md', '--out', '/tmp/a', '--png'])).toEqual({
      error: 'unknown argument: --png',
    });
    // A flag at the end of the line has no value, and says so instead of reading `undefined`.
    expect(parseExportArgs(['--format'])).toEqual({ error: '--format needs a value (md or fb2)' });
    expect(parseExportArgs(['--format', 'md', '--out'])).toEqual({ error: '--out needs a path' });
    expect(parseExportArgs(['--format', 'md', '--out', '/tmp/a', '--data-dir'])).toEqual({
      error: '--data-dir needs a directory',
    });
    expect(parseExportArgs(['--format', 'md', '--out', ''])).toEqual({ error: '--out needs a path' });
  });
});
