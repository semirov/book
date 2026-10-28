/**
 * BOOK-187 AC 10 — the four questions git used to answer, answered by rows.
 *
 * One fixture, one chapter written in three passes: **created** by the ingest, **rewritten** by a
 * second ingest (a whole-body rewrite: the applier computed the delta and says so), and **edited**
 * by the ledger (a real one-word patch with a span and a change). A tenth chapter is created
 * between the second and the third pass, because that is the anchor «restore chapter 12 as of the
 * reading of chapter 10» needs.
 *
 *   1. blame — which pass wrote this word, and whether the answer is an edit or a reconstruction;
 *   2. diff — what changed between two moments, with the text taken from rows;
 *   3. as-of — the revision of 12 at the moment 10 was created, and the restore that publishes it
 *      as a **new** revision;
 *   4. undo — the same restore path, with the old text still readable where it was.
 */

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { listBlocks } from '../../src/db/repo/chapters.ts';
import { restoreRevision } from '../../src/engine/restore.ts';
import { asOfReading } from '../../src/history/asOf.ts';
import { blame } from '../../src/history/blame.ts';
import { chapterAt } from '../../src/history/book.ts';
import { applyDelta, parseDeltaOps } from '../../src/history/delta.ts';
import { lastHseq } from '../../src/history/events.ts';
import { readDiff } from '../../src/history/query.ts';
import { StateService } from '../../src/ingest/stateService.ts';
import { applyPatch } from '../../src/ledger/applier.ts';
import { replayBlock } from '../../src/ledger/replay.ts';
import { cpOffsetOf } from '../../src/ledger/spans.ts';
import { isReadLimited } from '../../src/http/readLimit.ts';
import { readSnapshot } from '../../src/versions/snapshots.ts';
import type { Fixture } from '../helpers.ts';
import { chapterFile, historyFixture, ingest, seedChange } from './helpers.ts';
import { ledgerFixture, seedChapter, AT, type LedgerFixture } from '../ledger/helpers.ts';

/** The paragraph that carries all three passes. */
const FIRST_PASS =
  'Смотровая площадка стояла над рекой, и ветер гнал по ней сухую пыль. Внизу проходили баржи, и вода блестела под фонарями.';
/** The rewrite: the head is untouched, two words of the tail are not. */
const SECOND_PASS =
  'Смотровая площадка стояла над рекой, и ветер гнал по ней сухую пыль. Внизу тянулись баржи, и вода горела под фонарями.';
/** The one word the third pass edits, through a real span. */
const OLD_WORD = 'горела';
const NEW_WORD = 'светилась';

const T1 = new Date('2026-10-25T09:00:00Z');
const T2 = new Date('2026-10-25T10:00:00Z');
const T3 = new Date('2026-10-25T11:00:00Z');
const T4 = new Date('2026-10-25T12:00:00Z');
const T5 = new Date('2026-10-25T13:00:00Z');

type ThreePasses = {
  fixture: Fixture;
  deps: Parameters<typeof restoreRevision>[0];
  /** The paragraph's chain and the ids it carried after each pass. */
  blockUid: string;
  idAfterRewrite: string;
  idAfterEdit: string;
  created: { rev: number; hseq: number };
  rewrite: { rev: number; hseq: number };
  edit: { rev: number; hseq: number; changeId: string; stepId: string };
  /** The hseq at which chapter 10 came into being — the anchor of the as-of question. */
  readingHseq: number;
};

function revisionRow(db: Fixture['db'], chapter: number, rev: number): Record<string, string | number | null> {
  return db.prepare('SELECT * FROM revisions WHERE chapter = ? AND rev = ?').get(chapter, rev) as Record<
    string,
    string | number | null
  >;
}

function eventHseq(db: Fixture['db'], kind: string, chapter: number): number {
  return (db.prepare('SELECT MIN(hseq) AS hseq FROM events WHERE kind = ? AND chapter = ?').get(kind, chapter) as {
    hseq: number;
  }).hseq;
}

/** The paragraph that carries the three passes, after every pass. */
function liveText(db: Fixture['db'], chapter: number): { id: string; text: string } {
  const row = db
    .prepare('SELECT id, text FROM blocks WHERE chapter = ? ORDER BY idx LIMIT 1')
    .get(chapter) as { id: string; text: string };
  return row;
}

