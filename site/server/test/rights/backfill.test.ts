/**
 * The backfill Gate B needs (BOOK-61 review B3).
 *
 * A filing posted before v14 carries no rights verdict, and every gate behind it reads `NULL`
 * as "no answer", so the row would wait forever. `migrate` asks the same deterministic question
 * once: a refusing rule rejects a `new` row with the fixed sentence, records the verdict on a
 * `batched` row and leaves its status to triage (B1's status rule), and a clean row is `CLEAR`.
 *
 * The install is shaped as v14 (main's head) here — the eight columns dropped, `rights_scan`
 * dropped — so the test walks the upgrade path the deploy actually takes, not a re-run on an
 * already-migrated database. A second boot must cost nothing: the `meta` mark makes it one-time.
 */

import { describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/db.ts';
import { migrate } from '../../src/db/migrate.ts';
import { SCHEMA_VERSION } from '../../src/db/schema.ts';
import { RIGHTS_COPY } from '../../src/rights/rules.ts';

const RIGHTS_COLUMNS = [
  'held_rule',
  'held_by',
  'held_at',
  'rights_verdict',
  'rights_rule',
  'rights_at',
  'rights_by',
  'rights_source',
];

const PERSON = 'Добавь в главу сцену, где Владимир Путин подписывает акт.';
const CLEAN = 'В абзаце дважды «слово» — оставить одно упоминание.';

type Row = {
  id: string;
  status: string;
  reason: string | null;
  decided_at: string | null;
  rights_verdict: string | null;
  rights_rule: string | null;
  rights_source: string | null;
};

function row(db: ReturnType<typeof openDatabase>, id: string): Row {
  return db
    .prepare('SELECT id, status, reason, decided_at, rights_verdict, rights_rule, rights_source FROM comments WHERE id = ?')
    .get(id) as Row;
}

describe('migrate — the one rights backfill', () => {
  it('scans the undecided rows of a v13 install, honours the status rule, and runs once', () => {
    const db = openDatabase(':memory:');
    migrate(db);

    db.prepare(
      `INSERT INTO identities (id, yandex_sub, display_name, created_at, last_seen_at)
       VALUES ('idn_1', 'yandex-1', 'Аня', '2026-10-25T11:00:00Z', '2026-10-25T11:00:00Z')`,
    ).run();
    const insert = db.prepare(
      `INSERT INTO comments (id, identity_id, chapter, author, body, body_sha, ip_hash, status, created_at)
       VALUES (?, 'idn_1', 8, 'Аня', ?, ?, 'f', ?, '2026-10-25T12:00:00Z')`,
    );
    insert.run('cmt_new_person', PERSON, 'a', 'new');
    insert.run('cmt_batched_person', PERSON, 'b', 'batched');
    insert.run('cmt_new_clean', CLEAN, 'c', 'new');
    // A row A already held, and a decided one: neither is the backfill's business.
    insert.run('cmt_held', PERSON, 'd', 'quarantined');
    insert.run('cmt_done', CLEAN, 'e', 'accepted');

    // The shape of a v13 install: no Gate A/B columns, no rights scan, no backfill mark.
    for (const column of RIGHTS_COLUMNS) db.exec(`ALTER TABLE comments DROP COLUMN ${column}`);
    db.exec('ALTER TABLE steps DROP COLUMN rights_scan');
    db.exec(`DELETE FROM meta WHERE k = 'rights.backfill'`);
    db.pragma('user_version = 14');

    // BOOK-61 is v15; BOOK-137 (v16) lands on the way to the head version.
    expect(migrate(db)).toEqual({ from: 14, to: SCHEMA_VERSION });

    // A `new` row the scan refuses is rejected with B's fixed sentence, in the same act.
    expect(row(db, 'cmt_new_person')).toMatchObject({
      status: 'rejected',
      reason: RIGHTS_COPY.person,
      rights_verdict: 'REFUSED',
      rights_rule: 'STOP-PERSON',
      rights_source: 'scan',
    });
    expect(row(db, 'cmt_new_person').decided_at).not.toBeNull();

    // A `batched` row records the verdict and keeps its place in triage — no gate has spoken.
    expect(row(db, 'cmt_batched_person')).toMatchObject({
      status: 'batched',
      reason: null,
      decided_at: null,
      rights_verdict: 'REFUSED',
      rights_rule: 'STOP-PERSON',
    });

    // A clean filing is cleared, and the rows outside the pass are left alone.
    expect(row(db, 'cmt_new_clean')).toMatchObject({
      status: 'new',
      rights_verdict: 'CLEAR',
      rights_source: 'scan',
    });
    expect(row(db, 'cmt_held').rights_verdict).toBeNull();
    expect(row(db, 'cmt_done').rights_verdict).toBeNull();

    // One-time: the mark is set, and a second boot writes no new rights event.
    const events = (): number =>
      (db.prepare(`SELECT COUNT(*) AS n FROM comment_events WHERE type = 'rights'`).get() as { n: number }).n;
    const after = events();
    expect(after).toBeGreaterThan(0);
    migrate(db);
    expect(events()).toBe(after);
  });
});
