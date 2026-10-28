import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../../../src/db/db.ts';
import { migrate } from '../../../src/db/migrate.ts';
import { BACKFILL_META_KEY, backfillLedger, draftEdges, MAX_BACKFILL_FACTS } from '../../../src/ledger/graph/backfill.ts';
import { assertedFacts } from '../../../src/ledger/graph/edges.ts';
import { chapterFacts, sentenceSpans } from '../../../src/ledger/graph/proseFacts.ts';
import { AT, seedChapter } from '../helpers.ts';

const AT_FROZEN = '2026-10-28T12:00:00Z';

let db: Db;
let bookRoot: string;

function open(): void {
  db = openDatabase(':memory:');
  migrate(db);
  bookRoot = mkdtempSync(join(tmpdir(), 'book-root-'));
  mkdirSync(join(bookRoot, 'manuscript'), { recursive: true });
}

function writeChapter(n: number, body: string): void {
  writeFileSync(join(bookRoot, 'manuscript', `ch${String(n).padStart(2, '0')}.md`), `Глава.\n\n${body}\n`, 'utf8');
}

function counts(): { facts: number; mentions: number; edges: number } {
  const one = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  return {
    facts: one('SELECT COUNT(*) AS n FROM facts'),
    mentions: one('SELECT COUNT(*) AS n FROM mentions'),
    edges: one('SELECT COUNT(*) AS n FROM edges'),
  };
}

afterEach(() => {
  db.close();
  rmSync(bookRoot, { recursive: true, force: true });
});

describe('backfill — the prose becomes a graph, once', () => {
  it('writes facts, a mention per fact and edges that all resolve, then zero rows on a rerun', () => {
    open();
    seedChapter(db, {
      chapter: 2,
      texts: ['Протокол 14-УП выдан смотрителю смены.', 'Акт 65/11877/арх подшит в дело.'],
      at: AT,
    });
    seedChapter(db, {
      chapter: 5,
      texts: ['Смотритель обещал вернуть акт через 30 дней.'],
      at: AT,
    });
    seedChapter(db, {
      chapter: 12,
      texts: ['Протокол 14-УП процитирован в деле, срок — 30 дней.'],
      at: AT,
    });

    const first = backfillLedger(db, { bookRoot, at: AT_FROZEN });
    expect(first.failed).toEqual([]);
    expect(first.chapters).toEqual([2, 5, 12]);
    expect(first.facts).toBeGreaterThan(0);
    expect(first.edges).toBeGreaterThan(0);
    expect(first.truncated).toBe(false);

    const written = counts();
    expect(written).toEqual({ facts: first.facts, mentions: first.mentions, edges: first.edges });
    // One mention per fact: the witness is what makes «still asserted?» a query.
    expect(written.mentions).toBe(written.facts);
    expect(assertedFacts(db).size).toBe(written.facts);
    // Every edge endpoint is a fact that exists — the ledger is closed.
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM edges e
            WHERE NOT EXISTS (SELECT 1 FROM facts f WHERE f.id = e.from_fact)
               OR NOT EXISTS (SELECT 1 FROM facts f WHERE f.id = e.to_fact)`,
        )
        .get(),
    ).toEqual({ n: 0 });

    // The identity the measurement demanded: a document instance, not a noun bucket.
    const ids = (db.prepare(`SELECT id FROM facts WHERE kind = 'document'`).all() as Array<{ id: string }>).map(
      (row) => row.id,
    );
    expect(ids.some((id) => id.startsWith('f:d:протокол-14-уп@'))).toBe(true);
    expect(ids.some((id) => id.startsWith('f:d:акт-65/11877/арх@'))).toBe(true);

    // The promise in ch05 is a testimony, and it has a candidate payment behind it.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM facts WHERE kind = 'testimony'`).get()).toEqual({ n: 1 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM edges WHERE kind = 'fulfils'`).get()).toEqual({ n: 1 });
    // The same protocol across ch02 and ch12 is one chain, told at the later chapter.
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM edges WHERE kind = 'follows' AND on_component = 'status'`).get(),
    ).toEqual({ n: 1 });

    const second = backfillLedger(db, { bookRoot, at: AT_FROZEN });
    expect({ facts: second.facts, mentions: second.mentions, edges: second.edges }).toEqual({
      facts: 0,
      mentions: 0,
      edges: 0,
    });
    expect(second.failed).toEqual([]);
    expect(second.skipped).toEqual([2, 5, 12]);
    expect(counts()).toEqual(written);
    expect((db.prepare('SELECT v FROM meta WHERE k = ?').get(BACKFILL_META_KEY) as { v: string }).v).toBe(
      JSON.stringify({ '2': 1, '5': 1, '12': 1 }),
    );
  });

  it('reads a chapter that has no projection from its file, and skips the frame and the unreadable', () => {
    open();
    // A chapter row with no blocks and a file on disk: the backfill reads the file, not nothing.
    db.prepare(
      `INSERT INTO chapters (n, rev, title, sha256, chars, block_count, basis, written_at, updated_at)
       VALUES (7, 1, NULL, 'sha', 40, 1, 0, ?, ?)`,
    ).run(AT, AT);
    writeChapter(7, 'Приказ 3-Б подписан оператором смены.');
    // A frame slot: its one sentence is not prose and must not become a fact.
    seedChapter(db, { chapter: 1, texts: ['Замечаний нет.'], at: AT });
    db.prepare('UPDATE chapters SET basis = 1 WHERE n = 1').run();
    // A chapter row whose file does not exist: named, not fatal.
    db.prepare(
      `INSERT INTO chapters (n, rev, title, sha256, chars, block_count, basis, written_at, updated_at)
       VALUES (9, 1, NULL, 'sha', 10, 1, 0, ?, ?)`,
    ).run(AT, AT);

    const result = backfillLedger(db, { bookRoot, at: AT_FROZEN });
    expect(result.chapters).toEqual([7]);
    expect(result.skipped).toEqual([1]);
    expect(result.failed).toEqual([9]);
    expect(result.facts).toBeGreaterThan(0);
    const chapters = db.prepare('SELECT DISTINCT chapter FROM facts').all() as Array<{ chapter: number }>;
    expect(chapters.map((row) => row.chapter)).toEqual([7]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM facts WHERE chapter = 1').get()).toEqual({ n: 0 });
  });
});

