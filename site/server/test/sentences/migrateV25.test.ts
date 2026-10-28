/**
 * v25 on a database an upgrade actually finds (ADR-044 §5).
 *
 * The fixture is built the way the other migration tests build theirs: migrate a fresh database,
 * then shape it back into the previous version — no sentence tables, no carrier columns — and only
 * then seed prose and filings. A migration tested only on a fresh install proves nothing, and the
 * failure this test exists for is «it worked because the columns were already there».
 */

import { SEGMENTER_VERSION, splitSentences } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../../src/db/db.ts';
import { migrate } from '../../src/db/migrate.ts';
import { migrateV25 } from '../../src/db/migrateV25.ts';
import { SCHEMA_VERSION } from '../../src/db/schema.ts';
import { sentenceHash } from '../../src/sentences/hash.ts';
import { seedChapter } from '../ledger/helpers.ts';

/** ch12: a quoted notice — two full stops inside «…» that are not boundaries. */
const CH12 = [
  'Утром в щели под дверью лежал сложенный лист. В нём было написано: «Явиться в стол находок, дело № 44/17. При себе иметь документ. Кабинет 7». Почерк был чужой.',
  'Он перечитал записку дважды. Ничего не изменилось.',
];

/** ch08: a letter quoted in one paragraph, then a plain line. */
const CH08 = [
  'В конверте лежало письмо. «Уважаемый заявитель! Ваше обращение зарегистрировано под номером 65/11877.» Больше в конверте ничего не было.',
  'Номер 65/11877 ничего ему не говорил.',
];

const AT = '2026-10-28T09:00:00Z';

function columns(db: Db, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name);
}

/** Turn a v25 database into the v24 one an upgrade finds: no sentence notion anywhere. */
function shapeAsV24(db: Db): void {
  db.exec('DROP TABLE sentence_touches');
  db.exec('DROP TABLE sentences');
  for (const column of ['sel_end', 'sel_start', 'sentence_id']) {
    db.exec(`ALTER TABLE comments DROP COLUMN ${column}`);
  }
  for (const table of ['facts', 'literals', 'mentions']) {
    db.exec(`ALTER TABLE ${table} DROP COLUMN sentence_id`);
  }
  db.exec(`DELETE FROM meta WHERE k LIKE 'sentences.%'`);
  db.pragma('user_version = 24');
}

function seedV24(db: Db): void {
  db.prepare(
    `INSERT INTO identities (id, yandex_sub, display_name, created_at, last_seen_at)
     VALUES ('idt_1', 'yandex-1', 'Аня', ?, ?)`,
  ).run(AT, AT);
  const ch12 = seedChapter(db, { chapter: 12, texts: CH12, title: 'Записка', at: AT });
  seedChapter(db, { chapter: 8, texts: CH08, title: 'Письмо', at: AT });
  // A legacy filing: no sentence columns exist yet, exactly as it was stored before v25.
  const insert = db.prepare(
    `INSERT INTO comments (id, identity_id, chapter, block_id, block_idx, base_rev, quote, prefix, suffix,
                           author, body, body_sha, ip_hash, status, created_at)
     VALUES (?, 'idt_1', ?, ?, ?, 1, ?, ?, ?, 'Аня', 'почему так?', 'sha', 'iph', 'new', ?)`,
  );
  // Inside one sentence: the last sentence of the first ch12 block.
  insert.run('cmt_inside', 12, ch12[0]?.id ?? null, 0, 'Почерк был чужой.', null, null, AT);
  // Straddles a boundary: the end of sentence 1 and the start of sentence 2.
  insert.run('cmt_straddle', 12, ch12[0]?.id ?? null, 0, 'лист. В нём', null, null, AT);
  // A filing with no quote at all, and a chapter-level one: neither is counted or guessed.
  insert.run('cmt_noquote', 12, ch12[1]?.id ?? null, 1, null, null, null, AT);
  db.prepare(
    `INSERT INTO comments (id, identity_id, chapter, block_id, block_idx, base_rev, quote, prefix, suffix,
                           author, body, body_sha, ip_hash, status, created_at)
     VALUES ('cmt_chapter', 'idt_1', 8, NULL, NULL, 1, NULL, NULL, NULL, 'Аня', 'о главе', 'sha2', 'iph', 'new', ?)`,
  ).run(AT);
}

