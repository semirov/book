import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE } from '@book/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { getChapterRow, listBlocks, listCatalog } from '../src/db/repo/chapters.ts';
import { getFrontRow } from '../src/db/repo/front.ts';
import { listRevisions } from '../src/db/repo/revisions.ts';
import { parseChapter } from '../src/ingest/parseChapter.ts';
import { parseFront } from '../src/ingest/parseFront.ts';
import { reconcile, rememberScan } from '../src/ingest/reconcile.ts';
import { StateService } from '../src/ingest/stateService.ts';
import { sha256Hex } from '../src/util/hash.ts';
import { createFixture, longProse, withFrame, type Fixture } from './helpers.ts';

const CHAPTER_ONE = longProse(['Первый абзац главы.']);
const CHAPTER_TWO = longProse(['Начало второй главы.']);

const ABOUT =
  'Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги. Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги. Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги.';
const FRONT = `Без названия\n\n${ABOUT}\n`;

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
    expect(report.missing).toBe(true);
    expect(listCatalog(fixture.db)).toHaveLength(67);
  });

  it('keeps the last known text when the directory disappears (a bad mount, §6.2)', () => {
    fixture = createFixture({ 'ch01.md': CHAPTER_ONE, '00-front.md': FRONT });
    reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });

    rmSync(fixture.manuscript, { recursive: true, force: true });
    const report = reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
    expect(report.missing).toBe(true);
    expect(report.removed).toEqual([]);
    expect(getChapterRow(fixture.db, 1)).toBeDefined();
    expect(getFrontRow(fixture.db)).toBeDefined();
  });
});