function threePasses(): ThreePasses {
  const fixture = historyFixture();
  const { db } = fixture;
  const chapter = 12;

  expect(ingest(fixture, 'ch12.md', chapterFile(chapter, [FIRST_PASS]), T1).created).toEqual([chapter]);
  expect(ingest(fixture, 'ch12.md', chapterFile(chapter, [SECOND_PASS]), T2).revised).toEqual([chapter]);
  expect(
    ingest(fixture, 'ch10.md', chapterFile(10, ['Десятая глава: якорь для вопроса «на момент чтения».']), T3).created,
  ).toEqual([10]);

  const seeded = seedChange(db, { index: 3, chapter });
  const before = liveText(db, chapter);
  const idAfterRewrite = before.id;
  const patched = applyPatch({
    db,
    dataDir: fixture.dataDir,
    chapter,
    patch: { mode: 'patch', edits: [{ blockId: idAfterRewrite, oldText: OLD_WORD, newText: NEW_WORD }] },
    cause: { kind: 'change', changeId: seeded.changeId, stepId: seeded.stepId },
    nowMs: T4.getTime(),
  });
  if (!patched.ok) throw new Error(`the third pass was refused: ${patched.code}`);

  const blockUid = (
    db.prepare('SELECT block_uid FROM block_versions WHERE block_id = ? ORDER BY ver DESC LIMIT 1').get(idAfterRewrite) as {
      block_uid: string;
    }
  ).block_uid;
  const created = revisionRow(db, chapter, 1);
  const rewrite = revisionRow(db, chapter, 2);
  const edit = revisionRow(db, chapter, 3);
  const deps = {
    db,
    config: loadConfig({ BOOK_ROOT: fixture.root, DATA_DIR: fixture.dataDir, PORT: '8080' }),
    bookRoot: fixture.root,
    clock: { now: () => T5.getTime() },
  };
  return {
    fixture,
    deps,
    blockUid,
    idAfterRewrite,
    idAfterEdit: liveText(db, chapter).id,
    created: { rev: 1, hseq: Number(created.hseq) },
    rewrite: { rev: 2, hseq: Number(rewrite.hseq) },
    edit: { rev: 3, hseq: Number(edit.hseq), changeId: seeded.changeId, stepId: seeded.stepId },
    readingHseq: eventHseq(db, 'chapter.created', 10),
  };
}

let fixture: Fixture | null = null;
let ledger: LedgerFixture | null = null;
let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
  fixture?.close();
  fixture = null;
  ledger?.close();
  ledger = null;
});