describe('backfill — one chapter, one transaction', () => {
  it('rolls a failing chapter back, names it, and lets the others land', () => {
    open();
    seedChapter(db, { chapter: 2, texts: ['Протокол 14-УП выдан смотрителю смены.'], at: AT });
    seedChapter(db, { chapter: 12, texts: ['Протокол 14-УП процитирован в деле.'], at: AT });

    // The write of chapter 12 fails half-way: the facts are inserted, the mentions are not.
    db.exec(
      `CREATE TRIGGER mentions_boom BEFORE INSERT ON mentions
         WHEN new.chapter = 12 BEGIN SELECT RAISE(ABORT, 'mention boom'); END`,
    );
    const first = backfillLedger(db, { bookRoot, at: AT_FROZEN });
    expect(first.failed).toEqual([12]);
    expect(first.chapters).toEqual([2]);
    // Not one row of chapter 12 survived its rolled-back transaction.
    expect(db.prepare('SELECT COUNT(*) AS n FROM facts WHERE chapter = 12').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM mentions WHERE chapter = 12').get()).toEqual({ n: 0 });
    expect(counts().facts).toBeGreaterThan(0);

    // The next run reads it again — the marker never hid a chapter that did not commit.
    db.exec('DROP TRIGGER mentions_boom');
    const second = backfillLedger(db, { bookRoot, at: AT_FROZEN });
    expect(second.failed).toEqual([]);
    expect(second.chapters).toEqual([2, 12]);
    expect((db.prepare('SELECT COUNT(*) AS n FROM facts WHERE chapter = 12').get() as { n: number }).n).toBeGreaterThan(0);
  });
});

describe('backfill — the rules are closed lists, and they are testable alone', () => {
  it('drafts the five measured chain rules with their components', () => {
    open();
    const built = [
      { fact: factOf('f:d:акт-4-у@a', 'document', 2, 'a', { docKey: 'акт-4-у', status: 'выдан' }), chapter: 2, blockId: 'a', pos: 0 },
      { fact: factOf('f:n:30@a#0', 'state', 2, 'a', { numbers: ['30'], entities: ['ковалев'] }), chapter: 2, blockId: 'a', pos: 1 },
      { fact: factOf('f:p:обещал@a', 'testimony', 2, 'a', { marker: 'обещал', numbers: ['30'] }), chapter: 2, blockId: 'a', pos: 2 },
      { fact: factOf('f:d:акт-4-у@b', 'document', 9, 'b', { docKey: 'акт-4-у', status: 'процитирован' }), chapter: 9, blockId: 'b', pos: 3 },
      { fact: factOf('f:n:30@c#0', 'state', 9, 'c', { numbers: ['30'], entities: ['ковалев'] }), chapter: 9, blockId: 'c', pos: 4 },
    ];
    const drafts = draftEdges(built);
    const kinds = drafts.map((draft) => `${draft.from}>${draft.to}:${draft.kind}/${draft.onComponent}`);
    expect(kinds).toContain('f:d:акт-4-у@a>f:d:акт-4-у@b:follows/status');
    expect(kinds).toContain('f:p:обещал@a>f:n:30@c#0:follows/value');
    expect(kinds).toContain('f:n:30@a#0>f:n:30@c#0:references/identity');
    expect(kinds).toContain('f:p:обещал@a>f:n:30@c#0:fulfils/value');
    expect(drafts.every((draft) => draft.from !== draft.to)).toBe(true);
  });

  it('bounds the run at the fact valve and says it truncated', () => {
    open();
    const texts = Array.from({ length: 40 }, (_, i) => `Дело ${String(100 + i)}/12 в архиве.`);
    seedChapter(db, { chapter: 4, texts, at: AT });
    expect(MAX_BACKFILL_FACTS).toBe(5_000);
    const result = backfillLedger(db, { bookRoot, at: AT_FROZEN, maxFacts: 3 });
    expect(result.truncated).toBe(true);
    expect(result.facts).toBe(3);
    expect(db.prepare('SELECT COUNT(*) AS n FROM facts').get()).toEqual({ n: 3 });
    // The chapter is not marked as done, so the next run continues instead of declaring victory.
    expect(result.chapters).toEqual([4]);
  });

  it('reads a removal as an erasure, not as another state', () => {
    open();
    seedChapter(db, { chapter: 8, texts: ['Акт 12-Б уничтожен по акту.'], at: AT });
    backfillLedger(db, { bookRoot, at: AT_FROZEN });
    expect(db.prepare(`SELECT DISTINCT kind FROM facts ORDER BY kind`).all()).toEqual(
      expect.arrayContaining([{ kind: 'erasure' }]),
    );
  });

  it('reads sentences with their code-point spans, so a mention can point at the words', () => {
    expect(sentenceSpans('Первое. Второе — длиннее!')).toEqual([
      { text: 'Первое.', start: 0, end: 7 },
      { text: 'Второе — длиннее!', start: 8, end: 25 },
    ]);
    expect(sentenceSpans('   ')).toEqual([]);
  });

  it('extracts a document instance per chapter, with the last status the chapter gives it', () => {
    const facts = chapterFacts({
      blocks: [{ id: 'ch06#aa', text: 'Протокол 14-УП выдан. Позже протокол 14-УП аннулирован.' }],
      index: { n: 6, written: true, sha256: 'sha', entities: [], promises: [], timeMarkers: [], documents: [] },
    });
    const documents = facts.filter((fact) => fact.kind === 'document');
    expect(documents.map((fact) => ([fact.factId, fact.status] as const))).toEqual([
      ['f:d:протокол-14-уп@ch06#aa', 'аннулирован'],
    ]);
    expect(documents[0]?.term).toBe('протокол 14-УП');
    expect(documents[0]?.statement.length).toBeLessThanOrEqual(160);
  });
});

function factOf(
  factId: string,
  kind: string,
  chapter: number,
  blockId: string,
  extra: { docKey?: string; numbers?: string[]; entities?: string[]; marker?: string; status?: string },
): {
  factId: string;
  blockId: string;
  kind: 'document' | 'state' | 'testimony' | 'decision' | 'erasure';
  statement: string;
  term: string;
  start: number;
  end: number;
  si: number;
  numbers: string[];
  entities: string[];
  docKey?: string;
  marker?: string;
  status?: string;
} {
  void chapter;
  return {
    factId,
    blockId,
    kind: kind as 'document' | 'state' | 'testimony' | 'decision' | 'erasure',
    statement: factId,
    term: factId,
    start: 0,
    end: 1,
    si: 0,
    numbers: extra.numbers ?? [],
    entities: extra.entities ?? [],
    ...(extra.docKey === undefined ? {} : { docKey: extra.docKey }),
    ...(extra.marker === undefined ? {} : { marker: extra.marker }),
    ...(extra.status === undefined ? {} : { status: extra.status }),
  };
}
