import { afterEach, describe, expect, it } from 'vitest';

import type { Db } from '../src/db/db.ts';
import { canonicalChapterRaw } from '../src/engine/text.ts';
import { assertChapter1Kept, readChapter1 } from '../src/reset/chapter1.ts';
import { sha256Hex } from '../src/util/hash.ts';
import { count } from './resetSeed.ts';
import { createResetHarness } from './resetApp.ts';

/**
 * BOOK-202 — the launch reset keeps chapter 1 whole (owner, 2026-10-29).
 *
 * The rest of the wipe is asserted in `adminReset.test.ts`; this suite is the one rule the owner
 * added: ch01's `chapters` row, its blocks, its live sentences, its revision/version/lineage
 * keys and its corner of the graph come out of the wipe **byte-identical**, while every other
 * chapter goes exactly as it did. The fixture's ch01 is a written chapter (`resetSeed.ts`), so
 * «kept» means prose the reader can still open, not a frame sentence.
 *
 * The snapshot below is assembled here, with plain SQL and the shared canonical assembly, and
 * never by the module under test — otherwise the test would only prove the code agrees with
 * itself.
 */

const h = createResetHarness();

afterEach(async () => {
  await h.close();
});

type Row = Record<string, unknown>;
type Block = { id: string; chapter: number; idx: number; text: string; hash: string; first_rev: number; last_rev: number };
type Sentence = { id: string; block_id: string; idx: number; start: number; end: number; text_hash: string };

function snapshot(db: Db): {
  chapter: Row | undefined;
  blocks: Block[];
  sentences: Sentence[];
  revisions: string[];
  blockVersions: string[];
  blockLineage: string[];
} {
  const chapter = db.prepare('SELECT * FROM chapters WHERE n = 1').get() as Row | undefined;
  const blocks = db.prepare('SELECT * FROM blocks WHERE chapter = 1 ORDER BY idx').all() as Block[];
  const ids = blocks.map((block) => block.id);
  const sentences =
    ids.length === 0
      ? []
      : (db
          .prepare(
            `SELECT id, block_id, idx, start, end, text_hash FROM sentences
              WHERE erased_at IS NULL AND block_id IN (${ids.map(() => '?').join(', ')})
              ORDER BY block_id, idx`,
          )
          .all(...ids) as Sentence[]);
  return {
    chapter,
    blocks,
    sentences,
    revisions: (
      db.prepare(`SELECT chapter || ':' || rev AS k FROM revisions WHERE chapter = 1 ORDER BY rev`).all() as Array<{
        k: string;
      }>
    ).map((row) => row.k),
    blockVersions: (
      db
        .prepare(`SELECT block_uid || ':' || ver AS k FROM block_versions WHERE chapter = 1 ORDER BY block_uid, ver`)
        .all() as Array<{ k: string }>
    ).map((row) => row.k),
    blockLineage: (
      db.prepare('SELECT block_id AS k FROM block_lineage WHERE chapter = 1 ORDER BY block_id').all() as Array<{
        k: string;
      }>
    ).map((row) => row.k),
  };
}

/** The digest of the canonical text ch01's rows hold — assembled here, not by `reset/chapter1.ts`. */
function shaOf(state: { chapter: Row | undefined; blocks: Block[] }): string {
  if (state.chapter === undefined) return sha256Hex('');
  return sha256Hex(canonicalChapterRaw((state.chapter.title as string | null) ?? null, state.blocks));
}

function charsOf(db: Db): number {
  return count(db, 'SELECT COALESCE(SUM(LENGTH(text)), 0) AS n FROM blocks WHERE chapter = 1');
}

