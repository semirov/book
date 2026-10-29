/**
 * `--revert --chapter N` (`docs/writer-lane.md` §5): undo the last change to a chapter.
 *
 * Since BOOK-187 the undo is a **new revision** with `cause_kind = 'restore'`, published by the
 * engine through the same applier every other write goes through (ADR-043 §3 row 9). The writer
 * writes no file at all, so what the test proves is the history: the revision the restore
 * brought back, the sha of that text, and the chapter reading it again.
 */

import { describe, expect, it } from 'vitest';

import { readSnapshot } from '../../src/versions/snapshots.ts';
import { sha256Hex } from '../../src/util/hash.ts';
import { revertChapter } from '../../src/writer/revert.ts';
import { chapterAnswer, createHarness, type Harness } from './harness.ts';

const CHAPTER = 40;

function revisions(harness: Harness): Array<{ rev: number; snapshot: string }> {
  return harness.fixture.db
    .prepare('SELECT rev, snapshot FROM revisions WHERE chapter = ? ORDER BY rev DESC')
    .all(CHAPTER) as Array<{ rev: number; snapshot: string }>;
}

/** What the chapter row says the site serves. */
function publishedSha(harness: Harness): string | undefined {
  const row = harness.fixture.db.prepare('SELECT sha256 FROM chapters WHERE n = ?').get(CHAPTER) as
    | { sha256: string }
    | undefined;
  return row?.sha256;
}

/** A landed change pass over a chapter that already had text: the base is revision 1. */
async function landedChange(harness: Harness, original: string): Promise<string> {
  expect(harness.fixture.readChapter(CHAPTER)).toBe(original);
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
  expect(harness.fixture.readChapter(CHAPTER)).toContain('новый');
  return result.stepId ?? '';
}

describe('revertChapter', () => {
  it('brings the previous revision back as a new revision, and the chapter reads it again', async () => {
    const original = chapterAnswer('Глава сорок', 'исходный');
    const harness = await createHarness({ chapters: { [CHAPTER]: original } });
    try {
      await landedChange(harness, original);

      const logs: string[] = [];
      const outcome = await revertChapter({
        chapter: CHAPTER,
        engine: harness.client,
        log: (line) => logs.push(line),
      });

      expect(outcome).toMatchObject({ status: 'reverted', source: 'site-history', verified: true });
      // The base was revision 1, the pass published 2, the restore published 3 and replaced 2.
      expect(outcome.previousRev).toBe(2);
      expect(outcome.rev).toBe(3);
      expect(outcome.sha).toBe(sha256Hex(original));
      expect(logs.join('\n')).toContain('новая ревизия 3 (было 2)');
      // The rows say the same thing the answer said.
      expect(harness.fixture.readChapter(CHAPTER)).toBe(original);
      const rows = revisions(harness);
      expect(rows.map((row) => row.rev)).toEqual([3, 2, 1]);
      // The newest snapshot is the restored text; the one before it is the pass's rewrite.
      expect(readSnapshot(harness.dataDir, rows[0]?.snapshot ?? '')).toBe(original);
      expect(readSnapshot(harness.dataDir, rows[1]?.snapshot ?? '')).not.toBe(original);
      expect(publishedSha(harness)).toBe(sha256Hex(original));

      // A restore is a revision with its own cause, never a rewritten timeline.
      const cause = harness.fixture.db
        .prepare('SELECT kind, cause_kind AS causeKind FROM revisions WHERE chapter = ? ORDER BY rev DESC LIMIT 1')
        .get(CHAPTER);
      expect(cause).toEqual({ kind: 'restore', causeKind: 'restore' });
    } finally {
      await harness.close();
    }
  });

  it('says there is nothing to go back to when the pass created the chapter', async () => {
    const harness = await createHarness();
    try {
      harness.script.push(chapterAnswer(), 'HOLDS', 'HOLDS');
      const result = await harness.run({ chapter: CHAPTER });
      expect(result.status).toBe('closed');
      expect(revisions(harness)).toHaveLength(1);

      const outcome = await revertChapter({ chapter: CHAPTER, engine: harness.client });
      expect(outcome.status).toBe('failed');
      expect(outcome.source).toBe('site-history');
      expect(outcome.reason).toContain('восстанавливать нечего');
      // Nothing was published: the chapter still reads the text the pass landed.
      expect(revisions(harness)).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it('says there is nothing to restore when the chapter was never written', async () => {
    const harness = await createHarness();
    try {
      const outcome = await revertChapter({ chapter: 12, engine: harness.client });
      expect(outcome.status).toBe('failed');
      expect(outcome.reason).toContain('восстанавливать нечего');
      expect(harness.fixture.readChapter(12)).toBeNull();
    } finally {
      await harness.close();
    }
  });

  it('returns the same chapter when the target revision is the one it already reads', async () => {
    const original = chapterAnswer('Глава сорок', 'исходный');
    const harness = await createHarness({ chapters: { [CHAPTER]: original } });
    try {
      // Revision 1 is both the newest and the target of a restore: nothing moves.
      const outcome = await revertChapter({ chapter: CHAPTER, engine: harness.client, rev: 1 });
      expect(outcome.status).toBe('nothing');
      expect(outcome.sha).toBe(sha256Hex(original));
      expect(revisions(harness)).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it('publishes nothing on a dry run and still says what it would do', async () => {
    const original = chapterAnswer('Глава сорок', 'исходный');
    const harness = await createHarness({ chapters: { [CHAPTER]: original } });
    try {
      await landedChange(harness, original);

      const outcome = await revertChapter({
        chapter: CHAPTER,
        engine: harness.client,
        dryRun: true,
      });
      expect(outcome.status).toBe('nothing');
      expect(outcome.reason).toContain('dry-run');
      expect(revisions(harness)).toHaveLength(2);
      expect(harness.fixture.readChapter(CHAPTER)).toContain('новый');
    } finally {
      await harness.close();
    }
  });
});