describe('1 — blame: which pass wrote this word (ADR-043 §4)', () => {
  it('names the third pass for the word it edited, and the first for a word nobody touched', () => {
    const passes = threePasses();
    fixture = passes.fixture;
    const { db } = fixture;
    const live = liveText(db, 12);
    expect(live.text).toContain(NEW_WORD);

    const edited = blame(db, 12, passes.blockUid, cpOffsetOf(live.text, live.text.indexOf(NEW_WORD)));
    expect(edited.reason).toBeNull();
    // The pass wrote this word itself: the revision, the moment, the change — and exact = 1.
    expect(edited.blame).toEqual({
      chapter: 12,
      blockUid: passes.blockUid,
      pos: cpOffsetOf(live.text, live.text.indexOf(NEW_WORD)),
      rev: passes.edit.rev,
      at: '2026-10-25T12:00:00Z',
      changeId: passes.edit.changeId,
      stepId: passes.edit.stepId,
      exact: 1,
    });

    // A word in the head of the paragraph: kept by the rewrite's diff, kept by the patch, so the
    // first pass wrote it — and it was written, not reconstructed.
    const untouched = blame(db, 12, passes.blockUid, cpOffsetOf(live.text, live.text.indexOf('площадка')));
    expect(untouched.blame?.rev).toBe(passes.created.rev);
    expect(untouched.blame?.exact).toBe(1);
    expect(untouched.blame?.at).toBe('2026-10-25T09:00:00Z');
  });

  it('recovers a rewritten word from the diff and says it is a reconstruction', () => {
    const passes = threePasses();
    fixture = passes.fixture;
    const live = liveText(fixture.db, 12);
    const start = cpOffsetOf(live.text, live.text.indexOf('тянулись'));
    const answers = Array.from({ length: 'тянулись'.length }, (_unused, index) =>
      blame(passes.fixture.db, 12, passes.blockUid, start + index),
    );
    // Somewhere in the replaced word the origin is the rewrite's computed diff (exact = 0)…
    expect(answers.some((answer) => answer.blame?.rev === passes.rewrite.rev && answer.blame?.exact === 0)).toBe(true);
    // …and nothing in it is attributed to the later patch: a diff never borrows a real edit.
    expect(answers.every((answer) => answer.blame !== null && answer.blame.rev !== passes.edit.rev)).toBe(true);
  });

  it('answers null with a reason instead of throwing', () => {
    const passes = threePasses();
    fixture = passes.fixture;
    expect(blame(fixture.db, 12, 'bkd_нет_такой', 0)).toEqual({ blame: null, reason: 'no-block' });
    expect(blame(fixture.db, 11, passes.blockUid, 0)).toEqual({ blame: null, reason: 'no-block' });
    expect(blame(fixture.db, 12, passes.blockUid, 100_000).reason).toBe('pos-out-of-range');
    expect(blame(fixture.db, 12, passes.blockUid, -1).reason).toBe('pos-out-of-range');
  });

  it('has no answer for a block whose history holds no delta', () => {
    ledger = ledgerFixture();
    const [first] = seedChapter(ledger.db, { chapter: 8, texts: ['Смотровая площадка стояла над рекой.'] });
    if (first === undefined) throw new Error('fixture did not seed a block');
    // The block exists and is live, but nothing records how its text was reached: a projection
    // written before the deltas existed. A named reason, not a guess and not a throw.
    expect(blame(ledger.db, 8, first.uid, 0)).toEqual({ blame: null, reason: 'no-deltas' });
  });

  it('has no answer for a paragraph that has left the chapter', () => {
    ledger = ledgerFixture();
    const { db } = ledger;
    const [first] = seedChapter(db, { chapter: 8, texts: ['Смотровая площадка стояла над рекой.'] });
    if (first === undefined) throw new Error('fixture did not seed a block');
    db.prepare(
      `INSERT INTO block_versions
         (block_uid, ver, chapter, rev, hseq, block_id, text_hash, chars, op, prev_ver, replaced_by,
          change_id, step_id, actor_kind, actor_label, identity_id, at, spans, text)
       VALUES (?, 2, 8, 2, 2, ?, ?, 36, 'erased', 1, NULL, NULL, NULL, 'unattributed', 'legacy', NULL, ?, '[]', '')`,
    ).run(first.uid, first.id, first.hash, AT);
    db.prepare('DELETE FROM blocks WHERE id = ?').run(first.id);
    // There is no live text to put an offset into: an erased paragraph is not one a reader can
    // point at, and the answer says so instead of blaming the wrong character.
    expect(blame(db, 8, first.uid, 0)).toEqual({ blame: null, reason: 'not-live' });
  });
});