describe('BOOK-202 — chapter 1 survives the wipe', () => {
  it('reports ch01 from its rows on a dry run, and excludes it from the wiped counters', async () => {
    const target = await h.live();
    const db = target.db;
    const before = snapshot(db);
    expect(before.chapter).toBeDefined();
    expect(before.blocks.length).toBeGreaterThan(1);
    expect(before.sentences.length).toBeGreaterThan(0);

    const response = await h.call({ dryRun: true });
    expect(response.statusCode).toBe(200);
    const body = response.json();

    // The report is the fixture's own numbers: blocks, live sentences, characters, digest.
    expect(body.chapter1).toEqual({
      chapter: 1,
      blocks: before.blocks.length,
      sentences: before.sentences.length,
      chars: charsOf(db),
      sha256Before: shaOf(before),
      // A dry run writes nothing, so the digest after the wipe is the digest before it.
      sha256After: shaOf(before),
    });

    // The counters count what the wipe removes; ch01's rows are not in them.
    const rows = Object.fromEntries((body.tables as Array<{ key: string; rows: number }>).map((e) => [e.key, e.rows]));
    expect(rows.chapters).toBe(count(db, 'SELECT COUNT(*) AS n FROM chapters WHERE basis = 0 AND n <> 1'));
    expect(rows.revisions).toBe(count(db, 'SELECT COUNT(*) AS n FROM revisions WHERE chapter <> 1'));
    expect(rows.block_versions).toBe(count(db, 'SELECT COUNT(*) AS n FROM block_versions WHERE chapter <> 1'));
    expect(rows.block_lineage).toBe(count(db, 'SELECT COUNT(*) AS n FROM block_lineage WHERE chapter <> 1'));
    expect(rows.blocks).toBe(
      count(
        db,
        `SELECT COUNT(*) AS n FROM blocks JOIN chapters AS c ON c.n = blocks.chapter
          WHERE c.basis = 0 AND c.n <> 1`,
      ),
    );
    expect(rows.sentences).toBe(
      count(
        db,
        `SELECT COUNT(*) AS n FROM sentences s
           JOIN blocks b ON b.id = s.block_id
           JOIN chapters c ON c.n = b.chapter
          WHERE c.basis = 0 AND c.n <> 1`,
      ),
    );
    // The content the wipe removes is the same book: ch01 is not one of its chapters.
    expect(body.content).toEqual({
      written: 1,
      chars: count(db, 'SELECT COALESCE(SUM(chars), 0) AS n FROM chapters WHERE basis = 0 AND n <> 1'),
      blocks: count(db, 'SELECT COUNT(*) AS n FROM blocks WHERE chapter <> 1'),
    });

    // Nothing was written: the rows are exactly what they were.
    expect(snapshot(db)).toEqual(before);
  });

  it('leaves ch01 byte-identical after a real wipe, and answers with the same digest', async () => {
    const target = await h.live();
    const db = target.db;
    const dry = (await h.call({ dryRun: true })).json();
    const before = snapshot(db);

    const done = (await h.call({ dryRun: false })).json();
    // The two reports agree on everything that describes ch01 — the dry run did not lie.
    expect(done.chapter1).toMatchObject({
      blocks: dry.chapter1.blocks,
      sentences: dry.chapter1.sentences,
      chars: dry.chapter1.chars,
      sha256Before: dry.chapter1.sha256Before,
    });
    expect(done.chapter1.sha256After).toBe(done.chapter1.sha256Before);

    // The row-level proof: the chapter row, every block column, the live sentences, and the
    // key sets of the histories are the ones the book held before the wipe.
    const after = snapshot(db);
    expect(after.chapter).toEqual(before.chapter);
    expect(after.blocks).toEqual(before.blocks);
    expect(after.sentences).toEqual(before.sentences);
    expect(after.revisions).toEqual(before.revisions);
    expect(after.blockVersions).toEqual(before.blockVersions);
    expect(after.blockLineage).toEqual(before.blockLineage);
    // The digest the answer carries is the sha of the canonical text the rows now hold.
    expect(shaOf(after)).toBe(done.chapter1.sha256After);

    // The rest of the book is gone: ch08 has no row, the finale is the frozen basis slot.
    expect(count(db, 'SELECT COUNT(*) AS n FROM chapters WHERE n = 8')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM chapters WHERE n = 42 AND basis = 1')).toBe(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('is idempotent: a second reset leaves ch01 as the first one did and removes nothing', async () => {
    const target = await h.live();
    const db = target.db;
    const first = (await h.call({ dryRun: false })).json();
    const afterFirst = snapshot(db);

    const second = (await h.call({ dryRun: false })).json();
    expect(second.total).toBe(0);
    expect(second.chapter1).toEqual(first.chapter1);
    expect(snapshot(db)).toEqual(afterFirst);
    expect(shaOf(snapshot(db))).toBe(first.chapter1.sha256After);
    // Nothing was fabricated for the kept chapter: the second run opened no step and no lease.
    expect(count(db, 'SELECT COUNT(*) AS n FROM steps')).toBe(0);
  });

  it('keeps ch01’s graph and removes ch08’s to the last row', async () => {
    const target = await h.live();
    const db = target.db;
    const firstBlock = db.prepare('SELECT id, text FROM blocks WHERE chapter = 1 ORDER BY idx LIMIT 1').get() as {
      id: string;
      text: string;
    };
    const blockId = firstBlock.id;
    const witness = firstBlock.text.slice(0, 2);
    // ch01's own corner of the graph: two facts (one invalidated by a change the wipe deletes),
    // an edge between them, a thread opened there and closed past it, an event, a mention and a
    // literal. Everything here is written the way the ledger writes it.
    const fact = (id: string): void => {
      db.prepare(
        `INSERT INTO facts (id, chapter, kind, statement, valid_from_chapter, invalidated_at,
                            invalidated_by_change, created_at, key, sentence, extracted_by)
         VALUES (?, 1, 'state', 'Служебное утверждение первой главы.', 1, NULL, NULL, '2026-10-25T12:00:00Z',
                 '', '', '')`,
      ).run(id);
    };
    fact('fct_ch1_a');
    fact('fct_ch1_b');
    db.prepare("UPDATE facts SET invalidated_by_change = 'chg_one' WHERE id = 'fct_ch1_a'").run();
    db.prepare(
      `INSERT INTO fact_dependency (id, "from", "to", chapter, kind, stance, statement, origin, step_id, rev, at)
       VALUES ('fdp_ch1', 'fct_ch1_a', 'fct_ch1_b', 1, 'cause', 'plain', 'Служебная причина.', 'registered',
               'stp_one', 1, '2026-10-25T12:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO threads (id, label, direction, opened_at_chapter, closed_at_chapter, state, extracted_by)
       VALUES ('thr_ch1', 'служебная линия главы первой', 'forward', 1, 8, 'closed', '')`,
    ).run();
    db.prepare(
      `INSERT INTO thread_events (thread_id, chapter, kind, fact_id, note, at)
       VALUES ('thr_ch1', 1, 'opened', 'fct_ch1_b', NULL, '2026-10-25T12:00:00Z')`,
    ).run();
    // An event of ch01 that names a fact the wipe deletes: the event survives, the pointer goes.
    db.prepare(
      `INSERT INTO thread_events (thread_id, chapter, kind, fact_id, note, at)
       VALUES ('thr_ch1', 1, 'advanced', 'fct_one', NULL, '2026-10-25T12:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO mentions (span_id, block_id, chapter, start, end, kind, fact_id, thread_id, role, witness)
       VALUES ('ch01:kept:0', ?, 1, 0, 2, 'fact', 'fct_ch1_a', NULL, 'assert', ?)`,
    ).run(blockId, witness);
    // A mention of ch08's fact, told in ch01: the fact goes, so the mention cannot stay.
    db.prepare(
      `INSERT INTO mentions (span_id, block_id, chapter, start, end, kind, fact_id, thread_id, role, witness)
       VALUES ('ch01:gone:0', ?, 1, 0, 2, 'fact', 'fct_one', NULL, 'assert', ?)`,
    ).run(blockId, witness);
    db.prepare(
      `INSERT INTO literals (literal, raw, block_id, span_id, chapter, mention_kind, start, end)
       VALUES ('2065-09-14', '14.09.2065', ?, 'ch01:kept:0', 1, 'date', 0, 10)`,
    ).run(blockId);

    const response = await h.call({ dryRun: false });
    expect(response.statusCode).toBe(200);
    expect(db.pragma('foreign_key_check')).toEqual([]);

    // ch01's graph survives, with the pointers into the wiped tables cleared.
    expect(db.prepare('SELECT id FROM facts WHERE chapter = 1 ORDER BY id').all()).toEqual([
      { id: 'fct_ch1_a' },
      { id: 'fct_ch1_b' },
    ]);
    expect(db.prepare("SELECT invalidated_by_change FROM facts WHERE id = 'fct_ch1_a'").get()).toEqual({
      invalidated_by_change: null,
    });
    expect(db.prepare('SELECT id, chapter FROM fact_dependency').all()).toEqual([{ id: 'fdp_ch1', chapter: 1 }]);
    // Closed in a chapter the wipe deletes: the pointer goes and the state cannot stay `closed`
    // without the event that made it — it falls back to `advanced`.
    expect(db.prepare('SELECT id, closed_at_chapter, state FROM threads').all()).toEqual([
      { id: 'thr_ch1', closed_at_chapter: null, state: 'advanced' },
    ]);
    expect(
      db.prepare('SELECT chapter, kind, fact_id FROM thread_events ORDER BY kind').all(),
    ).toEqual([
      { chapter: 1, kind: 'advanced', fact_id: null },
      { chapter: 1, kind: 'opened', fact_id: 'fct_ch1_b' },
    ]);
    expect(db.prepare('SELECT span_id FROM mentions').all()).toEqual([{ span_id: 'ch01:kept:0' }]);
    expect(db.prepare('SELECT literal FROM literals').all()).toEqual([{ literal: '2065-09-14' }]);

    // ch08's graph is gone to the last row: facts, edges, runs, threads, events, mentions,
    // literals — nothing survived because none of it belongs to ch01.
    expect(count(db, 'SELECT COUNT(*) AS n FROM extraction_runs')).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM facts WHERE chapter <> 1")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM fact_dependency WHERE chapter <> 1")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM threads WHERE id = 'thr_one'")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM thread_events WHERE chapter = 8")).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM mentions WHERE chapter = 8')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM literals WHERE chapter = 8')).toBe(0);
  });

  it('keeps the extraction runs a kept ch01 row still names, and their pointers', async () => {
    const target = await h.live();
    const db = target.db;
    // Two runs of a wiped chapter, named only by ch01's own rows: the fact's writer, and the
    // edge's retire. Keeping the run is cheaper than nulling a kept row's provenance.
    db.prepare(
      `INSERT INTO extraction_runs (id, chapter, rev, text_sha, prompt_sha, model, pass, at, status)
       VALUES ('run_two', 8, 1, 'sha-text', 'sha-prompt', 'test-model', 'extract', '2026-10-25T12:00:00Z', 'ok')`,
    ).run();
    db.prepare(
      `INSERT INTO facts (id, chapter, kind, statement, valid_from_chapter, invalidated_at,
                          invalidated_by_change, created_at, key, sentence, extracted_by)
       VALUES ('fct_kept', 1, 'state', 'Служебное утверждение первой главы.', 1, NULL, NULL,
               '2026-10-25T12:00:00Z', '', '', 'run_one')`,
    ).run();
    db.prepare(
      `INSERT INTO facts (id, chapter, kind, statement, valid_from_chapter, invalidated_at,
                          invalidated_by_change, created_at, key, sentence, extracted_by)
       VALUES ('fct_kept_two', 1, 'state', 'Служебное утверждение первой главы, второе.', 1, NULL, NULL,
               '2026-10-25T12:00:00Z', '', '', '')`,
    ).run();
    db.prepare(
      `INSERT INTO fact_dependency (id, "from", "to", chapter, kind, stance, statement, origin, step_id, rev,
                                    retired_by_run, at)
       VALUES ('fdp_kept', 'fct_kept', 'fct_kept_two', 1, 'cause', 'plain', 'Служебная причина.',
               'registered', 'stp_one', 1, 'run_two', '2026-10-25T12:00:00Z')`,
    ).run();

    // The dry run already knows the two runs are not content: the count is what the wipe removes.
    const dry = (await h.call({ dryRun: true })).json();
    expect(dry.tables.find((entry: { key: string }) => entry.key === 'extraction_runs').rows).toBe(0);

    const done = await h.call({ dryRun: false });
    expect(done.statusCode).toBe(200);
    expect(db.prepare('SELECT id FROM extraction_runs ORDER BY id').all()).toEqual([
      { id: 'run_one' },
      { id: 'run_two' },
    ]);
    // The pointers a kept row holds into the runs are untouched — that is why the runs stay.
    expect(db.prepare('SELECT extracted_by FROM facts WHERE id = ?').get('fct_kept')).toEqual({
      extracted_by: 'run_one',
    });
    expect(db.prepare('SELECT retired_by_run FROM fact_dependency WHERE id = ?').get('fdp_kept')).toEqual({
      retired_by_run: 'run_two',
    });
  });

  it('invents no graph for a book whose ch01 had none', async () => {
    const target = await h.live();
    const db = target.db;
    // The fixture's only graph rows are ch08's, so a reset must leave no fact at all.
    expect((await h.call({ dryRun: false })).statusCode).toBe(200);
    expect(count(db, 'SELECT COUNT(*) AS n FROM facts')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM threads')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM extraction_runs')).toBe(0);
    // …and ch01 is still the chapter it was.
    const chapter = db.prepare('SELECT basis, chars FROM chapters WHERE n = 1').get() as { basis: number; chars: number };
    expect(chapter.basis).toBe(0);
    expect(chapter.chars).toBeGreaterThan(0);
  });
});