describe('reconcile — first sighting', () => {
  it('creates rev 1, blocks, a revision row and a snapshot', () => {
    fixture = createFixture({ 'ch01.md': CHAPTER_ONE });
    const report = reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });

    expect(report.created).toEqual([1]);
    // BOOK-137: the fixture keeps the canon frame, so the file is `CHAPTER_ONE` plus it.
    const expected = parseChapter(1, withFrame(1, CHAPTER_ONE));
    const row = getChapterRow(fixture.db, 1);
    expect(row).toMatchObject({ n: 1, rev: 1, block_count: expected.blocks.length });
    expect(row?.chars).toBe(expected.chars);

    const blocks = listBlocks(fixture.db, 1);
    expect(blocks).toHaveLength(expected.blocks.length);
    expect(blocks[0]).toMatchObject({
      idx: 0,
      text: `${FRAME_FIRST_SENTENCE} Первый абзац главы.`,
      first_rev: 1,
      last_rev: 1,
    });

    const revisions = listRevisions(fixture.db, 1);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      kind: 'create',
      attributed: 0,
      cause_kind: 'draft',
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
    expect(after[0]?.text).toBe(`${FRAME_FIRST_SENTENCE} Первый абзац главы, переписанный.`);
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

describe('reconcile — a slot that holds only its basis sentence (BOOK-6)', () => {
  it('projects the basis sentence as one paragraph instead of keeping the old text', () => {
    fixture = createFixture({ 'ch01.md': CHAPTER_ONE, '00-front.md': FRONT });
    reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
    expect(getChapterRow(fixture.db, 1)?.block_count).toBeGreaterThan(0);

    fixture.write('ch01.md', FRAME_FIRST_SENTENCE);
    const report = reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });

    expect(report.emptied).toEqual([1]);
    expect(report.removed).toEqual([]);
    expect(getChapterRow(fixture.db, 1)).toMatchObject({ block_count: 1, chars: 0, title: null, basis: 1 });
    // The reader sees the frozen frame: one block, the sentence itself.
    expect(listBlocks(fixture.db, 1).map((block) => block.text)).toEqual([FRAME_FIRST_SENTENCE]);
    // The slot is unwritten in every projection: the catalog, the state and the reader default.
    expect(listCatalog(fixture.db)[0]).toMatchObject({ n: 1, written: false, basis: true, chars: 0, blocks: 1 });
    const state = new StateService(fixture.db).snapshot();
    expect(state.chapters.written).toEqual([]);
    expect(state.chapters.count).toBe(0);
    expect(state.chapters.totalChars).toBe(0);
    expect(state.chapters.empty).toHaveLength(67);

    // The history is not blanked: the old revisions are still there.
    expect(listRevisions(fixture.db, 1).length).toBeGreaterThan(0);
  });

  it('projects a basis-only file on its first sight, before any chapter existed', () => {
    fixture = createFixture({ 'ch67.md': FRAME_LAST_SENTENCE });
    const report = reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });

    expect(report.emptied).toEqual([67]);
    expect(report.created).toEqual([]);
    expect(getChapterRow(fixture.db, 67)).toMatchObject({ rev: 0, block_count: 1, chars: 0, basis: 1 });
    expect(listBlocks(fixture.db, 67).map((block) => block.text)).toEqual([FRAME_LAST_SENTENCE]);
    expect(listRevisions(fixture.db, 67)).toEqual([]);
    const state = new StateService(fixture.db).snapshot();
    expect(state.chapters.written).toEqual([]);
    expect(state.chapters.totalChars).toBe(0);
  });

  it('is idempotent: a second scan keeps exactly one block', () => {
    fixture = createFixture({ 'ch01.md': CHAPTER_ONE });
    reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
    fixture.write('ch01.md', FRAME_FIRST_SENTENCE);
    reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
    const before = getChapterRow(fixture.db, 1);

    const again = reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
    expect(again.emptied).toEqual([]);
    expect(again.unchanged).toEqual([1]);
    expect(getChapterRow(fixture.db, 1)).toEqual(before);
    expect(getChapterRow(fixture.db, 1)?.block_count).toBe(1);
    expect(listBlocks(fixture.db, 1)).toHaveLength(1);
  });

  it('heals a row left by the pre-BOOK-6 install: same sha, no blocks, no basis flag', () => {
    // The live install before this change: `blankChapter` stored the file's sha with
    // block_count = 0, and the new `basis` column defaults to 0 on migration. The fast path
    // must not call that "unchanged", or the two sentences would never appear.
    fixture = createFixture({ 'ch01.md': FRAME_FIRST_SENTENCE });
    const parsed = parseChapter(1, FRAME_FIRST_SENTENCE);
    fixture.db
      .prepare(
        `INSERT INTO chapters (n, rev, title, sha256, chars, block_count, basis, written_at, updated_at)
         VALUES (1, 4, NULL, ?, 0, 0, 0, '2026-10-20T09:00:00Z', '2026-10-20T09:00:00Z')`,
      )
      .run(parsed.sha256);

    const report = reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
    expect(report.emptied).toEqual([1]);
    expect(getChapterRow(fixture.db, 1)).toMatchObject({ rev: 4, block_count: 1, chars: 0, basis: 1 });
    expect(listBlocks(fixture.db, 1).map((block) => block.text)).toEqual([FRAME_FIRST_SENTENCE]);

    // And the second scan is a no-op.
    const again = reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
    expect(again.unchanged).toEqual([1]);
  });

  it('takes the empty book end to end: ch01 and ch67 hold one sentence each', () => {
    fixture = createFixture({ 'ch01.md': CHAPTER_ONE, 'ch67.md': CHAPTER_TWO, '00-front.md': FRONT });
    reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });

    fixture.write('ch01.md', FRAME_FIRST_SENTENCE);
    fixture.write('ch67.md', FRAME_LAST_SENTENCE);
    const report = reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
    expect(report.emptied).toEqual([1, 67]);

    const state = new StateService(fixture.db).snapshot();
    expect(state.chapters.written).toEqual([]);
    expect(state.chapters.count).toBe(0);
    expect(state.chapters.totalChars).toBe(0);
    expect(state.front.title).toBe('Без названия');
    expect(listBlocks(fixture.db, 1).map((block) => block.text)).toEqual([FRAME_FIRST_SENTENCE]);
    expect(listBlocks(fixture.db, 67).map((block) => block.text)).toEqual([FRAME_LAST_SENTENCE]);
  });

  it('still guards a zero-byte write: an empty file keeps the old text (§6.2)', () => {
    fixture = createFixture({ 'ch01.md': CHAPTER_ONE });
    reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });

    fixture.write('ch01.md', '');
    const report = reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
    expect(report.emptied).toEqual([]);
    expect(getChapterRow(fixture.db, 1)?.block_count).toBeGreaterThan(0);
    expect(getChapterRow(fixture.db, 1)?.basis).toBe(0);
  });

  it('returns a basis slot to prose when the writer fills it in', () => {
    fixture = createFixture({ 'ch01.md': FRAME_FIRST_SENTENCE });
    reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
    expect(getChapterRow(fixture.db, 1)).toMatchObject({ basis: 1, rev: 0 });

    fixture.write('ch01.md', CHAPTER_ONE);
    reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
    expect(getChapterRow(fixture.db, 1)).toMatchObject({ basis: 0, rev: 1, chars: parseChapter(1, withFrame(1, CHAPTER_ONE)).chars });
    expect(listCatalog(fixture.db)[0]).toMatchObject({ written: true, basis: false });
    expect(new StateService(fixture.db).snapshot().chapters.written).toEqual([1]);
  });
});