describe('2 — diff: what changed between two moments (§6F.2)', () => {
  it('reports the replaced paragraph, and its text is the row text', () => {
    const passes = threePasses();
    fixture = passes.fixture;
    const { db } = fixture;
    const from = passes.readingHseq;
    const to = lastHseq(db);
    const diff = readDiff(db, from, to, 12);
    expect(diff.truncated).toBe(false);
    expect(diff.ops).toHaveLength(1);
    const op = diff.ops[0];
    expect(op?.op).toBe('replaced');
    expect(op?.blockId).toBe(passes.idAfterRewrite);
    expect(op?.replacedBy).toBe(passes.idAfterEdit);
    expect(op?.changeId).toBe(passes.edit.changeId);

    // The text a reader would be shown comes from the ledger, not from a snapshot file: the
    // rewrite's delta replays the earlier text, the patch's delta reproduces the live row.
    const earlier = replayBlock(db, { blockUid: passes.blockUid, ver: passes.rewrite.rev });
    expect(earlier?.text).toContain(OLD_WORD);
    const delta = db
      .prepare('SELECT ops FROM block_deltas WHERE block_uid = ? AND to_ver = ?')
      .get(passes.blockUid, passes.edit.rev) as { ops: string };
    const live = liveText(db, 12);
    expect(applyDelta(earlier?.text ?? '', parseDeltaOps(delta.ops))).toBe(live.text);
    expect(live.text).toContain(NEW_WORD);
  });

  it('answers 200 on the route, with the same operations', async () => {
    const passes = threePasses();
    fixture = passes.fixture;
    app = await buildApp({
      config: loadConfig({ BOOK_ROOT: fixture.root, DATA_DIR: fixture.dataDir, PORT: '8080' }),
      db: fixture.db,
      state: new StateService(fixture.db),
      version: 'test',
      logger: false,
    });
    const to = lastHseq(fixture.db);
    const response = await app.inject({
      method: 'GET',
      url: `/api/history/diff?chapter=12&before=${String(passes.readingHseq)}&at=${String(to)}`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { ops: Array<{ op: string; replacedBy: string | null }> };
    expect(body.ops).toHaveLength(1);
    expect(body.ops[0]?.op).toBe('replaced');
    expect(body.ops[0]?.replacedBy).toBe(passes.idAfterEdit);
  });
});

describe('3 — restore chapter 12 as of the reading of chapter 10 (ADR-043 §4)', () => {
  it('resolves the revision at the creation of chapter 10 and publishes it as a new one', () => {
    const passes = threePasses();
    fixture = passes.fixture;
    const { db } = fixture;
    // Chapter 10 was created after 12's second pass and before its third: the answer is rev 2.
    expect(passes.readingHseq).toBeGreaterThan(passes.rewrite.hseq);
    expect(passes.readingHseq).toBeLessThan(passes.edit.hseq);
    expect(asOfReading(db, 12, 10)).toEqual({ rev: 2, at: '2026-10-25T10:00:00Z' });

    const then = chapterAt(db, fixture.dataDir, 12, passes.readingHseq);
    expect(then).not.toBeNull();
    expect(then?.rev).toBe(2);

    const restored = restoreRevision(passes.deps, { chapter: 12, rev: 2, now: T5.getTime() });
    // A new revision, not a moved one: history is appended to.
    expect(restored.rev).toBe(4);
    expect(restored.previousRev).toBe(3);
    const row = revisionRow(db, 12, 4);
    expect(row.cause_kind).toBe('restore');
    expect(row.kind).toBe('restore');
    expect(row.at).toBe('2026-10-25T13:00:00Z');
    // The text a reader gets is the text of the moment chapter 10 was born — from rows.
    const live = listBlocks(db, 12).map((block) => block.text);
    expect(live).toEqual((then?.blocks ?? []).map((block) => block.text));
    expect(live[0]).not.toContain(NEW_WORD);
    // The third pass is still readable where it was: its version and its text are untouched, and
    // the diff across the restore is the reversal of the third pass (the paragraph's earlier id).
    expect(replayBlock(db, { blockUid: passes.blockUid, ver: passes.edit.rev })?.text).toContain(NEW_WORD);
    expect(revisionRow(db, 12, 3).hseq).toBe(passes.edit.hseq);
    const reversal = readDiff(db, passes.edit.hseq, Number(row.hseq), 12).ops;
    expect(reversal).toHaveLength(1);
    expect(reversal[0]?.blockId).toBe(passes.idAfterEdit);
    expect(reversal[0]?.replacedBy).toBe(passes.idAfterRewrite);
  });

  it('falls back to the reading chapter’s first revision, and answers null when there is none', () => {
    ledger = ledgerFixture();
    const { db } = ledger;
    db.prepare(
      `INSERT INTO chapters (n, rev, title, sha256, chars, block_count, basis, written_at, updated_at)
       VALUES (8, 2, 'Восьмая', 'sha8', 10, 0, 0, '2026-10-20T09:00:00Z', '2026-10-20T12:00:00Z'),
              (9, 1, 'Девятая', 'sha9', 10, 0, 0, '2026-10-20T10:00:00Z', '2026-10-20T10:00:00Z')`,
    ).run();
    const insert = db.prepare(
      `INSERT INTO revisions (chapter, rev, at, kind, cause_kind, change_id, cascade_id, step_id,
                              added, changed, removed, snapshot, attributed, hseq, log_note)
       VALUES (?, ?, ?, 'edit', 'operator', NULL, NULL, NULL, 0, 1, 0, '', 1, ?, NULL)`,
    );
    insert.run(8, 1, '2026-10-20T09:00:00Z', 4);
    insert.run(8, 2, '2026-10-20T12:00:00Z', 9);
    insert.run(9, 1, '2026-10-20T10:00:00Z', 6);

    // No `chapter.created` row for 9 (a book seeded before the log): the anchor is its first revision.
    expect(asOfReading(db, 8, 9)).toEqual({ rev: 1, at: '2026-10-20T09:00:00Z' });
    // Nothing at all: the question has no answer, and says so.
    expect(asOfReading(db, 8, 7)).toBeNull();
    // A chapter that did not exist yet at that moment has no revision to name.
    expect(asOfReading(db, 7, 9)).toBeNull();
  });
});

describe('4 — undo: the last change is undone by a new revision (§13.3)', () => {
  it('publishes the earlier text as a new revision and keeps the old one readable', () => {
    const passes = threePasses();
    fixture = passes.fixture;
    const { db } = fixture;
    // Undo the last change (the third pass) without naming a revision.
    const undo = restoreRevision(passes.deps, { chapter: 12, now: T5.getTime() });
    expect(undo.rev).toBe(4);
    expect(undo.previousRev).toBe(3);
    const row = revisionRow(db, 12, 4);
    expect(row.cause_kind).toBe('restore');
    // The restored text is the second pass's text — the same snapshot, not a lookalike.
    expect(readSnapshot(fixture.dataDir, String(row.snapshot))).toBe(
      readSnapshot(fixture.dataDir, String(revisionRow(db, 12, 2).snapshot)),
    );
    expect(readSnapshot(fixture.dataDir, String(row.snapshot))).not.toContain(NEW_WORD);
    // The revision the undo replaced is still there, with its own text in its own rows.
    expect(revisionRow(db, 12, 3).hseq).toBe(passes.edit.hseq);
    expect(replayBlock(db, { blockUid: passes.blockUid, ver: 3 })?.text).toContain(NEW_WORD);

    // The diff across the undo is the reversal: the paragraph returns to the id it had before the
    // third pass, so «что изменилось» reads as the exact opposite of the change it undid.
    const diff = readDiff(db, passes.edit.hseq, Number(row.hseq), 12);
    expect(diff.ops).toHaveLength(1);
    expect(diff.ops[0]?.op).toBe('replaced');
    expect(diff.ops[0]?.blockId).toBe(passes.idAfterEdit);
    expect(diff.ops[0]?.replacedBy).toBe(passes.idAfterRewrite);
    // Nothing changed after the undo: the reversal is the whole story.
    expect(readDiff(db, Number(row.hseq), lastHseq(db), 12).ops).toHaveLength(0);
  });
});

describe('the blame route (§6F.2, §14)', () => {
  async function boot(passes: ThreePasses): Promise<FastifyInstance> {
    return buildApp({
      config: loadConfig({ BOOK_ROOT: passes.fixture.root, DATA_DIR: passes.fixture.dataDir, PORT: '8080' }),
      db: passes.fixture.db,
      state: new StateService(passes.fixture.db),
      version: 'test',
      logger: false,
    });
  }

  it('serves the origin of a code point, and a 404 for an unknown paragraph', async () => {
    const passes = threePasses();
    fixture = passes.fixture;
    app = await boot(passes);
    const live = liveText(fixture.db, 12);
    const pos = cpOffsetOf(live.text, live.text.indexOf(NEW_WORD));
    const response = await app.inject({
      method: 'GET',
      url: `/api/history/blame?chapter=12&blockUid=${passes.blockUid}&pos=${String(pos)}`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { blame: { rev: number; changeId: string; exact: number } | null; reason: null };
    expect(body.reason).toBeNull();
    expect(body.blame?.rev).toBe(passes.edit.rev);
    expect(body.blame?.changeId).toBe(passes.edit.changeId);
    expect(body.blame?.exact).toBe(1);

    // The same read budget as every other history route (§14): one prefix, no second budget.
    expect(isReadLimited(`/api/history/blame?chapter=12&blockUid=${passes.blockUid}&pos=0`)).toBe(true);

    const unknown = await app.inject({
      method: 'GET',
      url: '/api/history/blame?chapter=12&blockUid=bkd_none&pos=0',
    });
    expect(unknown.statusCode).toBe(404);
    expect((unknown.json() as { code: string }).code).toBe('NOT_FOUND');
  });

  it('refuses parameters that are not a blame question', async () => {
    const passes = threePasses();
    fixture = passes.fixture;
    app = await boot(passes);
    const urls = [
      '/api/history/blame?chapter=12&blockUid=x',
      '/api/history/blame?chapter=12&blockUid=&pos=0',
      '/api/history/blame?chapter=0&blockUid=x&pos=0',
      '/api/history/blame?chapter=999&blockUid=x&pos=0',
      '/api/history/blame?chapter=12&blockUid=x&pos=-1',
      '/api/history/blame?chapter=12&blockUid=x&pos=1.5',
    ];
    for (const url of urls) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(400);
    }
  });
});
