/**
 * `--revert --chapter N` (`docs/writer-lane.md` §5): the chapter goes back to what the pass found.
 *
 * Two pre-images, in order: the writer's own snapshot (text or "the slot was empty"), then the
 * site's history — the revision before the current one, copied out of the content-addressed
 * store. Each case is checked byte for byte: a revert nobody verified is a claim, not a fact.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { removeChapter } from '../../src/ingest/applyChapter.ts';
import { readSnapshot } from '../../src/versions/snapshots.ts';
import { revertChapter } from '../../src/writer/revert.ts';
import { sha256Hex } from '../../src/util/hash.ts';
import { chapterAnswer, chapterRow, createHarness, type Harness } from './harness.ts';

const CHAPTER = 40;

function chapterFile(harness: Harness): string {
  return join(harness.bookRoot, 'manuscript', `ch${String(CHAPTER)}.md`);
}

function revisions(harness: Harness): Array<{ rev: number; snapshot: string }> {
  return harness.fixture.db
    .prepare('SELECT rev, snapshot FROM revisions WHERE chapter = ? ORDER BY rev DESC')
    .all(CHAPTER) as Array<{ rev: number; snapshot: string }>;
}

/** A landed change pass over a chapter that already had text. */
async function landedChange(harness: Harness, original: string): Promise<string> {
  expect(harness.fixture.readChapter(CHAPTER)).toBe(original);
  // The site has seen the base: a chapter written before the lane has its own revision.
  harness.ingest(CHAPTER);
  harness.fixture.engine.enqueue({
    kind: 'operator',
    chapter: CHAPTER,
    intent: 'в главе 40 появляется документ о допуске',
    // BOOK-173: this pass tests a landing/revert, so it says it is a whole-chapter change —
    // a phrase-scope filing on a written chapter now takes the patch path instead.
    scopeHint: 'chapter',
  });
  harness.script.push(chapterAnswer('Глава сорок', 'новый'), 'HOLDS', 'HOLDS');
  const result = await harness.run({ lanes: ['fwd'] });
  expect(result.status).toBe('closed');
  expect(readFileSync(chapterFile(harness), 'utf8')).toContain('новый');
  return result.stepId ?? '';
}

describe('revertChapter', () => {
  it('puts an existing chapter back byte for byte from the writer’s pre-snapshot', async () => {
    const original = chapterAnswer('Глава сорок', 'исходный');
    const harness = await createHarness({ chapters: { [CHAPTER]: original } });
    try {
      await landedChange(harness, original);

      const logs: string[] = [];
      const outcome = await revertChapter({
        chapter: CHAPTER,
        bookRoot: harness.bookRoot,
        dataDir: harness.dataDir,
        engine: harness.client,
        log: (line) => logs.push(line),
      });

      expect(outcome).toMatchObject({ status: 'reverted', source: 'writer-pre', verified: true });
      expect(outcome.snapshotSha).toBe(sha256Hex(original));
      expect(outcome.fileSha).toBe(sha256Hex(original));
      expect(readFileSync(chapterFile(harness), 'utf8')).toBe(original);
      // The restore is published without gates; the operator's mark could not run yet (the site
      // has not observed the write in a fixture), and that is reported, not hidden.
      expect(outcome.reconciled).toBe(false);
      expect(logs.join('\n')).toContain('совпадает');

      // The site's own history keeps both revisions: the pass's text, and the base before it.
      const rows = revisions(harness);
      expect(rows).toHaveLength(2);
      expect(readSnapshot(harness.dataDir, rows[0]?.snapshot ?? '')).toContain('новый');
      expect(readSnapshot(harness.dataDir, rows[1]?.snapshot ?? '')).toBe(original);
    } finally {
      await harness.close();
    }
  });

  it('removes a chapter the pass created — and the site publishes the slot as empty', async () => {
    const harness = await createHarness();
    try {
      harness.script.push(chapterAnswer(), 'HOLDS', 'HOLDS');
      const result = await harness.run({ chapter: CHAPTER });
      expect(result.status).toBe('closed');
      expect(existsSync(chapterFile(harness))).toBe(true);
      expect(chapterRow(harness.fixture, CHAPTER)).toBeDefined();

      const outcome = await revertChapter({
        chapter: CHAPTER,
        bookRoot: harness.bookRoot,
        dataDir: harness.dataDir,
        engine: harness.client,
      });
      expect(outcome).toMatchObject({ status: 'reverted', source: 'writer-pre', verified: true, snapshotSha: null });
      expect(outcome.fileSha).toBeNull();
      expect(existsSync(chapterFile(harness))).toBe(false);

      // The site's watcher is what publishes a deleted file (`removeChapter`, §6F); the file is
      // already gone, so the slot stops having a row.
      removeChapter(harness.fixture.db, CHAPTER);
      expect(chapterRow(harness.fixture, CHAPTER)).toBeUndefined();
    } finally {
      await harness.close();
    }
  });

  it('falls back to the previous revision when the writer left no pre-snapshot', async () => {
    const original = chapterAnswer('Глава сорок', 'исходный');
    const harness = await createHarness({ chapters: { [CHAPTER]: original } });
    try {
      await landedChange(harness, original);
      const passed = readFileSync(chapterFile(harness), 'utf8');
      // A pass from before this lane, or a snapshot cleaned by hand: only the site's history is left.
      rmSync(join(harness.dataDir, 'writer', 'pre'), { recursive: true, force: true });
      expect(existsSync(join(harness.dataDir, 'writer', 'pre', 'ch40.json'))).toBe(false);

      const outcome = await revertChapter({
        chapter: CHAPTER,
        bookRoot: harness.bookRoot,
        dataDir: harness.dataDir,
        engine: harness.client,
      });

      expect(outcome).toMatchObject({ status: 'reverted', source: 'site-history', verified: true });
      expect(outcome.snapshotSha).toBe(sha256Hex(original));
      expect(outcome.fileSha).toBe(sha256Hex(original));
      expect(readFileSync(chapterFile(harness), 'utf8')).toBe(original);
      expect(readFileSync(chapterFile(harness), 'utf8')).not.toBe(passed);
    } finally {
      await harness.close();
    }
  });

  it('says there is nothing to restore instead of pretending it reverted', async () => {
    const harness = await createHarness();
    try {
      const outcome = await revertChapter({
        chapter: 12,
        bookRoot: harness.bookRoot,
        dataDir: harness.dataDir,
        engine: harness.client,
      });
      expect(outcome.status).toBe('failed');
      expect(outcome.reason).toContain('восстанавливать нечего');
      expect(existsSync(join(harness.bookRoot, 'manuscript', 'ch12.md'))).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it('leaves the file alone on a dry run and still reports what it would do', async () => {
    const original = chapterAnswer('Глава сорок', 'исходный');
    const harness = await createHarness({ chapters: { [CHAPTER]: original } });
    try {
      await landedChange(harness, original);
      const passed = readFileSync(chapterFile(harness), 'utf8');

      const outcome = await revertChapter({
        chapter: CHAPTER,
        bookRoot: harness.bookRoot,
        dataDir: harness.dataDir,
        engine: harness.client,
        dryRun: true,
      });
      expect(outcome.status).toBe('nothing');
      expect(outcome.reason).toContain('dry-run');
      expect(readFileSync(chapterFile(harness), 'utf8')).toBe(passed);
      expect(outcome.snapshotSha).toBe(sha256Hex(original));
    } finally {
      await harness.close();
    }
  });
});

