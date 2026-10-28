/**
 * BOOK-187 follow-up — a revision the **applier** publishes is a revision the history can read.
 *
 * ADR-043 D5 makes the block checkpoint the ledger's boundary and forbids a second copy of each
 * paragraph. It said nothing about the chapter: until block order is a per-version fact
 * (BOOK-182), the only way to answer «what did chapter 12 look like at that moment» is the
 * content-addressed snapshot the ingest already wrote. The applier used to store `snapshot = ''`,
 * so `readRestoreSource`, `chapterAt` and every restore of an applier revision failed with
 * `SNAPSHOT_MISSING` — a history nobody could travel into.
 *
 * This file is both the proof and the standing invariant: every write path that inserts a
 * `revisions` row in a fixture that exercises all of them leaves a real, existing snapshot path.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.ts';
import { listBlocks } from '../../src/db/repo/chapters.ts';
import { restoreRevision } from '../../src/engine/restore.ts';
import { chapterAt } from '../../src/history/book.ts';
import { readRestoreSource } from '../../src/history/restore.ts';
import { applyPatch, revertRevision } from '../../src/ledger/applier.ts';
import { canonicalChapterText } from '../../src/ledger/patchCheck.ts';
import type { Fixture } from '../helpers.ts';
import { chapterFile, historyFixture, ingest } from './helpers.ts';

const T1 = new Date('2026-10-25T09:00:00Z');
const T2 = new Date('2026-10-25T10:00:00Z');
const T3 = new Date('2026-10-25T11:00:00Z');
const T4 = new Date('2026-10-25T12:00:00Z');

const FIRST =
  'Смотровая площадка стояла над рекой, и ветер гнал по ней сухую пыль. Внизу проходили баржи, и вода блестела под фонарями.';

let fixture: Fixture | null = null;

afterEach(() => {
  fixture?.close();
  fixture = null;
});

type RevisionRow = { rev: number; at: string; kind: string; snapshot: string; hseq: number | null };

function revisions(db: Fixture['db'], chapter: number): RevisionRow[] {
  return db
    .prepare('SELECT rev, at, kind, snapshot, hseq FROM revisions WHERE chapter = ? ORDER BY rev')
    .all(chapter) as RevisionRow[];
}

/** The chapter's canonical text as the rows hold it now (title line, blank line, blocks). */
function chapterText(db: Fixture['db'], chapter: number): string {
  const row = db.prepare('SELECT title FROM chapters WHERE n = ?').get(chapter) as { title: string | null };
  return canonicalChapterText(row.title, listBlocks(db, chapter).map((block) => block.text));
}

/** One operator patch of the chapter's first paragraph — the applier's own entry point. */
function patch(fixture: Fixture, oldText: string, newText: string, now: Date): void {
  const block = listBlocks(fixture.db, 12)[0];
  if (block === undefined) throw new Error('the chapter has no paragraph');
  const result = applyPatch({
    db: fixture.db,
    dataDir: fixture.dataDir,
    chapter: 12,
    patch: { mode: 'patch', edits: [{ blockId: block.id, oldText, newText }] },
    cause: { kind: 'operator', label: 'оператор' },
    nowMs: now.getTime(),
  });
  if (!result.ok) throw new Error(`the patch was refused: ${result.code}`);
}