function v24Database(): Db {
  const db = openDatabase(':memory:');
  migrate(db);
  shapeAsV24(db);
  seedV24(db);
  return db;
}

function count(db: Db, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

describe('migrate v25 — the sentence becomes a stored row', () => {
  it('segments every live block once, keeps spans lossless and invents nothing', () => {
    const db = v24Database();
    expect(columns(db, 'comments')).not.toContain('sentence_id');

    expect(migrate(db)).toEqual({ from: 24, to: SCHEMA_VERSION });
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(SCHEMA_VERSION);

    const blocks = db.prepare('SELECT id, text FROM blocks ORDER BY chapter, idx').all() as Array<{
      id: string;
      text: string;
    }>;
    const expected = blocks.reduce((sum, block) => sum + splitSentences(block.text).length, 0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM sentences')).toBe(expected);
    expect(expected).toBeGreaterThan(0);

    // Every row says which rule set cut it, and its hash is the content attribute of its own span.
    const rows = db.prepare('SELECT * FROM sentences ORDER BY block_id, idx').all() as Array<{
      block_id: string;
      idx: number;
      start: number;
      end: number;
      text_hash: string;
      seg_version: number;
      split_from: string | null;
      merged_into: string | null;
      erased_at: string | null;
    }>;
    for (const row of rows) {
      expect(row.seg_version).toBe(SEGMENTER_VERSION);
      expect(row.end).toBeGreaterThan(row.start);
      expect(row.split_from).toBeNull();
      expect(row.merged_into).toBeNull();
      expect(row.erased_at).toBeNull();
    }

    for (const block of blocks) {
      const spans = rows.filter((row) => row.block_id === block.id);
      const characters = Array.from(block.text);
      // Spans are the segmenter's own output, in order, and the gaps between them are whitespace:
      // together they reconstruct the block byte for byte (ADR-044 §3.1).
      expect(spans.map((span) => ({ start: span.start, end: span.end }))).toEqual(
        splitSentences(block.text).map((span) => ({ start: span.start, end: span.end })),
      );
      let cursor = 0;
      for (const span of spans) {
        expect(characters.slice(cursor, span.start).join('')).toMatch(/^\s*$/u);
        const text = characters.slice(span.start, span.end).join('');
        expect(text.trim()).toBe(text);
        expect(span.text_hash).toBe(sentenceHash(text));
        cursor = span.end;
      }
      expect(characters.slice(cursor).join('')).toMatch(/^\s*$/u);
    }

    // Nothing is fabricated: an imported sentence has no known edit, no fact, no literal, no mention.
    expect(count(db, 'SELECT COUNT(*) AS n FROM sentence_touches')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM facts')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM literals')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM mentions')).toBe(0);

    // `edges` belongs to ADR-041: v25 adds a column to it if it is there, and never creates it.
    expect(columns(db, 'edges')).toEqual([]);
    const meta = Object.fromEntries(
      db.prepare(`SELECT k, v FROM meta WHERE k LIKE 'sentences.%'`).all().map((row) => {
        const entry = row as { k: string; v: string };
        return [entry.k, entry.v];
      }),
    ) as Record<string, string>;
    expect(meta['sentences.segmenter']).toBe(String(SEGMENTER_VERSION));
    expect(Date.parse(meta['sentences.migrated_at'] ?? '')).not.toBeNaN();
    db.close();
  });

  it('re-anchors a filing inside one sentence and leaves a straddling quote null', () => {
    const db = v24Database();
    migrate(db);

    const row = (id: string): { sentence_id: string | null; sel_start: number | null; sel_end: number | null } =>
      db.prepare('SELECT sentence_id, sel_start, sel_end FROM comments WHERE id = ?').get(id) as {
        sentence_id: string | null;
        sel_start: number | null;
        sel_end: number | null;
      };

    const block = db
      .prepare('SELECT b.id, b.text FROM blocks b JOIN comments c ON c.block_id = b.id WHERE c.id = ?')
      .get('cmt_inside') as { id: string; text: string };
    const inside = row('cmt_inside');
    expect(inside.sentence_id).not.toBeNull();
    const sentence = db
      .prepare('SELECT start, end FROM sentences WHERE id = ?')
      .get(inside.sentence_id) as { start: number; end: number };
    // The stored offsets point at the quote inside the stored sentence, in code points.
    const characters = Array.from(block.text);
    expect(
      characters.slice(sentence.start + (inside.sel_start ?? -1), sentence.start + (inside.sel_end ?? -1)).join(''),
    ).toBe('Почерк был чужой.');
    expect(inside.sel_end! - inside.sel_start!).toBe('Почерк был чужой.'.length);

    // A quote that crosses a boundary keeps its block anchor: no id, no offsets, never a guess.
    expect(row('cmt_straddle')).toEqual({ sentence_id: null, sel_start: null, sel_end: null });
    // A filing with no quote is not touched at all — nothing about it changed.
    expect(row('cmt_noquote')).toEqual({ sentence_id: null, sel_start: null, sel_end: null });
    expect(row('cmt_chapter')).toEqual({ sentence_id: null, sel_start: null, sel_end: null });

    const published = JSON.parse(
      (db.prepare(`SELECT v FROM meta WHERE k = 'sentences.comment_reanchor'`).get() as { v: string }).v,
    ) as { total: number; anchored: number; null: number };
    // Only the two rows with a block AND a quote are in scope; one of them anchored, one did not.
    expect(published).toEqual({ total: 2, anchored: 1, null: 1 });
    db.close();
  });

  it('adds the carrier to an `edges` table a later ADR has created, and never makes one', () => {
    const db = v24Database();
    db.exec('CREATE TABLE edges (id TEXT PRIMARY KEY)');
    migrate(db);
    expect(columns(db, 'edges')).toEqual(['id', 'sentence_id']);
    db.close();
  });

  it('does not re-segment a block that already has rows when the step itself runs twice', () => {
    const db = v24Database();
    migrateV25(db);
    const before = db.prepare('SELECT id, block_id, idx, start FROM sentences ORDER BY block_id, idx').all();
    expect(before.length).toBeGreaterThan(0);
    migrateV25(db);
    expect(db.prepare('SELECT id, block_id, idx, start FROM sentences ORDER BY block_id, idx').all()).toEqual(before);
    expect(count(db, 'SELECT COUNT(*) AS n FROM sentence_touches')).toBe(0);
    db.close();
  });

  it('is a no-op on a second run: same counts, no duplicate ids', () => {
    const db = v24Database();
    migrate(db);
    const before = {
      sentences: count(db, 'SELECT COUNT(*) AS n FROM sentences'),
      distinct: count(db, 'SELECT COUNT(DISTINCT id) AS n FROM sentences'),
      touches: count(db, 'SELECT COUNT(*) AS n FROM sentence_touches'),
      migratedAt: (db.prepare(`SELECT v FROM meta WHERE k = 'sentences.migrated_at'`).get() as { v: string }).v,
    };

    expect(migrate(db)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    expect(count(db, 'SELECT COUNT(*) AS n FROM sentences')).toBe(before.sentences);
    expect(count(db, 'SELECT COUNT(DISTINCT id) AS n FROM sentences')).toBe(before.distinct);
    expect(count(db, 'SELECT COUNT(*) AS n FROM sentence_touches')).toBe(before.touches);
    // The moment of the import is a fact about the first run, not about the last.
    expect((db.prepare(`SELECT v FROM meta WHERE k = 'sentences.migrated_at'`).get() as { v: string }).v).toBe(
      before.migratedAt,
    );
    db.close();
  });
});
