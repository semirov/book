import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { getChapterRow, listBlocks, listCatalog } from '../src/db/repo/chapters.ts';
import { listRevisions } from '../src/db/repo/revisions.ts';
import { parseChapter } from '../src/ingest/parseChapter.ts';
import { reconcile, rememberScan } from '../src/ingest/reconcile.ts';
import { StateService } from '../src/ingest/stateService.ts';
import { createFixture, longProse, type Fixture } from './helpers.ts';

const CHAPTER_ONE = longProse(['Первый абзац главы.']);
const CHAPTER_TWO = longProse(['Начало второй главы.']);

let fixture: Fixture | null = null;
afterEach(() => {
  fixture?.close();
  fixture = null;
});

describe('reconcile — empty manuscript', () => {
  it('boots with 67 unwritten slots and no error', () => {
    fixture = createFixture();
    const report = reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
    expect(report.scanned).toBe(0);
    expect(report.created).toEqual([]);
    expect(report.readErrors).toEqual([]);

    const catalog = listCatalog(fixture.db);
    expect(catalog).toHaveLength(67);
    expect(catalog.every((entry) => !entry.written && entry.rev === 0)).toBe(true);

    const state = new StateService(fixture.db).snapshot();
    expect(state.chapters.count).toBe(0);
    expect(state.chapters.empty).toHaveLength(67);
  });

  it('survives a missing manuscript directory', () => {
    fixture = createFixture();
    rmSync(fixture.manuscript, { recursive: true, force: true });
    const report = reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
    expect(report.scanned).toBe(0);
    expect(listCatalog(fixture.db)).toHaveLength(67);
  });
});

describe('reconcile — first sighting', () => {
  it('creates rev 1, blocks, a revision row and a snapshot', () => {
    fixture = createFixture({ 'ch01.md': CHAPTER_ONE });
    const report = reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });

    expect(report.created).toEqual([1]);
    const expected = parseChapter(1, CHAPTER_ONE);
    const row = getChapterRow(fixture.db, 1);
    expect(row).toMatchObject({ n: 1, rev: 1, block_count: expected.blocks.length });
    expect(row?.chars).toBe(expected.chars);

    const blocks = listBlocks(fixture.db, 1);
    expect(blocks).toHaveLength(expected.blocks.length);
    expect(blocks[0]).toMatchObject({ idx: 0, text: 'Первый абзац главы.', first_rev: 1, last_rev: 1 });

    const revisions = listRevisions(fixture.db, 1);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      kind: 'create',
      attributed: 0,
      cause_kind: 'local',
      added: expected.blocks.length,
    });
    expect(existsSync(join(fixture.dataDir, String(revisions[0]?.snapshot)))).toBe(true);
  });

  it('is idempotent: a second scan adds nothing', () => {
    fixture = createFixture({ 'ch01.md': CHAPTER_ONE });
    reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
    const second = reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
    expect(second.unchanged).toEqual([1]);
    expect(second.created).toEqual([]);
    expect(listRevisions(fixture.db, 1)).toHaveLength(1);
    expect(getChapterRow(fixture.db, 1)?.rev).toBe(1);
  });

  it('leaves a stray PLAN.md and an archive directory alone', () => {
    fixture = createFixture({ 'ch01.md': CHAPTER_ONE, 'PLAN.md': '# План 67 глав' });
    const report = reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
    expect(report.created).toEqual([1]);
    expect(report.ignored).toContain('PLAN.md');
    expect(listCatalog(fixture.db).filter((entry) => entry.written)).toHaveLength(1);
  });
});

describe('reconcile — a revision', () => {
  it('bumps rev, counts the diff and keeps first_rev of untouched blocks', () => {
    fixture = createFixture({ 'ch01.md': CHAPTER_ONE });
    reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
    const before = listBlocks(fixture.db, 1);

    const edited = CHAPTER_ONE.replace('Первый абзац главы.', 'Первый абзац главы, переписанный.');
    fixture.write('ch01.md', edited);
    const report = reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });

    expect(report.revised).toEqual([1]);
    const row = getChapterRow(fixture.db, 1);
    expect(row?.rev).toBe(2);

    const revisions = listRevisions(fixture.db, 1);
    expect(revisions).toHaveLength(2);
    expect(revisions[1]).toMatchObject({ rev: 2, kind: 'edit', changed: 1 });
    expect(existsSync(join(fixture.dataDir, String(revisions[1]?.snapshot)))).toBe(true);

    const after = listBlocks(fixture.db, 1);
    expect(after[0]?.text).toBe('Первый абзац главы, переписанный.');
    expect(after[1]?.id).toBe(before[1]?.id);
    expect(after[1]?.first_rev).toBe(1);
    expect(after[1]?.last_rev).toBe(2);
  });

  it('calls a wholesale replacement a rewrite', () => {
    fixture = createFixture({ 'ch01.md': CHAPTER_ONE });
    reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });

    const replacement = Array.from({ length: 40 }, (_, index) => `Другой абзац номер ${index + 1}. Слова, которых здесь раньше не было.`);
    fixture.write('ch01.md', replacement.join('\n\n'));
    reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
    const revisions = listRevisions(fixture.db, 1);
    expect(revisions[1]).toMatchObject({ rev: 2, kind: 'rewrite' });
  });
});

describe('reconcile — removal', () => {
  it('drops a chapter whose file disappeared, but keeps its snapshot', () => {
    fixture = createFixture({ 'ch01.md': CHAPTER_ONE, 'ch02.md': CHAPTER_TWO });
    reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
    const snapshot = listRevisions(fixture.db, 2)[0]?.snapshot as string;

    rmSync(join(fixture.manuscript, 'ch02.md'));
    const report = reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });

    expect(report.removed).toEqual([2]);
    expect(getChapterRow(fixture.db, 2)).toBeUndefined();
    expect(listBlocks(fixture.db, 2)).toEqual([]);
    expect(existsSync(join(fixture.dataDir, snapshot))).toBe(true);
  });
});

describe('state version', () => {
  it('does not bump when nothing changed, and bumps when a chapter appears', () => {
    fixture = createFixture();
    reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
    rememberScan(fixture.db, {
      scanned: 0,
      created: [],
      revised: [],
      unchanged: [],
      removed: [],
      ignored: [],
      readErrors: [],
      at: '2026-10-25T12:00:00Z',
    });

    const state = new StateService(fixture.db, () => new Date('2026-10-25T12:00:00Z'));
    const first = state.snapshot();
    const again = state.snapshot();
    expect(again.version).toBe(first.version);
    expect(again.at).toBe(first.at);

    fixture.write('ch01.md', CHAPTER_ONE);
    reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
    const afterWrite = state.snapshot();
    expect(afterWrite.version).toBe(first.version + 1);
    expect(afterWrite.chapters.written).toEqual([1]);
  });
});
