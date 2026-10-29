import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TOTAL_CHAPTERS, frameSentenceOf } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { databaseFile, openDatabase, type Db } from '../../src/db/db.ts';
import { migrate } from '../../src/db/migrate.ts';
import { hashChapters, indexChapterText, buildIndex } from '../../src/index/build.ts';
import {
  artifactPath,
  ensureIndex,
  ensureSlice,
  readIndex,
  renderIndex,
  sliceOf,
  slicePath,
} from '../../src/index/store.ts';
import type { IndexSlice } from '../../src/index/types.ts';
import { applyChapterFile } from '../../src/ingest/applyChapter.ts';

/**
 * BOOK-187: the index reads rows, so its fixture is rows — a database and a directory, with no
 * `manuscript/` anywhere. `write` publishes a chapter the way the applier does (a new revision),
 * which is what makes the artifact's key move when the text moves.
 */
type RowBook = { db: Db; dataDir: string; write: (n: number, text: string) => void; close: () => void };

const AT = Date.UTC(2026, 9, 25, 9, 0, 0);

const CH12 = 'Глава двенадцатая\n\nИнженер Ковалёв вошёл в комнату. Приказ № 4 выдан утром.\n';
const CH13 = 'Глава тринадцатая\n\nКовалёв обещал вернуться через два дня.\n';