describe('BOOK-202 — the proof the wipe transaction runs', () => {
  it('refuses a chapter 1 whose rows moved, naming the part and the counts', async () => {
    const target = await h.live();
    const db = target.db;
    const { snapshot: before } = readChapter1(db);
    // What a bug in the wipe would look like: the same chapter, one paragraph rewritten.
    db.prepare("UPDATE blocks SET text = text || ' ' WHERE chapter = 1 AND idx = 0").run();
    expect(() => assertChapter1Kept(db, before)).toThrow(
      /chapter 1 changed during the wipe \(its blocks: \d+\/\d+ blocks/u,
    );
  });

  it('covers ch01’s graph ids, so a wipe that dropped them would roll back', async () => {
    const target = await h.live();
    const db = target.db;
    const { snapshot: before } = readChapter1(db);
    // A fact told in ch01 that was not there when the snapshot was taken: the graph id set moved,
    // which is exactly the difference a bug in the wipe's keep rules would produce.
    db.prepare(
      `INSERT INTO facts (id, chapter, kind, statement, valid_from_chapter, invalidated_at,
                          invalidated_by_change, created_at, key, sentence, extracted_by)
       VALUES ('fct_after', 1, 'state', 'Служебное утверждение.', 1, NULL, NULL,
               '2026-10-25T12:00:00Z', '', '', '')`,
    ).run();
    expect(() => assertChapter1Kept(db, before)).toThrow(/its graph facts/u);
  });

  it('refuses a volume whose absent ch01 came back as anything but the frame', async () => {
    const target = await h.live();
    const db = target.db;
    // No snapshot row: the only thing this run was allowed to write is the basis seed.
    const empty = { facts: [], factDependency: [], threads: [], threadEvents: [], mentions: [], literals: [], extractionRuns: [] };
    const before = {
      chapter: null,
      blocks: [],
      sentences: [],
      revisions: [],
      blockVersions: [],
      blockLineage: [],
      graph: empty,
    };
    expect(() => assertChapter1Kept(db, before)).toThrow(/chapter 1 was not seeded from the frame/u);
  });
});