describe('reconcile — a moved frame publishes nothing (BOOK-137)', () => {
  it('reports the file, publishes no chapter from it, and still scans the rest of the book', () => {
    fixture = createFixture();
    // Raw bytes on purpose: the fixture's own write keeps the frame, and this test is the one
    // that must see what a weakened file does.
    writeFileSync(
      join(fixture.manuscript, 'ch01.md'),
      `${FRAME_FIRST_SENTENCE.replace('яркий', 'тусклый')}\n\nЯ постоял и вышел.\n`,
      'utf8',
    );
    writeFileSync(join(fixture.manuscript, 'ch02.md'), CHAPTER_TWO, 'utf8');

    const report = reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });

    // The boot goes on: the other chapter is published, and the refusal names ch01 only.
    expect(report.frameRejected).toEqual([1]);
    expect(report.created).toEqual([2]);
    expect(getChapterRow(fixture.db, 1)).toBeUndefined();
    expect(listRevisions(fixture.db, 1)).toEqual([]);
    expect(listCatalog(fixture.db)[0]).toMatchObject({ n: 1, written: false, rev: 0 });
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
      emptied: [],
      frameRejected: [],
      ignored: [],
      readErrors: [],
      front: 'missing',
      frontProblems: [],
      missing: false,
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

describe('reconcile — front matter', () => {
  it('projects the live title and page 2, with a content-addressed snapshot', () => {
    fixture = createFixture({ '00-front.md': FRONT });
    const report = reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });

    expect(report.front).toBe('created');
    expect(report.frontProblems).toEqual([]);
    expect(report.ignored).not.toContain('00-front.md');
    const row = getFrontRow(fixture.db);
    expect(row).toMatchObject({ id: 1, title: 'Без названия', about: ABOUT, rev: 1 });
    const expected = parseFront(FRONT);
    expect(row?.sha256).toBe(expected.sha256);
    expect(existsSync(join(fixture.dataDir, 'versions', 'front', `${expected.sha256}.md`))).toBe(true);
    expect(listCatalog(fixture.db).every((entry) => !entry.written)).toBe(true);
  });

  it('is idempotent: a second scan keeps rev 1', () => {
    fixture = createFixture({ '00-front.md': FRONT });
    reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
    const second = reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
    expect(second.front).toBe('unchanged');
    expect(getFrontRow(fixture.db)?.rev).toBe(1);
  });

  it('bumps rev when the title or the annotation changes', () => {
    fixture = createFixture({ '00-front.md': FRONT });
    reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
    fixture.write('00-front.md', FRONT.replace('Без названия', 'Другое название'));
    const report = reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
    expect(report.front).toBe('revised');
    expect(getFrontRow(fixture.db)).toMatchObject({
      title: 'Другое название',
      rev: 2,
    });
  });

  it('heals a live DB whose stored annotation differs from the file (BOOK-7)', () => {
    fixture = createFixture({ '00-front.md': FRONT });
    reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
    expect(getFrontRow(fixture.db)?.about).toBe(ABOUT);

    // The owner replaced page 2 by hand while the site was stopped; boot must follow the file.
    const ownerAbout = ABOUT.replace('Тестовая аннотация', 'Собственная аннотация');
    fixture.write('00-front.md', `Без названия\n\n${ownerAbout}\n`);
    const report = reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });

    expect(report.front).toBe('revised');
    expect(report.frontProblems).toEqual([]);
    expect(getFrontRow(fixture.db)).toMatchObject({
      title: 'Без названия',
      about: ownerAbout,
      about_sha256: sha256Hex(ownerAbout),
      rev: 2,
    });
    // And a second boot is idempotent: the healed projection matches the file.
    expect(reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir }).front).toBe('unchanged');
  });

  it('removes the first sheet when the file disappears and reports a missing one otherwise', () => {
    fixture = createFixture({ '00-front.md': FRONT });
    reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
    rmSync(join(fixture.manuscript, '00-front.md'));
    const report = reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
    expect(report.front).toBe('removed');
    expect(getFrontRow(fixture.db)).toBeUndefined();
    expect(reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir }).front).toBe('missing');
  });

  it('keeps the title and nulls page 2 when the annotation is malformed', () => {
    fixture = createFixture({ '00-front.md': 'Название\n\nСлишком коротко.' });
    const report = reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
    expect(report.front).toBe('created');
    expect(report.frontProblems.length).toBeGreaterThan(0);
    expect(getFrontRow(fixture.db)).toMatchObject({ title: 'Название', about: '' });
  });

  it('hides page 2 when the title line is malformed, even if the annotation reads well', () => {
    fixture = createFixture({ '00-front.md': `${'я'.repeat(81)}\n\n${ABOUT}` });
    reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
    expect(getFrontRow(fixture.db)).toMatchObject({ title: '', about: '' });
  });
});
