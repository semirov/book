import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TOTAL_CHAPTERS } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { buildIndex, indexChapterText } from '../../src/index/build.ts';
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

function fixture(files: Record<string, string>): { root: string; dataDir: string; close: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'book-index-root-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'book-index-data-'));
  mkdirSync(join(root, 'manuscript'), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, 'manuscript', name), text, 'utf8');
  return {
    root,
    dataDir,
    close: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

const CH12 = 'Глава двенадцатая\n\nИнженер Ковалёв вошёл в комнату. Приказ № 4 выдан утром.\n';
const CH13 = 'Глава тринадцатая\n\nКовалёв обещал вернуться через два дня.\n';

describe('building the derived index (BOOK-18 §1)', () => {
  it('covers every slot in order and hashes only text and version', () => {
    const book = fixture({ 'ch12.md': CH12, 'ch13.md': CH13 });
    try {
      const index = buildIndex(book.root);
      expect(index.chapters).toHaveLength(TOTAL_CHAPTERS);
      expect(index.chapters.map((chapter) => chapter.n)).toEqual([...Array(TOTAL_CHAPTERS)].map((_, i) => i + 1));
      expect(index.chapters.find((chapter) => chapter.n === 12)?.documents).toHaveLength(1);
      expect(index.chapters.find((chapter) => chapter.n === 11)).toMatchObject({ written: false, entities: [] });
      expect(index.manuscriptHash).toMatch(/^[0-9a-f]{64}$/u);
    } finally {
      book.close();
    }
  });

  it('is reproducible: a rebuild over identical bytes is identical, hash included', () => {
    const book = fixture({ 'ch12.md': CH12, 'ch13.md': CH13 });
    try {
      const first = buildIndex(book.root);
      const second = buildIndex(book.root);
      expect(renderIndex(second)).toBe(renderIndex(first));
      expect(second.manuscriptHash).toBe(first.manuscriptHash);
    } finally {
      book.close();
    }
  });

  it('reuses the untouched chapters’ facts after a one-chapter rewrite (memoised extraction)', () => {
    const book = fixture({ 'ch12.md': CH12, 'ch13.md': CH13 });
    try {
      const first = buildIndex(book.root);
      writeFileSync(join(book.root, 'manuscript', 'ch12.md'), CH13.replaceAll('тринадцатая', 'двенадцатая'), 'utf8');
      const second = buildIndex(book.root);
      expect(second.chapters.filter((chapter) => chapter.n !== 12)).toEqual(
        first.chapters.filter((chapter) => chapter.n !== 12),
      );
      expect(second.chapters.find((chapter) => chapter.n === 12)).not.toEqual(
        first.chapters.find((chapter) => chapter.n === 12),
      );
    } finally {
      book.close();
    }
  });

  it('changes the hash when one chapter changes, and not when nothing is written', () => {
    const book = fixture({ 'ch12.md': CH12 });
    try {
      const before = buildIndex(book.root);
      // Rewriting the same bytes is not a change.
      writeFileSync(join(book.root, 'manuscript', 'ch12.md'), CH12, 'utf8');
      expect(buildIndex(book.root).manuscriptHash).toBe(before.manuscriptHash);
      writeFileSync(join(book.root, 'manuscript', 'ch12.md'), CH13, 'utf8');
      expect(buildIndex(book.root).manuscriptHash).not.toBe(before.manuscriptHash);
    } finally {
      book.close();
    }
  });
});

describe('storing the index (BOOK-18 §1, §2)', () => {
  it('writes one artifact and replaces it wholesale on rebuild', () => {
    const book = fixture({ 'ch12.md': CH12 });
    try {
      const index = ensureIndex({ bookRoot: book.root, dataDir: book.dataDir });
      const stored = readIndex(book.dataDir);
      expect(stored?.manuscriptHash).toBe(index.manuscriptHash);
      expect(readFileSync(artifactPath(book.dataDir), 'utf8')).toBe(renderIndex(index));
      // A rebuild with changed text replaces the artifact; nothing from the old one survives.
      writeFileSync(join(book.root, 'manuscript', 'ch12.md'), CH13, 'utf8');
      const rebuilt = ensureIndex({ bookRoot: book.root, dataDir: book.dataDir });
      expect(rebuilt.manuscriptHash).not.toBe(index.manuscriptHash);
      expect(readFileSync(artifactPath(book.dataDir), 'utf8')).toBe(renderIndex(rebuilt));
      // Written as `*.tmp` then renamed: no half-file can be read, no temp survives.
      expect(existsSync(`${artifactPath(book.dataDir)}.tmp`)).toBe(false);
    } finally {
      book.close();
    }
  });

  it('treats a missing or corrupt artifact as absent, never as truth', () => {
    const book = fixture({ 'ch12.md': CH12 });
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
    const book = fixture({ 'ch12.md': CH12, 'ch13.md': CH13 });
    try {
      const index = ensureIndex({ bookRoot: book.root, dataDir: book.dataDir });
      const path = ensureSlice({ bookRoot: book.root, dataDir: book.dataDir }, 12);
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
    const book = fixture({ 'ch12.md': CH12 });
    try {
      mkdirSync(join(book.dataDir, 'index'), { recursive: true });
      writeFileSync(join(book.dataDir, 'index', 'slices'), 'a file where a directory must be', 'utf8');
      expect(ensureSlice({ bookRoot: book.root, dataDir: book.dataDir }, 12)).toBeNull();
      expect(ensureSlice({ bookRoot: book.root, dataDir: book.dataDir }, 0)).toBeNull();
      // The artifact itself is still written: only the slice was refused.
      expect(readIndex(book.dataDir)).not.toBeNull();
    } finally {
      book.close();
    }
  });

  it('indexes a chapter from its file text with the projection’s own hash', () => {
    expect(indexChapterText(12, CH12)).toMatchObject({ n: 12, written: true });
  });
});