function rowBook(chapters: Record<number, string> = {}): RowBook {
  const dataDir = mkdtempSync(join(tmpdir(), 'book-index-data-'));
  const db = openDatabase(databaseFile(dataDir));
  migrate(db);
  let at = AT;
  const write = (n: number, text: string): void => {
    at += 1_000;
    const result = applyChapterFile({ db, dataDir, n, raw: text, mtimeMs: at, nowMs: at });
    if (result.status === 'frame-rejected') throw new Error(`chapter ${String(n)} moved the frame`);
  };
  for (const [n, text] of Object.entries(chapters)) write(Number(n), text);
  return {
    db,
    dataDir,
    write,
    close: () => {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

describe('building the derived index from rows (BOOK-18 §1, BOOK-187 AC2)', () => {
  it('covers every slot in order and hashes only text and version', () => {
    const book = rowBook({ 12: CH12, 13: CH13 });
    try {
      const index = buildIndex(book.db);
      expect(index.chapters).toHaveLength(TOTAL_CHAPTERS);
      expect(index.chapters.map((chapter) => chapter.n)).toEqual([...Array(TOTAL_CHAPTERS)].map((_, i) => i + 1));
      expect(index.chapters.find((chapter) => chapter.n === 12)?.documents).toHaveLength(1);
      expect(index.chapters.find((chapter) => chapter.n === 11)).toMatchObject({ written: false, entities: [] });
      expect(index.manuscriptHash).toMatch(/^[0-9a-f]{64}$/u);
    } finally {
      book.close();
    }
  });

  it('keys the artifact by the stored per-chapter sha, in slot order', () => {
    const book = rowBook({ 12: CH12 });
    try {
      const index = buildIndex(book.db);
      const rows = book.db.prepare('SELECT n, sha256 FROM chapters ORDER BY n').all() as Array<{
        n: number;
        sha256: string;
      }>;
      // The key is the same input the edition hash names: the row, not the paragraphs.
      expect(index.chapters.find((chapter) => chapter.n === 12)?.sha256).toBe(rows[0]?.sha256);
      expect(index.manuscriptHash).toBe(hashChapters(index.chapters));
      // A slot with no row is the hash of nothing, exactly as an absent file was.
      expect(index.chapters.find((chapter) => chapter.n === 5)).toMatchObject({ written: false });
    } finally {
      book.close();
    }
  });

  it('treats a basis-only slot as not prose (ch01/ch42, BOOK-6)', () => {
    const book = rowBook({ 1: frameSentenceOf(1) ?? '', 12: CH12 });
    try {
      const index = buildIndex(book.db);
      expect(index.chapters.find((chapter) => chapter.n === 1)).toMatchObject({
        written: false,
        entities: [],
        documents: [],
      });
    } finally {
      book.close();
    }
  });

  it('is reproducible: a rebuild over identical rows is identical, hash included (a restart is not a change)', () => {
    const book = rowBook({ 12: CH12, 13: CH13 });
    try {
      const first = buildIndex(book.db);
      const second = buildIndex(book.db);
      expect(renderIndex(second)).toBe(renderIndex(first));
      expect(second.manuscriptHash).toBe(first.manuscriptHash);
      // Re-publishing the same bytes is `unchanged`: no revision, no new key.
      book.write(12, CH12);
      expect(buildIndex(book.db).manuscriptHash).toBe(first.manuscriptHash);
    } finally {
      book.close();
    }
  });

  it('reuses the untouched chapters’ facts after a one-chapter rewrite (memoised extraction)', () => {
    const book = rowBook({ 12: CH12, 13: CH13 });
    try {
      const first = buildIndex(book.db);
      book.write(12, CH13.replaceAll('тринадцатая', 'двенадцатая'));
      const second = buildIndex(book.db);
      expect(second.chapters.filter((chapter) => chapter.n !== 12)).toEqual(
        first.chapters.filter((chapter) => chapter.n !== 12),
      );
      expect(second.chapters.find((chapter) => chapter.n === 12)).not.toEqual(
        first.chapters.find((chapter) => chapter.n === 12),
      );
      expect(second.manuscriptHash).not.toBe(first.manuscriptHash);
    } finally {
      book.close();
    }
  });
});

describe('storing the index (BOOK-18 §1, §2)', () => {
  it('writes one artifact and replaces it wholesale on rebuild', () => {
    const book = rowBook({ 12: CH12 });
    try {
      const index = ensureIndex({ db: book.db, dataDir: book.dataDir });
      const stored = readIndex(book.dataDir);
      expect(stored?.manuscriptHash).toBe(index.manuscriptHash);
      expect(readFileSync(artifactPath(book.dataDir), 'utf8')).toBe(renderIndex(index));
      // A rebuild with changed text replaces the artifact; nothing from the old one survives.
      book.write(12, CH13);
      const rebuilt = ensureIndex({ db: book.db, dataDir: book.dataDir });
      expect(rebuilt.manuscriptHash).not.toBe(index.manuscriptHash);
      expect(readFileSync(artifactPath(book.dataDir), 'utf8')).toBe(renderIndex(rebuilt));
      // Written as `*.tmp` then renamed: no half-file can be read, no temp survives.
      expect(existsSync(`${artifactPath(book.dataDir)}.tmp`)).toBe(false);
    } finally {
      book.close();
    }
  });

  it('treats a missing or corrupt artifact as absent, never as truth', () => {
    const book = rowBook({ 12: CH12 });
    try {
      expect(readIndex(book.dataDir)).toBeNull();
      mkdirSync(join(book.dataDir, 'index'), { recursive: true });
      writeFileSync(artifactPath(book.dataDir), '{not json', 'utf8');
      expect(readIndex(book.dataDir)).toBeNull();
      writeFileSync(artifactPath(book.dataDir), JSON.stringify({ version: 999, manuscriptHash: 'x', chapters: [] }), 'utf8');
      expect(readIndex(book.dataDir)).toBeNull();
    } finally {
      book.close();
    }
  });

  it('gives an editor a slice of the chapter and its neighbours, never the book', () => {
    const book = rowBook({ 12: CH12, 13: CH13 });
    try {
      const index = ensureIndex({ db: book.db, dataDir: book.dataDir });
      const path = ensureSlice({ db: book.db, dataDir: book.dataDir }, 12);
      expect(path).toBe(slicePath(book.dataDir, 12));
      const slice = JSON.parse(readFileSync(path ?? '', 'utf8')) as IndexSlice;
      expect(slice).toMatchObject({ chapter: 12, manuscriptHash: index.manuscriptHash });
      expect(slice.chapters.map((chapter) => chapter.n)).toEqual([11, 12, 13]);
      // The edges are clamped: chapter 1 has no chapter 0.
      expect(sliceOf(index, 1).chapters.map((chapter) => chapter.n)).toEqual([1, 2]);
      expect(sliceOf(index, TOTAL_CHAPTERS).chapters.map((chapter) => chapter.n)).toEqual([
        TOTAL_CHAPTERS - 1,
        TOTAL_CHAPTERS,
      ]);
    } finally {
      book.close();
    }
  });

  it('returns null instead of throwing when the slice cannot be written', () => {
    const book = rowBook({ 12: CH12 });
    try {
      mkdirSync(join(book.dataDir, 'index'), { recursive: true });
      writeFileSync(join(book.dataDir, 'index', 'slices'), 'a file where a directory must be', 'utf8');
      expect(ensureSlice({ db: book.db, dataDir: book.dataDir }, 12)).toBeNull();
      expect(ensureSlice({ db: book.db, dataDir: book.dataDir }, 0)).toBeNull();
      // The artifact itself is still written: only the slice was refused.
      expect(readIndex(book.dataDir)).not.toBeNull();
    } finally {
      book.close();
    }
  });

  it('still indexes a chapter from raw text (the chronicle compares two moments)', () => {
    expect(indexChapterText(12, CH12)).toMatchObject({ n: 12, written: true });
  });
});
