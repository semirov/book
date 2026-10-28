/**
 * Fixtures for the span ledger (BOOK-176). Every helper writes the projection the way the ingest
 * would: content-derived block ids, the normalised hash, the canonical chapter sha. A test that
 * seeded a wrong hash would be refused by the applier's own `HASH_MISMATCH` check — correctly,
 * but for the wrong reason — so the seed is exact and the tests speak about behaviour.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { databaseFile, openDatabase, type Db } from '../../src/db/db.ts';
import { migrate } from '../../src/db/migrate.ts';
import { blockId, normalizeForHash } from '../../src/ingest/parseChapter.ts';
import { canonicalChapterText } from '../../src/ledger/patchCheck.ts';
import { sha1Hex, sha256Hex } from '../../src/util/hash.ts';

export const AT = '2026-10-25T12:00:00Z';
export const NOW_MS = Date.parse(AT);

export type LedgerFixture = { db: Db; dataDir: string; close: () => void };

export function ledgerFixture(): LedgerFixture {
  const dataDir = mkdtempSync(join(tmpdir(), 'book-data-'));
  const db = openDatabase(databaseFile(dataDir));
  migrate(db);
  return {
    db,
    dataDir,
    close: () => {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export type SeededBlock = { id: string; text: string; hash: string; uid: string };

export function blockHashOf(text: string): string {
  return sha1Hex(normalizeForHash(text)).slice(0, 8);
}

/**
 * One chapter as the ingest would leave it: a `chapters` row with the canonical sha, chars and
 * block count, one `blocks` row per paragraph, and one `block_versions` `introduced` row each.
 * `versions` may be turned off to shape a projection written before the chain existed.
 */
export function seedChapter(
  db: Db,
  input: { chapter: number; texts: string[]; title?: string | null; rev?: number; at?: string; versions?: boolean },
): SeededBlock[] {
  const title = input.title ?? null;
  const rev = input.rev ?? 1;
  const at = input.at ?? AT;
  const seen = new Map<string, number>();
  const blocks = input.texts.map((text, idx) => {
    const normalised = normalizeForHash(text);
    const duplicate = seen.get(normalised) ?? 0;
    seen.set(normalised, duplicate + 1);
    return {
      id: blockId(input.chapter, normalised, duplicate),
      text,
      hash: blockHashOf(text),
      uid: `bkd_T${String(input.chapter)}_${String(idx)}`,
    };
  });
  db.prepare(
    `INSERT INTO chapters (n, rev, title, sha256, chars, block_count, basis, written_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    input.chapter,
    rev,
    title,
    sha256Hex(canonicalChapterText(title, input.texts)),
    input.texts.reduce((sum, text) => sum + text.length, 0),
    blocks.length,
    at,
    at,
  );
  const insertBlock = db.prepare(
    `INSERT INTO blocks (id, chapter, idx, text, hash, first_rev, last_rev) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  // Version 1 is a checkpoint (ADR-043 D5), so the seed writes its text the way the ingest does.
  const insertVersion = db.prepare(
    `INSERT INTO block_versions
       (block_uid, ver, chapter, rev, hseq, block_id, text_hash, chars, op, prev_ver, replaced_by,
        change_id, step_id, actor_kind, actor_label, identity_id, at, spans, text)
     VALUES (?, 1, ?, ?, 1, ?, ?, ?, 'introduced', NULL, NULL, NULL, NULL, 'unattributed', 'legacy', NULL, ?, '[]', ?)`,
  );
  blocks.forEach((block, idx) => {
    insertBlock.run(block.id, input.chapter, idx, block.text, block.hash, rev, rev);
    if (input.versions !== false) {
      insertVersion.run(block.uid, input.chapter, rev, block.id, block.hash, block.text.length, at, block.text);
    }
  });
  return blocks;
}

/** A change row with every NOT NULL column filled — the cause an invalidation or a mention names. */
export function seedChange(db: Db, input: { id: string; chapter: number; at?: string }): string {
  db.prepare(
    `INSERT INTO changes (id, kind, chapter, intent, base_rev, base_sha256, base_blocks, scope_hint,
                          status, enqueued_at)
     VALUES (?, 'operator', ?, 'служебное намерение', 1, 'sha', '[]', 'phrase', 'done', ?)`,
  ).run(input.id, input.chapter, input.at ?? AT);
  return input.id;
}

export function chapterRev(db: Db, chapter: number): number {
  return (db.prepare('SELECT rev FROM chapters WHERE n = ?').get(chapter) as { rev: number }).rev;
}

/** Every counter an atomicity test watches: a refusal must leave all of them where they were. */
export function ledgerCounts(db: Db, chapter: number): Record<string, number> {
  const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  return {
    chaptersRev: chapterRev(db, chapter),
    blocks: count('SELECT COUNT(*) AS n FROM blocks'),
    versions: count('SELECT COUNT(*) AS n FROM block_versions'),
    events: count('SELECT COUNT(*) AS n FROM events'),
    revisions: count('SELECT COUNT(*) AS n FROM revisions'),
    mentions: count('SELECT COUNT(*) AS n FROM mentions'),
    literals: count('SELECT COUNT(*) AS n FROM literals'),
  };
}