describe('a revision the applier published carries a readable snapshot', () => {
  it('answers readRestoreSource, chapterAt and a restore of a mid-chain revision', () => {
    fixture = historyFixture();
    const { db, dataDir } = fixture;
    expect(ingest(fixture, 'ch12.md', chapterFile(12, [FIRST]), T1).created).toEqual([12]);
    patch(fixture, 'проходили', 'тянулись', T2);
    const textAfterSecond = chapterText(db, 12);
    const blocksAfterSecond = listBlocks(db, 12).map((block) => block.text);
    patch(fixture, 'блестела', 'горела', T3);

    const rows = revisions(db, 12);
    expect(rows.map((row) => row.rev)).toEqual([1, 2, 3]);
    // Both applier revisions carry a real path, each its own content-addressed file.
    for (const row of rows) {
      expect(row.snapshot).not.toBe('');
      expect(existsSync(join(dataDir, row.snapshot))).toBe(true);
    }
    expect(new Set(rows.map((row) => row.snapshot)).size).toBe(3);

    // The restore source is the text of that revision, not a refusal.
    const source = readRestoreSource(db, dataDir, 12, 2);
    expect(source).not.toBeNull();
    expect(source?.text).toBe(textAfterSecond);
    expect(source?.text).toContain('тянулись');
    expect(source?.text).not.toContain('горела');

    // Time travel to that moment returns the same paragraphs the snapshot holds.
    const atRev2 = chapterAt(db, dataDir, 12, rows[1]?.hseq ?? 0);
    expect(atRev2).not.toBeNull();
    expect(atRev2?.rev).toBe(2);
    expect(atRev2?.blocks.map((block) => block.text)).toEqual(blocksAfterSecond);

    // And the restore of a mid-chain **applier** revision works: a new revision, the old text.
    const deps = {
      db,
      config: loadConfig({ BOOK_ROOT: fixture.root, DATA_DIR: dataDir, PORT: '8080' }),
      bookRoot: fixture.root,
      clock: { now: () => T4.getTime() },
    };
    const restored = restoreRevision(deps, { chapter: 12, rev: 2, now: T4.getTime() });
    expect(restored.rev).toBe(4);
    expect(restored.previousRev).toBe(3);
    expect(chapterText(db, 12)).toBe(textAfterSecond);
    const restoreRow = revisions(db, 12)[3];
    expect(restoreRow?.kind).toBe('restore');
    expect(restoreRow?.snapshot).not.toBe('');
    expect(readFileSync(join(dataDir, restoreRow?.snapshot ?? ''), 'utf8')).toBe(textAfterSecond);
  });

  it('holds for a revision the revert path publishes, and for the whole fixture', () => {
    fixture = historyFixture();
    const { db, dataDir } = fixture;
    expect(ingest(fixture, 'ch12.md', chapterFile(12, [FIRST]), T1).created).toEqual([12]);
    patch(fixture, 'проходили', 'тянулись', T2);
    patch(fixture, 'блестела', 'горела', T3);

    // The second applier entry point: the undo of an applier revision goes through `applyPatch` too.
    const reverted = revertRevision({ db, dataDir, chapter: 12, rev: 3, nowMs: T4.getTime() });
    expect(reverted.ok).toBe(true);
    const rows = revisions(db, 12);
    const last = rows[rows.length - 1];
    expect(last?.rev).toBe(4);
    expect(last?.snapshot).not.toBe('');
    expect(existsSync(join(dataDir, last?.snapshot ?? ''))).toBe(true);
    // The undo's text is the pre-revert text: the snapshot describes it, so a restore of the undo
    // is possible in turn.
    expect(readRestoreSource(db, dataDir, 12, 4)?.text).toContain('блестела');
    expect(readRestoreSource(db, dataDir, 12, 4)?.text).not.toContain('горела');

    // The standing invariant: no revision of this book was ever published without a snapshot.
    const published = db.prepare(`SELECT COUNT(*) AS n FROM revisions WHERE snapshot = ''`).get() as { n: number };
    expect(published.n).toBe(0);
  });
});

describe('a revision with no readable snapshot', () => {
  it('answers null for a missing revision and for a lost file, never an invented text', () => {
    fixture = historyFixture();
    const { db } = fixture;
    expect(ingest(fixture, 'ch12.md', chapterFile(12, [FIRST]), T1).created).toEqual([12]);
    expect(readRestoreSource(db, fixture.dataDir, 12, 9)).toBeNull();
    expect(readRestoreSource(db, fixture.dataDir, 11, 1)).toBeNull();
    // A revision row whose file is gone (a lost volume, a deleted versions/ tree) is a null text,
    // not an invented one — the restore then refuses with SNAPSHOT_MISSING instead of publishing
    // a lookalike.
    expect(readRestoreSource(db, fixture.dataDir, 12, 1)?.text).toBe(chapterText(db, 12));
    expect(readRestoreSource(db, join(fixture.dataDir, 'gone'), 12, 1)).toBeNull();
  });
});
