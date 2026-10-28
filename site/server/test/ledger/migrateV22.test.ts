import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../../src/db/db.ts';
import { migrate } from '../../src/db/migrate.ts';
import { SCHEMA_VERSION } from '../../src/db/schema.ts';
import { migrateV22 } from '../../src/db/migrateV22.ts';
import { SCHEMA_VERSION } from '../../src/db/schema.ts';
import { searchBlocks } from '../../src/ledger/search.ts';
import { blockHashOf, seedChapter } from './helpers.ts';

/**
 * The v21 shape of `block_versions`, copied literally: the table a real upgrade finds, without
 * `spans`. A migration that only works on a fresh install is the failure this test exists for.
 */
const V21_BLOCK_VERSIONS_SQL = `CREATE TABLE block_versions (
  block_uid   TEXT NOT NULL,
  ver         INTEGER NOT NULL,
  chapter     INTEGER NOT NULL CHECK (chapter BETWEEN 1 AND 67),
  rev         INTEGER NOT NULL,
  hseq        INTEGER NOT NULL,
  block_id    TEXT NOT NULL,
  text_hash   TEXT NOT NULL,
  chars       INTEGER NOT NULL,
  op          TEXT NOT NULL CHECK (op IN ('introduced','revised','kept','erased')),
  prev_ver    INTEGER,
  replaced_by TEXT,
  change_id   TEXT, step_id TEXT,
  actor_kind  TEXT NOT NULL, actor_label TEXT NOT NULL, identity_id TEXT,
  at          TEXT NOT NULL,
  PRIMARY KEY (block_uid, ver)
)`;

/** The v21 indexes, created after the old table is gone (its own indexes die with it). */
const V21_INDEXES_SQL = `CREATE INDEX block_versions_block   ON block_versions(block_id);
CREATE INDEX block_versions_chapter ON block_versions(chapter, rev);
CREATE INDEX block_versions_hseq    ON block_versions(hseq);`;

/** The v21 shape of `chapters`: the same table without the measured gap. */
const V21_CHAPTERS_SQL = `CREATE TABLE chapters (
  n           INTEGER PRIMARY KEY CHECK (n BETWEEN 1 AND 67),
  rev         INTEGER NOT NULL DEFAULT 0,
  title       TEXT,
  sha256      TEXT    NOT NULL,
  chars       INTEGER NOT NULL,
  block_count INTEGER NOT NULL,
  basis       INTEGER NOT NULL DEFAULT 0 CHECK (basis IN (0,1)),
  written_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  parse_error TEXT
)`;

const VERSION_COLUMNS = [
  'block_uid',
  'ver',
  'chapter',
  'rev',
  'hseq',
  'block_id',
  'text_hash',
  'chars',
  'op',
  'prev_ver',
  'replaced_by',
  'change_id',
  'step_id',
  'actor_kind',
  'actor_label',
  'identity_id',
  'at',
] as const;

const AT = '2026-10-24T09:00:00Z';

/** Turn a v22 database into the v21 one an upgrade actually finds. */
function shapeAsV21(db: Db): void {
  for (const trigger of ['facts_no_delete', 'blocks_fts_ai', 'blocks_fts_ad', 'blocks_fts_au']) {
    db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  }
  db.exec('DROP TABLE blocks_fts');
  // Child first: a mention names a fact and a thread, an event names a thread.
  for (const table of ['mentions', 'literals', 'thread_events', 'threads', 'facts']) {
    db.exec(`DROP TABLE ${table}`);
  }
  // Renaming keeps the indexes with the table, so dropping it clears them for the rebuild.
  db.exec('ALTER TABLE block_versions RENAME TO block_versions_pre22');
  db.exec(V21_BLOCK_VERSIONS_SQL);
  const columns = VERSION_COLUMNS.join(', ');
  db.exec(`INSERT INTO block_versions (${columns}) SELECT ${columns} FROM block_versions_pre22`);
  db.exec('DROP TABLE block_versions_pre22');
  db.exec(V21_INDEXES_SQL);
  // v21 knew neither the checkpoint column nor the chapter's measured gap. The cold `chapters`
  // table is rebuilt under a temporary name (the v7 pattern): a DROP COLUMN would have to
  // re-emit a schema whose comments carry commas, which SQLite cannot re-parse.
  db.pragma('foreign_keys = OFF');
  try {
    db.exec(V21_CHAPTERS_SQL.replace('CREATE TABLE chapters', 'CREATE TABLE chapters_pre22'));
    const chapters = 'n, rev, title, sha256, chars, block_count, basis, written_at, updated_at, parse_error';
    db.exec(`INSERT INTO chapters_pre22 (${chapters}) SELECT ${chapters} FROM chapters`);
    db.exec('DROP TABLE chapters');
    db.exec('ALTER TABLE chapters_pre22 RENAME TO chapters');
  } finally {
    db.pragma('foreign_keys = ON');
  }
  db.pragma('user_version = 21');
}

type SpanRow = {
  span_id: string;
  block_id: string;
  block_uid: string;
  from: number;
  to: number;
  insert: string;
  removed: string;
  cause: { kind: string; id: string | null };
  invert: unknown;
};

function latestSpans(db: Db): Array<{ chapter: number; block_id: string | null; ver: number; spans: string }> {
  return db
    .prepare(
      `SELECT v.chapter AS chapter, v.block_id AS block_id, v.ver AS ver, v.spans AS spans
         FROM block_versions v
         JOIN (SELECT block_uid, MAX(ver) AS ver FROM block_versions GROUP BY block_uid) last
           ON last.block_uid = v.block_uid AND last.ver = v.ver
        ORDER BY v.chapter, v.block_id`,
    )
    .all() as Array<{ chapter: number; block_id: string | null; ver: number; spans: string }>;
}

let db: Db;

afterEach(() => {
  db.close();
});

describe('migration v22 — the ledger on an upgraded install', () => {
  it('gives every live block a legacy span, fills the mirror, and stays idempotent', () => {
    db = openDatabase(':memory:');
    migrate(db);
    const texts = ['Первый тестовый абзац: альфа и бета.', 'Второй тестовый абзац: гамма и дельта.'];
    const seeded = seedChapter(db, { chapter: 8, texts, at: AT });
    // A second chapter that carries one fact-shaped token, so the gap is measured, not assumed.
    seedChapter(db, { chapter: 9, texts: ['Акт 14.09.2065 подшит в дело.'], at: AT });
    const withoutVersion = seeded[1];
    if (withoutVersion === undefined) throw new Error('fixture did not seed two blocks');
    // One block has a version row, the other was projected before the chain existed.
    db.prepare('DELETE FROM block_versions WHERE block_id = ?').run(withoutVersion.id);
    shapeAsV21(db);
    expect((db.pragma('table_info(block_versions)') as Array<{ name: string }>).map((c) => c.name)).not.toContain(
      'spans',
    );
    expect((db.pragma('table_info(chapters)') as Array<{ name: string }>).map((c) => c.name)).not.toContain(
      'ledger_gap',
    );

    // The cursor goes to the head of the build, not to 22: v23 (the author marker), v25 (the
    // sentence), v26 (the push tables) and v27 (the disposition chain) run on the same upgrade.
    expect(migrate(db)).toEqual({ from: 21, to: SCHEMA_VERSION });
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(SCHEMA_VERSION);
    expect((db.pragma('table_info(block_versions)') as Array<{ name: string }>).map((c) => c.name)).toEqual(
      expect.arrayContaining(['spans', 'text']),
    );

    const blocks = db.prepare('SELECT id, text FROM blocks ORDER BY chapter, idx').all() as Array<{
      id: string;
      text: string;
    }>;
    expect(blocks).toHaveLength(3);
    const spans = latestSpans(db);
    expect(spans).toHaveLength(3);
    for (const block of blocks) {
      const row = spans.find((entry) => entry.block_id === block.id);
      expect(row).toBeDefined();
      const parsed = JSON.parse(row?.spans ?? '[]') as SpanRow[];
      expect(parsed).toHaveLength(1);
      expect(parsed[0]?.cause).toEqual({ kind: 'legacy', id: null });
      expect(parsed[0]?.insert).toBe(block.text);
      expect(parsed[0]?.removed).toBe('');
      expect(parsed[0]?.invert).toBeNull();
      expect(parsed[0]?.span_id).toBe(`${parsed[0]?.block_uid}:${String(row?.ver)}:0`);
    }
    // The block that had no version is introduced now, as version 1.
    const introduced = db
      .prepare(`SELECT op, ver, hseq, rev, actor_kind, actor_label FROM block_versions WHERE block_id = ?`)
      .get(withoutVersion.id) as { op: string; ver: number; hseq: number; rev: number; actor_kind: string };
    expect(introduced).toMatchObject({ op: 'introduced', ver: 1, rev: 1, actor_kind: 'unattributed' });

    // The mirror was rebuilt from the projection the triggers never saw.
    expect(searchBlocks(db, 'гамма')).toHaveLength(1);
    expect(searchBlocks(db, 'альфа')).toHaveLength(1);

    // ADR-043 D5: the latest live version of every block is the baseline checkpoint, older
    // versions keep ''. ADR-043 D9: every chapter's gap is measured — legacy has no mentions.
    const checkpoints = db
      .prepare('SELECT chapter, block_id, ver, text FROM block_versions WHERE text != \'\' ORDER BY chapter, ver')
      .all() as Array<{ chapter: number; block_id: string; ver: number; text: string }>;
    expect(checkpoints).toHaveLength(3);
    for (const row of checkpoints) {
      const live = db.prepare('SELECT text FROM blocks WHERE id = ?').get(row.block_id) as { text: string };
      expect(row.text).toBe(live.text);
    }
    // ADR-043 D9: the gap is measured at migration — chapter 9 carries one date and no fact
    // mention, chapter 8 carries none.
    const gaps = db.prepare('SELECT n, ledger_gap FROM chapters ORDER BY n').all() as Array<{
      n: number;
      ledger_gap: number;
    }>;
    expect(Object.fromEntries(gaps.map((row) => [row.n, row.ledger_gap]))).toEqual({ 8: 0, 9: 1 });
    // No land happened at migration: no revision, no warning, no log note.
    expect(db.prepare('SELECT COUNT(*) AS n FROM revisions').get()).toEqual({ n: 0 });

    const counts = {
      blocks: db.prepare('SELECT COUNT(*) AS n FROM blocks').get(),
      versions: db.prepare('SELECT COUNT(*) AS n FROM block_versions').get(),
      spans: spans.map((row) => row.spans),
    };
    // Two blocks had a version before the migration (one was deleted to shape the fixture) and
    // the third got its own; nothing else was invented.
    expect(counts.versions).toEqual({ n: 3 });
    expect(db.pragma('foreign_key_check')).toEqual([]);

    // A second boot has nothing to do: no new version, no rewritten span.
    expect(migrate(db)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    expect(db.prepare('SELECT COUNT(*) AS n FROM blocks').get()).toEqual(counts.blocks);
    expect(db.prepare('SELECT COUNT(*) AS n FROM block_versions').get()).toEqual(counts.versions);
    expect(latestSpans(db).map((row) => row.spans)).toEqual(counts.spans);

    // The step itself is idempotent too, for a build that runs it twice.
    expect(() => migrateV22(db)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM block_versions').get()).toEqual(counts.versions);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('keeps a version that already carries spans, and backfills only the empty ones', () => {
    db = openDatabase(':memory:');
    migrate(db);
    const seeded = seedChapter(db, { chapter: 8, texts: ['Третий тестовый абзац: эпсилон.'] });
    const block = seeded[0];
    if (block === undefined) throw new Error('fixture did not seed a block');
    const written = JSON.stringify([
      {
        span_id: `${block.uid}:1:0`,
        block_id: block.id,
        block_uid: block.uid,
        from: 0,
        to: 0,
        insert: block.text,
        removed: '',
        cause: { kind: 'change', id: 'chg_one' },
        at: AT,
        invert: null,
      },
    ]);
    db.prepare('UPDATE block_versions SET spans = ? WHERE block_id = ?').run(written, block.id);

    migrateV22(db);

    expect(db.prepare('SELECT spans FROM block_versions WHERE block_id = ?').get(block.id)).toEqual({ spans: written });
    expect(db.prepare('SELECT COUNT(*) AS n FROM block_versions').get()).toEqual({ n: 1 });
    // The block hash is the projection's own, so a legacy row still describes the text it stands for.
    expect(blockHashOf(block.text)).toBe(block.hash);
  });
});
